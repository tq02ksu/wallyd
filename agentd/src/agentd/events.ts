/**
 * 语义事件：登记、模板渲染、写入、查询。
 *
 * 设计依据：`docs/spec/agentd-functional-design.md` §5.4、§6.2，开发计划 A07。
 *
 * ## 为什么要有「模板」
 *
 * 事件页的默认视图必须是**人类可读的时间线**，而不是一段 JSON。设计要求：
 * 中文标题来自确定性事件模板，**不调用高级模型总结日志**——模型离线时也能读懂历史。
 * 所以每条事件类型在 `agentd/contracts/events.json` 里登记 `title/summary/impact/advice`
 * 模板，这里只做占位符填充。
 *
 * ## 白名单
 *
 * 未登记的类型**不得写进稳定接口**：写的时候会拒绝（不是静默丢弃，也不是直通）。
 * 这样「某处随手 emit 一个新类型」不会污染历史页面与导出。
 *
 * ## 游标
 *
 * 游标是不透明的 base64url，里层是 `seq`。用 seq 而不是时间戳做游标：
 * 同一毫秒内的多条事件也不会重复或漏项。`seq` 由 SQLite AUTOINCREMENT 保证单调且不复用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Store, Tx } from './store.ts';
import { compactJson, nowIso } from './store.ts';
import type { components } from '../../contracts/generated/agentd-types.ts';
import { validateEventPayload, type PayloadFieldSpec } from './event-payload.ts';
import { EventRateLimiter, type RateLimitSpec } from './event-rate-limit.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 事件严重度。取值由契约 EventView.severity 决定，不在这里另立一套。 */
export type Severity = NonNullable<components['schemas']['EventView']['severity']>;
export type EventSource = 'agentd' | 'robotd' | 'harness' | 'model' | 'store' | 'user';

export interface EventTemplate {
  type: string;
  category: string;
  severity: Severity;
  title: string;
  summary: string;
  impact: string | null;
  advice: string | null;
  /** 由登记表显式声明，不按类型名推断（daemon.recovered 不是恢复事件）。 */
  is_recovery?: boolean;
  payload_fields: string[];
  required_fields: string[];
  /** 字段级契约声明（type/required/enum/...）；运行时的 payload 校验直接用生成物。 */
  payload_spec?: Record<string, PayloadFieldSpec> | null;
  /** 频率上限（只有声明了的事件才降频，例如 person.moved）。 */
  rate_limit?: RateLimitSpec | null;
}

interface EventRegistry {
  version: number;
  severity_labels: Record<string, string>;
  registered_types: string[];
  templates: EventTemplate[];
  envelope: { required: string[]; forbidden_payload_keys: string[] };
}

export interface EmitInput {
  type: string;
  severity?: Severity;
  source?: EventSource;
  params?: Record<string, unknown>;
  data?: Record<string, unknown> | null;
  session_id?: string | null;
  run_id?: string | null;
  tool_call_id?: string | null;
  robot_task_id?: string | null;
  approval_id?: string | null;
  code?: string | null;
  caused_by?: string | null;
  recovery_of?: string | null;
  source_instance_id?: string | null;
  occurred_at?: string;
}

export interface EmitResult {
  /** 落库后的 seq；被频率上限压掉时为 0。 */
  seq: number;
  /** 落库后的 event_id；被频率上限压掉时为空串。 */
  event_id: string;
  /** true = 这条观测因契约频率上限被丢弃，没有写入事件库。 */
  throttled: boolean;
}

export interface EventRow {
  seq: number;
  event_id: string;
  type: string;
  version: number;
  severity: Severity;
  occurred_at: string;
  received_at: string;
  source: string;
  session_id: string | null;
  run_id: string | null;
  tool_call_id: string | null;
  robot_task_id: string | null;
  approval_id: string | null;
  code: string | null;
  params_json: string;
  data_json: string | null;
  caused_by: string | null;
  recovery_of: string | null;
}

/**
 * 事件对外视图（agentd/contracts/openapi.yaml#EventView）。
 *
 * 从契约派生而不是手抄：抄一份 19 字段的 interface，契约加一个字段时没有任何东西会红。
 * 这里更容不下漂移——事件是 WS 实时推送的载荷，字段少了前端话术会直接塌。
 */
export type EventView = components['schemas']['EventView'];

export class EventRegistryError extends Error {
  readonly code = 'E_VALIDATION';
}

