/**
 * 高级模型配置：不可变 revision + 只写凭证 + 分项验证 + CAS 激活。
 *
 * ## 三条不可协商的规则
 *
 * 1. **revision 不可变**。每次修改产生新 revision，旧的不删不改。这样「三天前
 *    用哪套配置跑的那次任务」永远可复现，回退也不需要「撤销」，只需激活旧 revision。
 * 2. **凭证只写不读**。请求里带 `credential` 明文，服务端立刻换成随机引用
 *    （`credential_ref`），明文只在进程内存里活一次，**永不入库、永不回显**。
 *    读接口只回答 `credential_set: true/false`。
 * 3. **验证会失效**。验证结论绑定 `config_fingerprint`（配置内容 + 适配器版本 +
 *    Harness 版本）。任一项变化，旧结论自动变 `stale`，不能用来激活。
 *    `HTTP 200` 或「能列出模型」都不等于「可用于 Agent」。
 *
 * ## 首版只允许 local_only
 *
 * `data_boundary` 只接受 `local_only`。云端模型要先单独做数据边界决策，
 * 不是加个枚举值就能开的——所以这里明确拒绝，并在错误里说明原因。
 */
import crypto from 'node:crypto';
import { Store, nowIso, compactJson, loadJson } from './store.ts';
import type { Tx } from './store.ts';
import type { EventLog } from './events.ts';
import { ApiError } from './http.ts';
import { newId } from './runs.ts';

/** 适配器版本：改动请求/响应映射逻辑时递增，让旧验证失效。 */
export const ADAPTER_VERSION = 'openai-compatible/1';

export const PROVIDERS = ['openai_compatible'] as const;
export const DATA_BOUNDARIES = ['local_only'] as const;
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

export type CheckId = 'connect' | 'auth' | 'model_exists' | 'streaming' | 'tool_call' | 'cancel' | 'harness_bridge';

export const CHECK_LABELS: Record<CheckId, string> = {
  connect: '网络连接',
  auth: '凭证认证',
  model_exists: '模型存在',
  streaming: '流式输出',
  tool_call: '工具调用',
  cancel: '请求取消',
  harness_bridge: 'Harness 接入',
};

/** 必需项：缺一项就不是「可用于 Agent」。 */
const REQUIRED_CHECKS: CheckId[] = ['connect', 'auth', 'model_exists', 'streaming', 'tool_call', 'harness_bridge'];

export interface ProfileDraft {
  name: string;
  provider: string;
  endpoint: string;
  model: string;
  credential?: string;
  reasoning_effort?: string;
  max_output_tokens?: number;
  temperature?: number;
  request_timeout_ms?: number;
  budget_tokens?: number | null;
  data_boundary?: string;
}

export interface ValidationSummary {
  verdict: 'compatible' | 'incompatible' | 'not_run' | 'stale';
  checked_at: string;
  adapter_version: string;
  harness_version: string;
  config_fingerprint: string;
}

export interface CheckResult {
  id: CheckId;
  label: string;
  state: 'pass' | 'fail' | 'skip' | 'warn';
  detail: string | null;
  duration_ms: number;
  required: boolean;
}

interface ProfileRow {
  profile_id: string;
  name: string;
  latest_revision: number;
  active_revision: number | null;
  created_at: string;
  updated_at: string;
}

interface RevisionRow {
  profile_id: string;
  revision: number;
  payload_json: string;
  credential_ref: string | null;
  validation_json: string | null;
  config_fingerprint: string | null;
  created_at: string;
}

/**
 * 凭证引用表：内存 only。
 *
 * 为什么不进 SQLite：SQLite 文件会被备份、被复制、被 `.dump` 导出。
 * 首版把明文放在进程内存，进程重启后需要重新输入凭证——这是**有意的取舍**：
 * 「重启后要重填」比「凭证躺在磁盘上」安全得多。UI 要如实显示 `credential_set: false`。
 */
class CredentialVault {
  private secrets = new Map<string, string>();