/** 读生成物里的登记表。缺文件即启动失败——不能在没有白名单的情况下跑起来。 */
export function loadRegistry(contractDir?: string): EventRegistry {
  const file =
    contractDir ??
    process.env.AGENTD_EVENTS_JSON ??
    // src/agentd/ → agentd/contracts/generated/events.json（agentd 自成一块，契约随它走）
    path.resolve(HERE, '..', '..', 'contracts', 'generated', 'events.json');
  if (!fs.existsSync(file)) {
    throw new EventRegistryError(`找不到事件登记表 ${file}；先跑 npm run contract:agentd`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as EventRegistry;
}

function fillTemplate(template: string, params: Record<string, unknown>, context: Record<string, string>): string {
  return template.replace(/\{([a-z0-9_]+)\}/g, (whole, key: string) => {
    if (key in context) return context[key];
    const value = params[key];
    if (value === undefined || value === null || value === '') return whole;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return String(value);
  });
}

/** 上下文键（模板里可用的「非 payload」占位符）。 */
function buildContext(params: Record<string, unknown>): Record<string, string> {
  const route = String(params.route ?? '');
  const outcome = String(params.outcome ?? '');
  const state = String(params.state ?? '');
  const decision = String(params.status ?? '');
  return {
    route_label:
      route === 'fast' ? '确定性快速指令' : route === 'harness' ? '交给高级模型理解' : '需要澄清',
    outcome_label:
      outcome === 'succeeded'
        ? '已完成'
        : outcome === 'failed'
          ? '失败'
          : outcome === 'cancelled'
            ? '已取消'
            : outcome === 'interrupted'
              ? '被中断'
              : outcome === 'outcome_unknown'
                ? '结果待确认'
                : '已结束',
    state_label:
      state === 'done'
        ? '已完成'
        : state === 'active'
          ? '进行中'
          : state === 'waiting'
            ? '等待中'
            : state === 'failed'
              ? '失败'
              : state === 'skipped'
                ? '已跳过'
                : '未开始',
    decision_label:
      decision === 'approved'
        ? '已确认'
        : decision === 'denied'
          ? '已拒绝'
          : decision === 'expired' || decision === 'timeout'
            ? '已超时，未执行'
            : decision === 'cancelled'
              ? '已取消，未执行'
              : '待确认',
  };
}

export function renderEvent(
  row: EventRow,
  templates: Map<string, EventTemplate>,
): EventView {
  const tpl = templates.get(row.type);
  const params = safeParse(row.params_json) as Record<string, unknown>;
  const context = buildContext(params);
  const title = tpl ? fillTemplate(tpl.title, params, context) : `未知事件类型：${row.type}`;
  const summary = tpl
    ? fillTemplate(tpl.summary, params, context)
    : '这条事件来自尚未登记的来源，诊断信息见详情。';
  return {
    event_id: row.event_id,
    cursor: encodeCursor(row.seq),
    type: row.type,
    severity: row.severity,
    occurred_at: row.occurred_at,
    received_at: row.received_at,
    source: row.source,
    title,
    summary,
    impact: tpl?.impact ? fillTemplate(tpl.impact, params, context) : null,
    advice: tpl?.advice ? fillTemplate(tpl.advice, params, context) : null,
    // 恢复标志来自登记表，不从类型名猜：daemon.recovered 名字带 recovered，
    // 但它是「上次没跑完」的告警，标成「已恢复」是错的。
    recovered: tpl?.is_recovery === true,
    recovery_of: row.recovery_of,
    run_id: row.run_id,
    session_id: row.session_id,
    approval_id: row.approval_id,
    robot_task_id: row.robot_task_id,
    code: row.code,
    data: row.data_json ? (safeParse(row.data_json) as Record<string, unknown>) : null,
  };
}

function safeParse(raw: string | null): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function encodeCursor(seq: number): string {
  return Buffer.from(`v1:${seq}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^v1:(\d+)$/.exec(text);
    if (!m) return null;
    return Number(m[1]);
  } catch {
    return null;
  }
}

let eventCounter = 0;

/**
 * 事件写入与查询。所有写操作都**必须**发生在调用方给的事务里——
 * 这样业务状态与审计事件才能真正同事务提交（Store 的纪律 1）。
 */
export class EventLog {
  private store: Store;
  private registry: EventRegistry;
  private templates: Map<string, EventTemplate>;
  private bootId: string;
  private limiter = new EventRateLimiter();
  private now: () => number;

  constructor(store: Store, registry: EventRegistry, bootId: string, opts: { now?: () => number } = {}) {
    this.store = store;
    this.registry = registry;
    this.bootId = bootId;
    this.templates = new Map(registry.templates.map((t) => [t.type, t]));
    this.now = opts.now ?? (() => Date.now());
  }

  isRegistered(type: string): boolean {
    return this.templates.has(type);
  }

  get registeredTypes(): string[] {
    return this.registry.registered_types;
  }

  get severityLabels(): Record<string, string> {
    return this.registry.severity_labels;
  }

  /**
   * 写一条事件。**必须在事务里调用**（传 tx）。
   *
   * 未登记的类型抛错——不是静默跳过。这样开发期就能发现「忘了登记事件」。
   */
  emit(tx: Tx, input: EmitInput): EmitResult {
    const tpl = this.templates.get(input.type);
    if (!tpl) {
      throw new EventRegistryError(
        `事件类型 ${input.type} 未在 agentd/contracts/events.json 登记；未登记类型不得写入稳定接口`,
      );
    }
    const params = input.params ?? {};
    const forbidden = new Set(this.registry.envelope.forbidden_payload_keys);
    for (const key of Object.keys(params)) {
      if (forbidden.has(key)) {
        throw new EventRegistryError(`事件 ${input.type} 的参数含禁列字段 ${key}（思维链/凭证不得入库）`);
      }
    }
    // 字段级契约：必填、类型、枚举。「可选字段省略」与「可选字段填 null」是两回事，
    // 后者在这里被拒——否则下游分不清「没有这个事实」和「事实为空」。
    const payloadProblems = validateEventPayload(tpl.payload_spec, params);
    if (payloadProblems.length) {
      throw new EventRegistryError(
        `事件 ${input.type} 的 payload 不符合契约：${payloadProblems.join('；')}`,
      );
    }
    // 频率上限（契约声明）：超出即丢弃，不落库、不补发。
    if (tpl.rate_limit && !this.limiter.allow(input.type, tpl.rate_limit, params, this.now())) {
      return { seq: 0, event_id: '', throttled: true };
    }
    const received = nowIso();
    eventCounter = (eventCounter + 1) % 0xffff;
    const eventId = `ev-${this.bootId.slice(0, 8)}-${Date.now().toString(36)}-${eventCounter.toString(36)}`;
    const res = tx.run(
      `INSERT INTO events(
         event_id, type, version, severity, occurred_at, received_at, source, source_instance_id,
         session_id, run_id, tool_call_id, robot_task_id, approval_id, code, params_json, data_json,
         caused_by, recovery_of
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      eventId,
      input.type,
      1,
      input.severity ?? tpl.severity,
      input.occurred_at ?? received,
      received,
      input.source ?? 'agentd',
      input.source_instance_id ?? this.bootId,
      input.session_id ?? null,
      input.run_id ?? null,
      input.tool_call_id ?? null,
      input.robot_task_id ?? null,
      input.approval_id ?? null,
      input.code ?? null,
      compactJson(params),
      input.data ? compactJson(input.data) : null,
      input.caused_by ?? null,
      input.recovery_of ?? null,
    );
    return { seq: res.lastInsertRowid, event_id: eventId, throttled: false };
  }

  /** 便捷写法：自己开事务写一条事件（用于与业务状态无关的独立事件）。 */
  emitStandalone(input: EmitInput): EmitResult {
    return this.store.transaction((tx) => this.emit(tx, input));
  }

  /** 取某条记录的原始行（用于关联与对账）。 */
  get(seq: number): EventRow | null {
    return this.store.one<EventRow>('SELECT * FROM events WHERE seq = ?', seq);
  }

  headCursor(): string {
    const row = this.store.one<{ seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM events');
    return encodeCursor(row?.seq ?? 0);
  }

  /**
   * 查询。按 `seq` 降序（最新在前）分页；游标是「上一页最后一条的 seq」。
   *
   * 用 `seq < cursor` 而不是 `<=`：游标指向的条目已经返回过，不能重复。
   */
  query(opts: {
    since?: string | null;
    until?: string | null;
    severity?: Severity | null;
    source?: string | null;
    runId?: string | null;
    q?: string | null;
    cursor?: string | null;
    limit?: number;
  }): { events: EventView[]; next_cursor: string | null; gap: null } {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where: string[] = [];
    const params: unknown[] = [];

    if (opts.since) {
      where.push('occurred_at >= ?');
      params.push(opts.since);
    }
    if (opts.until) {
      where.push('occurred_at <= ?');
      params.push(opts.until);
    }
    if (opts.severity) {
      where.push('severity = ?');
      params.push(opts.severity);
    }
    if (opts.source) {
      where.push('source = ?');
      params.push(opts.source);
    }
    if (opts.runId) {
      where.push('run_id = ?');
      params.push(opts.runId);
    }
    if (opts.cursor) {
      const seq = decodeCursor(opts.cursor);
      if (seq === null) {
        throw new EventRegistryError('游标不合法');
      }
      where.push('seq < ?');
      params.push(seq);
    }

    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`;
    // 多取一条判断有没有下一页
    let rows = this.store.all<EventRow>(sql, ...params, limit + 1);

    const keyword = (opts.q ?? '').trim();
    if (keyword) {
      // 关键词覆盖可读标题/摘要/错误码：先渲染再过滤，保证搜到的是「用户看到的字」。
      const needle = keyword.toLowerCase();
      rows = rows
        .map((r) => ({ row: r, view: renderEvent(r, this.templates) }))
        .filter(
          ({ view }) =>
            view.title.toLowerCase().includes(needle) ||
            view.summary.toLowerCase().includes(needle) ||
            (view.code ?? '').toLowerCase().includes(needle),
        )
        .map(({ row }) => row);
      // 关键词过滤后分页语义会变粗（可能不足 limit），这里如实返回当前能给的
      const views = rows.slice(0, limit).map((r) => renderEvent(r, this.templates));
      return {
        events: views,
        next_cursor: rows.length > limit ? encodeCursor(rows[limit - 1].seq) : null,
        gap: null,
      };
    }

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      events: page.map((r) => renderEvent(r, this.templates)),
      next_cursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1].seq) : null,
      gap: null,
    };
  }
}