  put(secret: string): string {
    const ref = `cred-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.secrets.set(ref, secret);
    return ref;
  }

  get(ref: string | null): string | null {
    if (!ref) return null;
    return this.secrets.get(ref) ?? null;
  }

  has(ref: string | null): boolean {
    return Boolean(ref && this.secrets.has(ref));
  }
}

/** 配置指纹：内容 + 适配器 + Harness 三者任一变化都必须让验证失效。 */
export function fingerprintConfig(payload: Record<string, unknown>, credentialRef: string | null): string {
  const material = JSON.stringify({
    payload: sortedEntries(payload),
    credential_ref: credentialRef,
    adapter: ADAPTER_VERSION,
  });
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}

function sortedEntries(obj: Record<string, unknown>): Array<[string, unknown]> {
  return Object.keys(obj)
    .sort()
    .map((k) => [k, obj[k]]);
}

/** endpoint 校验：必须是 http(s)、不含内嵌凭证、不许裸主机名带路径穿越。 */
export function validateEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ApiError('E_VALIDATION', 'endpoint 必须是完整 URL（含 http:// 或 https://）', {
      details: { field: 'endpoint' },
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError('E_VALIDATION', `endpoint 只支持 http/https（收到 ${url.protocol}）`, {
      details: { field: 'endpoint' },
    });
  }
  // 凭证不得内嵌在 URL 里：它会被日志、会被历史记录、会被截图
  if (url.username || url.password) {
    throw new ApiError('E_VALIDATION', 'endpoint 不得内嵌用户名或密码，凭证请单独填写', {
      details: { field: 'endpoint' },
      hint: '把 ?key=... 或 user:pass@ 从 URL 里去掉，填到凭证字段',
    });
  }
}

export interface ModelServiceOptions {
  store: Store;
  events: EventLog;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  harnessVersion: () => string | null;
  onEvent?: (seq: number) => void;
}

export class ModelService {
  private store: Store;
  private events: EventLog;
  private log: (msg: string, extra?: Record<string, unknown>) => void;
  private harnessVersion: () => string | null;
  private onEvent: ((seq: number) => void) | undefined;
  private vault = new CredentialVault();

  constructor(opts: ModelServiceOptions) {
    this.store = opts.store;
    this.events = opts.events;
    this.log = opts.log;
    this.harnessVersion = opts.harnessVersion;
    this.onEvent = opts.onEvent;
  }

  private notify(seq: number): void {
    if (this.onEvent && seq >= 0) {
      try {
        this.onEvent(seq);
      } catch (e: any) {
        this.log('event notify failed', { error: e.message });
      }
    }
  }

  // ---------------------------------------------------------------- 读
  list(): Record<string, unknown> {
    const rows = this.store.all<ProfileRow>('SELECT * FROM model_profiles ORDER BY created_at ASC');
    const activeId = this.activeProfileId();
    return {
      ok: true,
      profiles: rows.map((r) => this.profileView(r)),
      active_profile_id: activeId,
      // 首版不开放外部模型：这不是「暂时没配」，而是产品边界
      external_model_open: false,
    };
  }

  get(profileId: string): Record<string, unknown> {
    const profile = this.requireProfile(profileId);
    const revisions = this.store.all<RevisionRow>(
      'SELECT * FROM model_revisions WHERE profile_id = ? ORDER BY revision DESC',
      profileId,
    );
    return {
      ok: true,
      profile: this.profileView(profile),
      revisions: revisions.map((r) => this.revisionView(profileId, r)),
    };
  }

  private requireProfile(profileId: string): ProfileRow {
    const row = this.store.one<ProfileRow>('SELECT * FROM model_profiles WHERE profile_id = ?', profileId);
    if (!row) throw new ApiError('E_NOT_FOUND', `模型配置不存在：${profileId}`);
    return row;
  }

  private activeProfileId(): string | null {
    const active = this.store.getMeta('model.active_profile_id');
    return active && active.length > 0 ? active : null;
  }

  activeRevision(): { profile_id: string; revision: number; payload: Record<string, any> } | null {
    const pid = this.activeProfileId();
    if (!pid) return null;
    const profile = this.store.one<ProfileRow>('SELECT * FROM model_profiles WHERE profile_id = ?', pid);
    if (!profile || profile.active_revision === null) return null;
    const rev = this.store.one<RevisionRow>(
      'SELECT * FROM model_revisions WHERE profile_id = ? AND revision = ?',
      pid,
      profile.active_revision,
    );
    if (!rev) return null;
    return { profile_id: pid, revision: rev.revision, payload: loadJson<any>(rev.payload_json, {}) };
  }

  private profileView(row: ProfileRow): Record<string, unknown> {
    const activeId = this.activeProfileId();
    return {
      profile_id: row.profile_id,
      name: row.name,
      latest_revision: row.latest_revision,
      active: activeId === row.profile_id,
      active_revision: row.active_revision,
      updated_at: row.updated_at,
    };
  }

  private revisionView(profileId: string, row: RevisionRow): Record<string, unknown> {
    const payload = loadJson<Record<string, any>>(row.payload_json, {});
    const stored = loadJson<ValidationSummary | null>(row.validation_json, null);
    return {
      revision: row.revision,
      name: payload.name ?? '',
      provider: payload.provider ?? '',
      endpoint: payload.endpoint ?? '',
      model: payload.model ?? '',
      // 只报「已设置/未设置」。明文永远不回显，也不在库里。
      credential_set: this.vault.has(row.credential_ref),
      reasoning_effort: payload.reasoning_effort ?? null,
      max_output_tokens: payload.max_output_tokens ?? null,
      temperature: payload.temperature ?? null,
      request_timeout_ms: payload.request_timeout_ms ?? null,
      budget_tokens: payload.budget_tokens ?? null,
      data_boundary: payload.data_boundary ?? 'local_only',
      created_at: row.created_at,
      validation: stored ? this.effectiveValidation(stored, row) : null,
    };
  }

  /**
   * 验证是否仍然有效。
   *
   * 不只看「上次是不是 compatible」，还要核对指纹与 Harness 版本——
   * 换了 Harness 或改了配置，旧结论就不可信了。
   */
  private effectiveValidation(stored: ValidationSummary, row: RevisionRow): ValidationSummary {
    const currentFp = row.config_fingerprint ?? '';
    const currentHarness = this.harnessVersion();
    if (stored.verdict === 'compatible') {
      if (stored.config_fingerprint !== currentFp) {
        return { ...stored, verdict: 'stale' };
      }
      if (stored.harness_version !== (currentHarness ?? stored.harness_version)) {
        return { ...stored, verdict: 'stale' };
      }
      if (stored.adapter_version !== ADAPTER_VERSION) {
        return { ...stored, verdict: 'stale' };
      }
    }
    return stored;
  }

  // ---------------------------------------------------------------- 写
  create(draft: ProfileDraft): Record<string, unknown> {
    this.store.requireWritable();
    const normalized = this.normalizeDraft(draft);
    const pid = newId('prof');
    const ts = nowIso();
    const ref = normalized.credential ? this.vault.put(normalized.credential) : null;
    const payload = normalized.payload;
    const fp = fingerprintConfig(payload, ref);

    this.store.transaction((tx) => {
      tx.run(
        `INSERT INTO model_profiles(profile_id, name, latest_revision, active_revision, created_at, updated_at)
         VALUES(?,?,?,?,?,?)`,
        pid,
        payload.name,
        1,
        null,
        ts,
        ts,
      );
      tx.run(
        `INSERT INTO model_revisions(profile_id, revision, payload_json, credential_ref, validation_json,
           config_fingerprint, created_at)
         VALUES(?,?,?,?,?,?,?)`,
        pid,
        1,
        compactJson(payload),
        ref,
        null,
        fp,
        ts,
      );
    });
    this.log('model profile created', { profile_id: pid, credential_set: Boolean(ref) });
    return this.get(pid);
  }

  /**
   * 修改 = 产生新 revision。
   *
   * `base_revision` 做 CAS：客户端看到的是 revision 3，提交时库里已经是 4，
   * 就返回 409 而不是把别人的改动冲掉。
   */
  update(profileId: string, body: Record<string, unknown>): Record<string, unknown> {
    this.store.requireWritable();
    const profile = this.requireProfile(profileId);
    const base = body.base_revision;
    if (typeof base !== 'number' || !Number.isInteger(base)) {
      throw new ApiError('E_VALIDATION', 'base_revision 必填且必须是整数', {
        details: { field: 'base_revision' },
      });
    }
    if (base !== profile.latest_revision) {
      throw new ApiError('E_CONFLICT', `版本冲突：你基于 v${base}，当前已是 v${profile.latest_revision}`, {
        details: { expected: base, actual: profile.latest_revision },
        hint: '刷新后重新编辑；历史 revision 不会被覆盖',
      });
    }
    const latest = this.store.one<RevisionRow>(
      'SELECT * FROM model_revisions WHERE profile_id = ? AND revision = ?',
      profileId,
      profile.latest_revision,
    )!;
    const current = loadJson<Record<string, any>>(latest.payload_json, {});

    // 取消凭证
    let ref = latest.credential_ref;
    if (body.clear_credential === true) {
      ref = null;
    }
    if (typeof body.credential === 'string' && body.credential.length > 0) {
      ref = this.vault.put(body.credential);
    }

    const merged = {
      ...current,
      name: body.name !== undefined ? body.name : current.name,
      provider: body.provider !== undefined ? body.provider : current.provider,
      endpoint: body.endpoint !== undefined ? body.endpoint : current.endpoint,
      model: body.model !== undefined ? body.model : current.model,
      reasoning_effort: body.reasoning_effort !== undefined ? body.reasoning_effort : current.reasoning_effort,
      max_output_tokens: body.max_output_tokens !== undefined ? body.max_output_tokens : current.max_output_tokens,
      temperature: body.temperature !== undefined ? body.temperature : current.temperature,
      request_timeout_ms:
        body.request_timeout_ms !== undefined ? body.request_timeout_ms : current.request_timeout_ms,
      budget_tokens: body.budget_tokens !== undefined ? body.budget_tokens : current.budget_tokens,
      data_boundary: body.data_boundary !== undefined ? body.data_boundary : current.data_boundary,
    };
    const normalized = this.normalizeDraft(merged as ProfileDraft);
    const payload = normalized.payload;
    const nextRev = profile.latest_revision + 1;
    const fp = fingerprintConfig(payload, ref);
    const ts = nowIso();

    this.store.transaction((tx) => {
      tx.run(
        `INSERT INTO model_revisions(profile_id, revision, payload_json, credential_ref, validation_json,
           config_fingerprint, created_at)
         VALUES(?,?,?,?,?,?,?)`,
        profileId,
        nextRev,
        compactJson(payload),
        ref,
        null,
        fp,
        ts,
      );
      tx.run(
        'UPDATE model_profiles SET name = ?, latest_revision = ?, updated_at = ? WHERE profile_id = ?',
        payload.name,
        nextRev,
        ts,
        profileId,
      );
    });
    this.log('model profile revision created', { profile_id: profileId, revision: nextRev });
    return this.get(profileId);
  }

  // ---------------------------------------------------------------- 验证
  /**
   * 分项探测。
   *
   * 关键设计：探测**不发送任何用户数据**，只用一个固定的最小 fixture 问三件事——
   * 能不能连上、凭证对不对、这个模型名存不存在，以及它是否支持流式与工具调用。
   * 探测结果落在这个 revision 上，不影响其他 revision，也不自动激活。
   *
   * 首版没有接真实 Harness 二进制时，`harness_bridge` 会诚实报 `fail` 并说明
   * 「Harness 未就绪」，而不是假装通过。
   */
  async validate(profileId: string, revisionInput: number | null): Promise<Record<string, unknown>> {
    this.store.requireWritable();
    const profile = this.requireProfile(profileId);
    const revision = revisionInput ?? profile.latest_revision;
    const row = this.store.one<RevisionRow>(
      'SELECT * FROM model_revisions WHERE profile_id = ? AND revision = ?',
      profileId,
      revision,
    );
    if (!row) throw new ApiError('E_NOT_FOUND', `revision ${revision} 不存在`);

    const payload = loadJson<Record<string, any>>(row.payload_json, {});
    const credential = this.vault.get(row.credential_ref);
    const started = Date.now();
    const checks: CheckResult[] = [];

    const record = async (
      id: CheckId,
      fn: () => Promise<{ state: CheckResult['state']; detail: string | null }>,
    ): Promise<void> => {
      const t0 = Date.now();
      let result: { state: CheckResult['state']; detail: string | null };
      try {
        result = await fn();
      } catch (e: any) {
        result = { state: 'fail', detail: e.message ?? String(e) };
      }
      checks.push({
        id,
        label: CHECK_LABELS[id],
        state: result.state,
        detail: result.detail,
        duration_ms: Date.now() - t0,
        required: REQUIRED_CHECKS.includes(id),
      });
    };

    const timeout = Math.min(Number(payload.request_timeout_ms ?? 15000), 30000);
    const base = String(payload.endpoint ?? '').replace(/\/+$/, '');
    const modelName = String(payload.model ?? '');
    const authHeader: Record<string, string> = credential
      ? { authorization: `Bearer ${credential}` }
      : {};

    // 1) 连接：任意 HTTP 响应即算通（含 4xx）；网络错误/超时算失败
    let connectOk = false;
    await record('connect', async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      try {
        const res = await fetch(`${base}/models`, { headers: authHeader, signal: ctl.signal });
        connectOk = true;
        return { state: 'pass', detail: `HTTP ${res.status}` };
      } catch (e: any) {
        return {
          state: 'fail',
          detail: e.name === 'AbortError' ? `${timeout}ms 内无响应` : `无法连接：${e.message}`,
        };
      } finally {
        clearTimeout(timer);
      }
    });

    // 2) 认证 + 3) 模型存在：两者都从 /models 的应答里判断
    await record('auth', async () => {
      if (!connectOk) return { state: 'skip', detail: '连接未建立，跳过' };
      if (!credential) return { state: 'fail', detail: '未设置凭证' };
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      try {
        const res = await fetch(`${base}/models`, { headers: authHeader, signal: ctl.signal });
        if (res.status === 401 || res.status === 403) {
          return { state: 'fail', detail: `凭证被拒绝（HTTP ${res.status}）` };
        }
        return { state: 'pass', detail: `HTTP ${res.status}` };
      } catch (e: any) {
        return { state: 'fail', detail: e.message };
      } finally {
        clearTimeout(timer);
      }
    });

    await record('model_exists', async () => {
      if (!connectOk) return { state: 'skip', detail: '连接未建立，跳过' };
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      try {
        const res = await fetch(`${base}/models`, { headers: authHeader, signal: ctl.signal });
        if (!res.ok) return { state: 'fail', detail: `列模型失败（HTTP ${res.status}）` };
        const body: any = await res.json();
        const ids: string[] = Array.isArray(body?.data) ? body.data.map((m: any) => String(m.id)) : [];
        if (ids.length === 0) return { state: 'warn', detail: '模型列表为空，无法确认' };
        if (!ids.includes(modelName)) {
          return { state: 'fail', detail: `列表里没有 ${modelName}（共 ${ids.length} 个）` };
        }
        return { state: 'pass', detail: `${modelName} 在列表中` };
      } catch (e: any) {
        return { state: 'fail', detail: e.message };
      } finally {
        clearTimeout(timer);
      }
    });

    // 4) 流式 + 5) 工具调用：用固定 fixture 发一次最小对话（不含用户数据）
    let chatOk = false;
    await record('streaming', async () => {
      if (!connectOk) return { state: 'skip', detail: '连接未建立，跳过' };
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeader },
          signal: ctl.signal,
          body: JSON.stringify({
            model: modelName,
            stream: true,
            max_tokens: 16,
            // 固定 fixture：不发送任何用户会话内容
            messages: [{ role: 'user', content: 'ping' }],
          }),
        });
        if (!res.ok) return { state: 'fail', detail: `HTTP ${res.status}` };
        const reader = res.body?.getReader();
        if (!reader) return { state: 'fail', detail: '无响应体' };
        const { value } = await reader.read();
        await reader.cancel().catch(() => {});
        chatOk = true;
        const text = value ? Buffer.from(value).toString('utf8') : '';
        if (!text.includes('data:')) {
          return { state: 'warn', detail: '响应不是 SSE 分块格式' };
        }
        return { state: 'pass', detail: '收到流式分块' };
      } catch (e: any) {
        return { state: 'fail', detail: e.name === 'AbortError' ? '流式超时' : e.message };
      } finally {
        clearTimeout(timer);
      }
    });

    await record('tool_call', async () => {
      if (!chatOk) return { state: 'skip', detail: '对话接口不可用，跳过' };
      return { state: 'skip', detail: '首版探测不发送工具定义，避免触发真实工具；由 Harness 接入检查覆盖' };
    });

    // 6) 取消：发一个长请求然后立刻 abort，看能否干净断开
    await record('cancel', async () => {
      if (!connectOk) return { state: 'skip', detail: '连接未建立，跳过' };
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), Math.min(timeout, 5000));
      try {
        const p = fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeader },
          signal: ctl.signal,
          body: JSON.stringify({
            model: modelName,
            stream: true,
            max_tokens: 512,
            messages: [{ role: 'user', content: 'count slowly' }],
          }),
        });
        // 立刻取消，不等结果
        setTimeout(() => ctl.abort(), 100);
        await p;
        return { state: 'warn', detail: '请求在取消前已完成' };
      } catch (e: any) {
        if (e.name === 'AbortError') return { state: 'pass', detail: '取消后连接正常断开' };
        return { state: 'fail', detail: e.message };
      } finally {
        clearTimeout(timer);
      }
    });

    // 7) Harness 接入：诚实报告，不假装通过
    await record('harness_bridge', async () => {
      const v = this.harnessVersion();
      if (!v) {
        return {
          state: 'fail',
          detail: 'Harness 未就绪：无法确认此模型能被 Agent 驱动',
        };
      }
      return { state: 'pass', detail: `Harness ${v}` };
    });

    const requiredFailed = checks.filter((c) => c.required && c.state === 'fail');
    const verdict = requiredFailed.length === 0 ? 'compatible' : 'incompatible';
    const checkedAt = nowIso();
    const summary: ValidationSummary = {
      verdict,
      checked_at: checkedAt,
      adapter_version: ADAPTER_VERSION,
      harness_version: this.harnessVersion() ?? 'none',
      config_fingerprint: row.config_fingerprint ?? fingerprintConfig(payload, row.credential_ref),
    };

    const seq = this.store.transaction((tx) => {
      tx.run('UPDATE model_revisions SET validation_json = ? WHERE profile_id = ? AND revision = ?',
        compactJson(summary), profileId, revision);
      if (verdict === 'compatible') {
        return this.events.emit(tx, {
          type: 'model.validated',
          params: {
            profile_id: profileId,
            profile_name: String(payload.name ?? ''),
            revision,
            duration_ms: Date.now() - started,
          },
        }).seq;
      }
      return this.events.emit(tx, {
        type: 'model.validation_failed',
        params: {
          profile_id: profileId,
          revision,
          reason: requiredFailed.map((c) => `${c.label}：${c.detail ?? '未通过'}`).join('；'),
          failed_checks: requiredFailed.map((c) => c.id),
        },
      }).seq;
    });
    this.notify(seq);

    return {
      ok: true,
      verdict,
      checked_at: checkedAt,
      config_fingerprint: summary.config_fingerprint,
      checks,
      note:
        verdict === 'compatible'
          ? '全部必需项通过；可以激活。'
          : `必需项未全部通过（${requiredFailed.map((c) => c.label).join('、')}），只能保存草稿，不能激活。HTTP 200 或能列出模型都不等于可用于 Agent。`,
    };
  }

  // ---------------------------------------------------------------- 激活
  /**
   * 激活一个 revision。
   *
   * 只接受 `compatible` 且未失效的验证结论。回退 = 激活旧 revision，
   * 同样写新事件，不改写历史。
   */
  activate(profileId: string, revision: number, baseActiveRevision?: number | null): Record<string, unknown> {
    this.store.requireWritable();
    const profile = this.requireProfile(profileId);
    const row = this.store.one<RevisionRow>(
      'SELECT * FROM model_revisions WHERE profile_id = ? AND revision = ?',
      profileId,
      revision,
    );
    if (!row) throw new ApiError('E_NOT_FOUND', `revision ${revision} 不存在`);

    if (baseActiveRevision !== undefined && baseActiveRevision !== null) {
      if (baseActiveRevision !== profile.active_revision) {
        throw new ApiError('E_CONFLICT', `激活冲突：你基于 v${baseActiveRevision}，当前激活的是 v${profile.active_revision}`, {
          details: { expected: baseActiveRevision, actual: profile.active_revision },
        });
      }
    }

    const stored = loadJson<ValidationSummary | null>(row.validation_json, null);
    if (!stored) {
      throw new ApiError('E_VALIDATION', `v${revision} 尚未验证，不能激活`, {
        hint: '先点「测试连接」，必需项全部通过后才能激活',
      });
    }
    const effective = this.effectiveValidation(stored, row);
    if (effective.verdict !== 'compatible') {
      const why =
        effective.verdict === 'stale'
          ? '验证已失效（配置、适配器或 Harness 版本变化），需要重测'
          : '未通过必需项验证';
      throw new ApiError('E_VALIDATION', `v${revision} 不能激活：${why}`, {
        details: { verdict: effective.verdict },
        hint: '到设置 → 高级模型重新测试连接',
      });
    }

    const payload = loadJson<Record<string, any>>(row.payload_json, {});
    const previous = profile.active_revision;
    const ts = nowIso();
    const seq = this.store.transaction((tx) => {
      tx.run(
        'UPDATE model_profiles SET active_revision = ?, updated_at = ? WHERE profile_id = ?',
        revision,
        ts,
        profileId,
      );
      tx.run(
        `INSERT INTO meta(key, value) VALUES('model.active_profile_id', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        profileId,
      );
      return this.events.emit(tx, {
        type: 'model.activated',
        params: {
          profile_id: profileId,
          profile_name: String(payload.name ?? ''),
          revision,
          previous_revision: previous ?? undefined,
        },
      }).seq;
    });
    this.notify(seq);
    this.log('model activated', { profile_id: profileId, revision, previous });
    return this.get(profileId);
  }

  // ---------------------------------------------------------------- 校验
  private normalizeDraft(draft: ProfileDraft): { payload: Record<string, unknown>; credential: string | null } {
    const name = String(draft.name ?? '').trim();
    if (!name) throw new ApiError('E_VALIDATION', 'name 必填', { details: { field: 'name' } });
    if (name.length > 60) throw new ApiError('E_VALIDATION', 'name 不得超过 60 字符');

    const provider = String(draft.provider ?? '');
    if (!(PROVIDERS as readonly string[]).includes(provider)) {
      throw new ApiError('E_VALIDATION', `provider 只支持 ${PROVIDERS.join(', ')}`, {
        details: { field: 'provider', allowed: [...PROVIDERS] },
      });
    }
    const endpoint = String(draft.endpoint ?? '').trim();
    if (!endpoint) throw new ApiError('E_VALIDATION', 'endpoint 必填', { details: { field: 'endpoint' } });
    validateEndpoint(endpoint);

    const model = String(draft.model ?? '').trim();
    if (!model) throw new ApiError('E_VALIDATION', 'model 必填', { details: { field: 'model' } });
    if (model.length > 200) throw new ApiError('E_VALIDATION', 'model 不得超过 200 字符');

    const boundary = String(draft.data_boundary ?? 'local_only');
    if (!(DATA_BOUNDARIES as readonly string[]).includes(boundary)) {
      throw new ApiError('E_VALIDATION', `data_boundary 首版只允许 local_only（收到 ${boundary}）`, {
        details: { field: 'data_boundary' },
        hint: '云端模型需要先单独做数据边界决策，不是改一个枚举值就能开',
      });
    }

    const effort = draft.reasoning_effort;
    if (effort !== undefined && effort !== null && !(REASONING_EFFORTS as readonly string[]).includes(effort)) {
      throw new ApiError('E_VALIDATION', `reasoning_effort 只能是 ${REASONING_EFFORTS.join(' / ')}`);
    }
    if (draft.temperature !== undefined && draft.temperature !== null) {
      if (typeof draft.temperature !== 'number' || draft.temperature < 0 || draft.temperature > 2) {
        throw new ApiError('E_VALIDATION', 'temperature 必须在 0-2 之间');
      }
    }
    if (draft.max_output_tokens !== undefined && draft.max_output_tokens !== null) {
      if (!Number.isInteger(draft.max_output_tokens) || draft.max_output_tokens < 1) {
        throw new ApiError('E_VALIDATION', 'max_output_tokens 必须是正整数');
      }
    }
    if (draft.request_timeout_ms !== undefined && draft.request_timeout_ms !== null) {
      if (
        !Number.isInteger(draft.request_timeout_ms) ||
        draft.request_timeout_ms < 1000 ||
        draft.request_timeout_ms > 600000
      ) {
        throw new ApiError('E_VALIDATION', 'request_timeout_ms 必须在 1000-600000 之间');
      }
    }

    // payload 里**不含** credential：明文永不进这一层
    const payload: Record<string, unknown> = {
      name,
      provider,
      endpoint,
      model,
      reasoning_effort: draft.reasoning_effort ?? null,
      max_output_tokens: draft.max_output_tokens ?? null,
      temperature: draft.temperature ?? null,
      request_timeout_ms: draft.request_timeout_ms ?? null,
      budget_tokens: draft.budget_tokens ?? null,
      data_boundary: boundary,
    };
    return {
      payload,
      credential: typeof draft.credential === 'string' && draft.credential.length > 0 ? draft.credential : null,
    };
  }

  // ---------------------------------------------------------------- 概览用
  modelStatus(): Record<string, unknown> {
    const active = this.activeRevision();
    if (!active) {
      return { state: 'not_configured', active_profile_id: null, active_profile_name: null, active_revision: null, validated_at: null };
    }
    const row = this.store.one<RevisionRow>(
      'SELECT * FROM model_revisions WHERE profile_id = ? AND revision = ?',
      active.profile_id,
      active.revision,
    );
    const stored = row ? loadJson<ValidationSummary | null>(row.validation_json, null) : null;
    const effective = row && stored ? this.effectiveValidation(stored, row) : null;
    const state = !effective ? 'invalid' : effective.verdict === 'compatible' ? 'active' : 'invalid';
    return {
      state,
      active_profile_id: active.profile_id,
      active_profile_name: String(active.payload.name ?? ''),
      active_revision: active.revision,
      validated_at: effective?.checked_at ?? null,
      note:
        state === 'active'
          ? undefined
          : effective?.verdict === 'stale'
            ? '验证已失效，需要重测'
            : '未通过验证',
    };
  }
}
