/**
 * 会话与任务（run）的持久化服务。
 *
 * ## 一条铁律：状态变更与事件在**同一个事务**里提交
 *
 * 旧 POC 是先改内存、再「顺手」记一条日志，进程一崩就对不上。
 * 这里的写法是 `store.transaction((tx) => { ...改表...; events.emit(tx, ...) })`：
 * 要么两者都落盘，要么都不落。事务**提交之后**才向外推送事件，
 * 所以订阅者看到的事件一定对应已提交的状态。
 *
 * ## run 状态机
 *
 * accepted → understanding → planning → executing → succeeded / failed
 *   任一步可 → waiting_confirmation（等语音批准）/ waiting_input（缺参数）
 *   任一步可 → cancelled（用户取消）/ interrupted（进程重启中断）
 *   工具已发出但结果未知 → outcome_unknown（**不可自动重试**）
 *
 * 终态：succeeded / failed / cancelled / interrupted / outcome_unknown。
 */
import crypto from 'node:crypto';
import { Store, nowIso, compactJson, loadJson } from './store.ts';
import type { Tx } from './store.ts';
import type { EventLog } from './events.ts';
import { encodeCursor, decodeCursor } from './events.ts';
import { ApiError } from './http.ts';

export type RunStatus =
  | 'accepted'
  | 'understanding'
  | 'planning'
  | 'waiting_input'
  | 'waiting_confirmation'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'outcome_unknown';

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'outcome_unknown',
]);

export const RUN_STATUSES: readonly RunStatus[] = [
  'accepted',
  'understanding',
  'planning',
  'waiting_input',
  'waiting_confirmation',
  'executing',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'outcome_unknown',
];

export type Route = 'fast' | 'harness' | 'clarified';

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status as RunStatus);
}

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

// ------------------------------------------------------------------ 行与视图
interface SessionRow {
  session_id: string;
  title: string;
  status: string;
  last_run_id: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

interface MessageRow {
  message_id: string;
  session_id: string;
  role: string;
  text: string;
  streaming: number;
  source: string | null;
  created_at: string;
}

interface RunRow {
  run_id: string;
  session_id: string | null;
  prompt: string;
  status: string;
  route: string;
  source: string;
  fast_rule: string | null;
  idempotency_key: string | null;
  model_profile_id: string | null;
  model_revision: number | null;
  blocking_reason: string | null;
  error_code: string | null;
  harness_exit: number | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface RunStepRow {
  step_id: string;
  run_id: string;
  idx: number;
  title: string;
  state: string;
  started_at: string | null;
  finished_at: string | null;
  note: string | null;
}

interface ToolCallRow {
  tool_call_id: string;
  run_id: string;
  capability: string;
  action_label: string;
  args_summary: string;
  args_json: string;
  state: string;
  requires_approval: number;
  approval_id: string | null;
  robot_task_id: string | null;
  evidence: string | null;
  error_code: string | null;
  detail: string | null;
  requested_at: string;
  finished_at: string | null;
}

export interface ApprovalRow {
  approval_id: string;
  run_id: string | null;
  tool_call_id: string | null;
  capability: string;
  action_label: string;
  args_summary: string;
  args_json: string;
  prompt_text: string;
  status: string;
  window_opens_at: string | null;
  window_closes_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  authorization_json: string | null;
  authorization_consumed: number;
  created_at: string;
}

function sessionView(row: SessionRow): Record<string, unknown> {
  return {
    session_id: row.session_id,
    title: row.title,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // last_run_id 不落列：它可以从 runs 表按 session 取最新一条推导，落列就多一个要同步的真相源
    last_run_id: row.last_run_id ?? null,
  };
}

const SESSION_SELECT = `
  SELECT s.*,
         (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.session_id) AS message_count,
         (SELECT r.run_id FROM runs r WHERE r.session_id = s.session_id ORDER BY r.rowid DESC LIMIT 1) AS last_run_id
  FROM sessions s`;



function messageView(row: MessageRow): Record<string, unknown> {
  return {
    message_id: row.message_id,
    role: row.role,
    text: row.text,
    streaming: row.streaming === 1,
    source: row.source ?? 'text',
    created_at: row.created_at,
  };
}

export function runSummaryView(row: RunRow): Record<string, unknown> {
  const created = Date.parse(row.created_at);
  const finished = row.finished_at ? Date.parse(row.finished_at) : null;
  return {
    run_id: row.run_id,
    session_id: row.session_id ?? null,
    prompt: row.prompt,
    status: row.status,
    route: row.route,
    source: row.source,
    created_at: row.created_at,
    finished_at: row.finished_at ?? null,
    duration_ms: finished !== null && Number.isFinite(created) ? finished - created : null,
    model_revision: row.model_revision ?? null,
    fast_rule: row.fast_rule ?? null,
    blocking_reason: row.blocking_reason ?? null,
  };
}

function stepView(row: RunStepRow): Record<string, unknown> {
  return {
    step_id: row.step_id,
    index: row.idx,
    title: row.title,
    state: row.state,
    started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null,
    note: row.note ?? null,
  };
}

function toolCallView(row: ToolCallRow): Record<string, unknown> {
  return {
    tool_call_id: row.tool_call_id,
    capability: row.capability,
    action_label: row.action_label,
    args_summary: row.args_summary,
    requires_approval: row.requires_approval === 1,
    state: row.state,
    robot_task_id: row.robot_task_id ?? null,
    requested_at: row.requested_at,
    finished_at: row.finished_at ?? null,
    evidence: row.evidence ?? null,
  };
}

// ------------------------------------------------------------------ 服务
export interface RunServiceOptions {
  store: Store;
  events: EventLog;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** 事件提交后回调（用于 WS 广播）。只在事务已提交时调用。 */
  onEvent?: (seq: number) => void;
}

export interface SubmitRunInput {
  prompt: string;
  session_id?: string;
  source?: 'text' | 'asr';
  idempotency_key?: string;
  asr_meta?: Record<string, unknown>;
  route: Route;
  fast_rule?: string | null;
  status?: RunStatus;
}

export interface SubmitRunResult {
  run_id: string;
  status: string;
  route: string;
  fast_rule: string | null;
  created_at: string;
  duplicate: boolean;
}

export interface RecordClarificationInput {
  prompt: string;
  session_id?: string;
  source?: 'text' | 'asr';
  /** 面向用户的追问（事件摘要直接用它）。 */
  question: string;
  /** 缺失项，如 `capability:robot_stop` / `precondition`。 */
  missing?: string[];
  fast_rule?: string | null;
}

export class RunService {
  private store: Store;
  private events: EventLog;
  private log: (msg: string, extra?: Record<string, unknown>) => void;
  private onEvent: ((seq: number) => void) | undefined;

  constructor(opts: RunServiceOptions) {
    this.store = opts.store;
    this.events = opts.events;
    this.log = opts.log;
    this.onEvent = opts.onEvent;
  }

  /** 提交后通知（事务已提交）。失败不影响主流程。 */
  private notify(seq: number): void {
    if (this.onEvent) {
      try {
        this.onEvent(seq);
      } catch (e: any) {
        this.log('event notify failed', { error: e.message });
      }
    }
  }

  // ---------------------------------------------------------------- 会话
  createSession(title: string | null): Record<string, unknown> {
    this.store.requireWritable();
    const sid = newId('sess');
    const ts = nowIso();
    const finalTitle = (title ?? '').trim() || `会话 ${ts.slice(5, 16).replace('T', ' ')}`;
    // 会话创建本身不写事件：契约的事件面只登记「对用户有解释价值」的事，
    // 建会话不改变任何外部状态，写进历史只会稀释信号。
    this.store.transaction((tx) => {
      tx.run(
        `INSERT INTO sessions(session_id, title, status, created_at, updated_at)
         VALUES(?,?,?,?,?)`,
        sid,
        finalTitle,
        'active',
        ts,
        ts,
      );
    });
    return sessionView(
      this.store.one<SessionRow>('SELECT *, 0 AS message_count FROM sessions WHERE session_id = ?', sid)!,
    );
  }

  getSession(sessionId: string, cursor: string | null, limit: number): Record<string, unknown> {
    const row = this.store.one<SessionRow>(`${SESSION_SELECT} WHERE s.session_id = ?`, sessionId);
    if (!row) throw new ApiError('E_NOT_FOUND', `会话不存在：${sessionId}`);

    // 消息按 created_at 升序翻页：先按游标取「更早的」，再反转成时间顺序
    const where = ['session_id = ?'];
    const params: unknown[] = [sessionId];
    if (cursor) {
      const ts = decodeMsgCursor(cursor);
      if (ts === null) throw new ApiError('E_VALIDATION', '游标不合法');
      where.push('created_at < ?');
      params.push(ts);
    }
    const rows = this.store.all<MessageRow>(
      `SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY created_at DESC, message_id DESC LIMIT ?`,
      ...params,
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    return {
      ok: true,
      session: sessionView(row),
      messages: page.map(messageView),
      next_cursor: hasMore && page.length > 0 ? encodeMsgCursor(page[0].created_at) : null,
    };
  }

  listSessions(cursor: string | null, limit: number): Record<string, unknown> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (cursor) {
      const ts = decodeMsgCursor(cursor);
      if (ts === null) throw new ApiError('E_VALIDATION', '游标不合法');
      where.push('updated_at < ?');
      params.push(ts);
    }
    const rows = this.store.all<SessionRow>(
      `${SESSION_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY s.updated_at DESC LIMIT ?`,
      ...params,
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      ok: true,
      sessions: page.map(sessionView),
      next_cursor: hasMore && page.length > 0 ? encodeMsgCursor(page[page.length - 1].updated_at) : null,
    };
  }

  appendMessage(
    tx: Tx,
    sessionId: string,
    role: 'user' | 'agent' | 'system',
    text: string,
    source = 'text',
    runId: string | null = null,
  ): string {
    const mid = newId('msg');
    const ts = nowIso();
    tx.run(
      `INSERT INTO messages(message_id, session_id, run_id, role, text, streaming, source, created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
      mid,
      sessionId,
      runId,
      role,
      text,
      0,
      source,
      ts,
    );
    tx.run('UPDATE sessions SET updated_at = ? WHERE session_id = ?', ts, sessionId);
    return mid;
  }

  // ---------------------------------------------------------------- 任务
  /**
   * 提交一次请求。
   *
   * 幂等：`idempotency_key` 命中已有 run 时直接返回那一条（`duplicate: true`），
   * 不产生第二个任务、也不重复写事件。
   */
  submitRun(input: SubmitRunInput): SubmitRunResult {
    this.store.requireWritable();

    if (input.idempotency_key) {
      const existing = this.store.one<RunRow>(
        'SELECT * FROM runs WHERE idempotency_key = ?',
        input.idempotency_key,
      );
      if (existing) {
        return {
          run_id: existing.run_id,
          status: existing.status,
          route: existing.route,
          fast_rule: existing.fast_rule ?? null,
          created_at: existing.created_at,
          duplicate: true,
        };
      }
    }

    const status: RunStatus = input.status ?? 'accepted';
    const rid = newId('run');
    const ts = nowIso();
    const prompt = input.prompt;
    const source = input.source ?? 'text';

    const dupCheck = this.store.one<RunRow>(
      'SELECT * FROM runs WHERE idempotency_key = ?',
      input.idempotency_key ?? '\u0000none',
    );

    const seq = this.store.transaction((tx) => {
      // 幂等键再查一次（事务内），防并发双写
      if (input.idempotency_key) {
        const again = tx.one<RunRow>('SELECT * FROM runs WHERE idempotency_key = ?', input.idempotency_key);
        if (again) {
          throw new ApiError('E_CONFLICT', '同一幂等键已被使用', {
            details: { run_id: again.run_id },
          });
        }
      }
      tx.run(
        `INSERT INTO runs(
           run_id, session_id, prompt, status, route, source, fast_rule, idempotency_key,
           model_profile_id, model_revision, blocking_reason, error_code, harness_exit,
           created_at, updated_at, finished_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        rid,
        input.session_id ?? null,
        prompt,
        status,
        input.route,
        source,
        input.fast_rule ?? null,
        input.idempotency_key ?? null,
        null,
        null,
        null,
        null,
        null,
        ts,
        ts,
        null,
      );
      if (input.session_id) {
        this.appendMessage(tx, input.session_id, 'user', prompt, source, rid);
        tx.run('UPDATE sessions SET updated_at = ? WHERE session_id = ?', ts, input.session_id);
      }
      const s = this.events.emit(tx, {
        type: 'run.accepted',
        run_id: rid,
        session_id: input.session_id ?? null,
        params: { prompt: prompt.slice(0, 200), route: input.route, source },
      });
      return s.seq;
    });
    this.notify(seq);
    if (dupCheck) {
      // 极少数并发情形：事务抛出的 E_CONFLICT 已经在上面处理了，这里只做日志
      this.log('idempotency race observed', { key: input.idempotency_key });
    }
    return {
      run_id: rid,
      status,
      route: input.route,
      fast_rule: input.fast_rule ?? null,
      created_at: ts,
      duplicate: false,
    };
  }

  getRunRow(runId: string): RunRow | null {
    return this.store.one<RunRow>('SELECT * FROM runs WHERE run_id = ?', runId);
  }

  /**
   * 记录一次「需要澄清」的输入。
   *
   * 澄清没有执行意图，**不建 run**（GH-27）：建了也永远不会推进，只会被
   * `activeRun()` 当成活动任务，把下一条「停」挡在 `E_BUSY` 外。
   * 有会话时用户这句话仍然落进会话历史（`run_id` 为空），并写一条 `route.clarify`
   * 事件；消息与事件在同一事务里提交。返回事件时间戳，供响应里的 `created_at`。
   */
  recordClarification(input: RecordClarificationInput): string {
    this.store.requireWritable();
    const ts = nowIso();
    const seq = this.store.transaction((tx) => {
      if (input.session_id) {
        this.appendMessage(tx, input.session_id, 'user', input.prompt, input.source ?? 'text', null);
      }
      const missing = input.missing ?? [];
      return this.events.emit(tx, {
        type: 'route.clarify',
        session_id: input.session_id ?? null,
        // advice 是登记表模板 `{advice}` 的必填参数：给一句稳定的用户话术。
        // 缺失项（capability:... / precondition）是给诊断看的标识符，放 data，不塞进摘要。
        params: { reason: input.question, advice: CLARIFY_ADVICE },
        data: { missing, fast_rule: input.fast_rule ?? null },
      }).seq;
    });
    this.notify(seq);
    return ts;
  }

  listRuns(statusFilter: string | null, cursor: string | null, limit: number): Record<string, unknown> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (statusFilter) {
      where.push('status = ?');
      params.push(statusFilter);
    }
    if (cursor) {
      const seq = decodeCursor(cursor);
      if (seq === null) throw new ApiError('E_VALIDATION', '游标不合法');
      where.push('rowid < ?');
      params.push(seq);
    }
    const rows = this.store.all<RunRow>(
      `SELECT rowid AS _rid, * FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY rowid DESC LIMIT ?`,
      ...params,
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      ok: true,
      runs: page.map((r) => runSummaryView(r)),
      next_cursor:
        hasMore && page.length > 0 ? encodeCursor((page[page.length - 1] as any)._rid as number) : null,
    };
  }

  getRunDetail(runId: string): Record<string, unknown> {
    const run = this.getRunRow(runId);
    if (!run) throw new ApiError('E_NOT_FOUND', `任务不存在：${runId}`);
    const steps = this.store.all<RunStepRow>(
      'SELECT * FROM run_steps WHERE run_id = ? ORDER BY idx ASC',
      runId,
    );
    const calls = this.store.all<ToolCallRow>(
      'SELECT * FROM tool_calls WHERE run_id = ? ORDER BY requested_at ASC',
      runId,
    );
    const approvals = this.store.all<any>(
      'SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at ASC',
      runId,
    );

    const completed = steps.filter((s) => s.state === 'done').map((s) => s.title);
    const incomplete = steps.filter((s) => s.state !== 'done' && s.state !== 'skipped').map((s) => s.title);
    const outcome = outcomeOf(run.status);
    const robotTasks = calls.map((c) => c.robot_task_id).filter((x): x is string => Boolean(x));

    return {
      ok: true,
      run: runSummaryView(run),
      steps: steps.map(stepView),
      tool_calls: calls.map(toolCallView),
      approvals: approvals.map(approvalView),
      result: {
        outcome,
        completed_steps: completed,
        incomplete_steps: incomplete,
        reason: run.blocking_reason ?? null,
        robot_task_ids: robotTasks,
      },
      diagnostics: {
        harness_exit_code: null,
        error_code: run.error_code ?? null,
        config_revision: run.model_revision ?? null,
      },
    };
  }

  /**
   * 推进状态。
   *
   * 只允许在非终态上推进；终态不可改写（除了 crash 恢复把它们标为 interrupted）。
   * 每次推进都写事件，事件里带上旧状态，便于历史回放。
   */
  transition(runId: string, next: RunStatus, opts: { reason?: string; detail?: string } = {}): void {
    this.store.requireWritable();
    if (next === 'waiting_confirmation') {
      // 有审批记录的 run 必须由播报完成事件开启确认窗口；transition 直改会绕过
      // window_opened_at 与因果顺序，因此一律拒绝。
      //
      // 没有审批记录的 run（Harness 工具审批尚未实现，`/api/run` 的澄清/等待语义
      // 也用它做忙判定）保留既有的「等待」状态入口：它没有任何需要复述的审批，
      // 也就谈不上跳过复述。审批一旦存在，唯一入口仍是 openConfirmationWindow()。
      const approvals = this.store.one<{ n: number }>(
        'SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?',
        runId,
      );
      if ((approvals?.n ?? 0) > 0) {
        throw new ApiError(
          'E_CONFLICT',
          'waiting_confirmation 只能由 openConfirmationWindow() 在播报完成后开启',
          { details: { run_id: runId } },
        );
      }
    }
    const before = this.getRunRow(runId);
    if (!before) throw new ApiError('E_NOT_FOUND', `任务不存在：${runId}`);
    if (isTerminal(before.status) && before.status !== next) {
      throw new ApiError('E_CONFLICT', `任务已处于终态 ${before.status}，不能再改为 ${next}`, {
        details: { run_id: runId, status: before.status },
      });
    }
    const ts = nowIso();
    const finished = isTerminal(next) ? ts : null;
    const started = ['understanding', 'planning', 'executing'].includes(next) ? ts : null;
    const seq = this.store.transaction((tx) => {
      tx.run(
        `UPDATE runs SET status = ?, finished_at = COALESCE(?, finished_at),
           updated_at = ?, blocking_reason = ?
         WHERE run_id = ?`,
        next,
        finished,
        ts,
        opts.reason ?? null,
        runId,
      );
      // 契约只登记了 run.finished 一条「终结」事件：它承载 succeeded/failed/
      // cancelled/interrupted/outcome_unknown 五种结局，用 outcome 参数区分。
      // 不另造 run.succeeded 等类型——未登记类型会被 EventLog 直接拒绝，
      // 这也是「事件面不许偷偷扩张」的机制。
      if (isTerminal(next)) {
        const elapsed = Date.parse(ts) - Date.parse(before.created_at);
        return this.events.emit(tx, {
          type: 'run.finished',
          run_id: runId,
          session_id: before.session_id,
          severity: next === 'failed' || next === 'outcome_unknown' ? 'error' : next === 'cancelled' ? 'warning' : 'info',
          code: before.error_code ?? undefined,
          params: {
            outcome: next,
            detail: opts.detail ?? explainOutcome(next, opts.reason ?? null),
            duration_ms: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined,
          },
        }).seq;
      }
      // 非终态推进：统一用 run.step_changed 表达「进行到哪一步」，
      // 不新增 run.executing 之类的类型。
      if (isPhase(next)) {
        return this.events.emit(tx, {
          type: 'run.step_changed',
          run_id: runId,
          session_id: before.session_id,
          params: {
            step_id: `phase-${next}`,
            step_title: PHASE_LABELS[next],
            state: 'active',
          },
        }).seq;
      }
      return -1;
    });
    if (seq >= 0) this.notify(seq);
  }

  /**
   * 取消。
   *
   * 对终态任务返回当前详情并说明「已结束」，不报错——UI 的取消按钮可能连点。
   * 会作废该 run 下未决的审批与未消费授权，并写 `approval.cancelled` 事件。
   */
  cancelRun(runId: string, reason: string | null): { detail: Record<string, unknown>; changed: boolean; voidedApprovals: number } {
    this.store.requireWritable();
    const run = this.getRunRow(runId);
    if (!run) throw new ApiError('E_NOT_FOUND', `任务不存在：${runId}`);
    if (isTerminal(run.status)) {
      return { detail: this.getRunDetail(runId), changed: false, voidedApprovals: 0 };
    }
    const ts = nowIso();
    let voided = 0;
    const seq = this.store.transaction((tx) => {
      const pending = tx.all<{ approval_id: string; capability: string }>(
        `SELECT approval_id, capability FROM approvals
         WHERE run_id = ? AND status IN ('persisted','announced','waiting')`,
        runId,
      );
      for (const a of pending) {
        tx.run(
          `UPDATE approvals SET status = 'cancelled', decided_at = ?, decided_by = 'cancel' WHERE approval_id = ?`,
          ts,
          a.approval_id,
        );
        voided += 1;
        // 契约里没有 approval.cancelled：审批的取消也是一种「已裁决」，
        // 用 approval.resolved + status=cancelled 表达，不新增类型。
        this.events.emit(tx, {
          type: 'approval.resolved',
          run_id: runId,
          approval_id: a.approval_id,
          session_id: run.session_id,
          params: {
            action_label: a.capability,
            status: 'cancelled',
            decided_by: 'cancel',
          },
        });
      }
      tx.run(
        `UPDATE runs SET status = 'cancelled', finished_at = ?, updated_at = ?, blocking_reason = ?
         WHERE run_id = ?`,
        ts,
        ts,
        reason ?? '用户取消',
        runId,
      );
      return this.events.emit(tx, {
        type: 'run.cancelled',
        run_id: runId,
        session_id: run.session_id,
        params: { reason: reason ?? '用户取消', cancelled_approvals: voided },
      }).seq;
    });
    this.notify(seq);
    return { detail: this.getRunDetail(runId), changed: true, voidedApprovals: voided };
  }

  // ---------------------------------------------------------------- 审批与确认窗口
  /** 持久化一条待审批记录。**先落库，再播报**——播报不能先于审批存在。 */
  createApproval(input: {
    runId: string;
    capability: string;
    actionLabel: string;
    argsSummary: string;
    argsJson?: string;
    toolCallId?: string | null;
  }): { approval_id: string } {
    this.store.requireWritable();
    const run = this.getRunRow(input.runId);
    if (!run) throw new ApiError('E_NOT_FOUND', `任务不存在：${input.runId}`);
    if (isTerminal(run.status)) {
      throw new ApiError('E_CONFLICT', `任务已结束（${run.status}），不能再创建审批`, {
        details: { run_id: run.run_id, status: run.status },
      });
    }
    const approvalId = newId('appr');
    const ts = nowIso();
    this.store.transaction((tx) => {
      tx.run(
        `INSERT INTO approvals(
           approval_id, run_id, tool_call_id, capability, action_label, args_summary, args_json,
           prompt_text, status, created_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        approvalId,
        input.runId,
        input.toolCallId ?? null,
        input.capability,
        input.actionLabel,
        input.argsSummary,
        input.argsJson ?? '{}',
        '',
        'persisted',
        ts,
      );
    });
    return { approval_id: approvalId };
  }

  getApproval(approvalId: string): ApprovalRow | null {
    return this.store.one<ApprovalRow>('SELECT * FROM approvals WHERE approval_id = ?', approvalId);
  }

  /** robotd 已受理播报：记下实际渲染正文（审计与界面展示），不改确认窗口。 */
  markApprovalAnnounced(approvalId: string, promptText: string): void {
    this.store.requireWritable();
    this.store.transaction((tx) => {
      // prompt_text 始终补上：即使 tts_finished 抢在 HTTP 响应前到达，审计正文也不能丢。
      // 空串不覆盖已有正文：漏回正文时保留上一次可审计的句子。
      if (promptText) {
        tx.run('UPDATE approvals SET prompt_text = ? WHERE approval_id = ?', promptText, approvalId);
      }
      tx.run(
        `UPDATE approvals SET status = 'announced'
         WHERE approval_id = ? AND status = 'persisted'`,
        approvalId,
      );
    });
  }

  /**
   * 播报**真的播完**之后才开启确认窗口。
   *
   * 这是 §9.3 的因果顺序：请求被受理 ≠ 用户听见了。窗口开启时刻写进
   * `run.waiting_confirmation`，后续才能判断一句「好」是否发生在本轮复述之后。
   * 幂等：重复的 `speech.tts_finished` 不会重复开窗或重复写事件。
   */
  openConfirmationWindow(
    approvalId: string,
    windowMs: number,
  ): {
    opened: boolean;
    reason: string;
    approval_id: string;
    run_id: string | null;
    action_label: string;
    args_summary: string;
    window_opens_at: string | null;
    window_closes_at: string | null;
  } {
    this.store.requireWritable();
    const a = this.getApproval(approvalId);
    if (!a) {
      throw new ApiError('E_NOT_FOUND', `审批不存在：${approvalId}`);
    }
    const base = {
      approval_id: a.approval_id,
      run_id: a.run_id,
      action_label: a.action_label,
      args_summary: a.args_summary,
      window_opens_at: a.window_opens_at,
      window_closes_at: a.window_closes_at,
    };
    if (a.status === 'waiting') {
      return { opened: true, reason: 'already_open', ...base };
    }
    if (!['persisted', 'announced'].includes(a.status)) {
      return { opened: false, reason: `approval_${a.status}`, ...base };
    }
    const run = a.run_id ? this.getRunRow(a.run_id) : null;
    if (!run || isTerminal(run.status)) {
      const ts = nowIso();
      this.store.transaction((tx) => {
        tx.run(
          `UPDATE approvals SET status = 'cancelled', decided_at = ?, decided_by = 'run_closed'
           WHERE approval_id = ? AND status IN ('persisted','announced')`,
          ts,
          approvalId,
        );
      });
      return { opened: false, reason: run ? `run_${run.status}` : 'run_missing', ...base };
    }

    const opens = nowIso();
    const closes = new Date(Date.parse(opens) + windowMs).toISOString();
    const seqs: number[] = [];
    let won = false;
    this.store.transaction((tx) => {
      // 条件更新是这道门的原子性所在：只有仍处于可开窗状态的审批能赢。
      // 迟到的重复完成事件、并发的取消、重启对账都不会写出第二个确认窗口。
      won = tx.run(
        `UPDATE approvals SET status = 'waiting', window_opens_at = ?, window_closes_at = ?
         WHERE approval_id = ? AND status IN ('persisted','announced')`,
        opens,
        closes,
        approvalId,
      ).changes === 1;
      if (!won) return;
      tx.run(
        `UPDATE runs SET status = 'waiting_confirmation', updated_at = ?,
           blocking_reason = 'awaiting_voice_confirmation'
         WHERE run_id = ?`,
        opens,
        run.run_id,
      );
      seqs.push(
        this.events.emit(tx, {
          type: 'approval.waiting',
          run_id: run.run_id,
          approval_id: approvalId,
          session_id: run.session_id,
          params: {
            approval_id: approvalId,
            action_label: a.action_label,
            args_summary: a.args_summary,
            window_opened_at: opens,
            window_closes_at: closes,
          },
        }).seq,
      );
      seqs.push(
        this.events.emit(tx, {
          type: 'run.waiting_confirmation',
          run_id: run.run_id,
          approval_id: approvalId,
          session_id: run.session_id,
          params: {
            approval_id: approvalId,
            action_label: a.action_label,
            window_opened_at: opens,
            window_closes_at: closes,
          },
        }).seq,
      );
    });
    if (!won) {
      // 输给另一个完成/取消事件：按当前落库状态如实回答，不伪造开窗。
      const fresh = this.getApproval(approvalId);
      if (!fresh) {
        return { opened: false, reason: 'not_found', ...base, window_opens_at: null, window_closes_at: null };
      }
      const freshBase = {
        approval_id: fresh.approval_id,
        run_id: fresh.run_id,
        action_label: fresh.action_label,
        args_summary: fresh.args_summary,
        window_opens_at: fresh.window_opens_at,
        window_closes_at: fresh.window_closes_at,
      };
      if (fresh.status === 'waiting') {
        return { opened: true, reason: 'already_open', ...freshBase };
      }
      return { opened: false, reason: `approval_${fresh.status}`, ...freshBase };
    }
    for (const seq of seqs) this.notify(seq);
    return {
      opened: true,
      reason: 'opened',
      approval_id: approvalId,
      run_id: run.run_id,
      action_label: a.action_label,
      args_summary: a.args_summary,
      window_opens_at: opens,
      window_closes_at: closes,
    };
  }

  /**
   * 审批复述失败或被 stop 打断：**不开窗**，并给出明确事件。
   *
   * - stop：按取消处理（用户要求停止，不是系统故障）；
   * - 其它：按失败处理，发 `approval.unavailable`，run 不能显示成「已问过用户」。
   */
  abortApproval(
    approvalId: string,
    reason: string,
    opts: { byStop?: boolean; kind?: string } = {},
  ): { changed: boolean; reason: string; run_id: string | null } {
    this.store.requireWritable();
    const a = this.getApproval(approvalId);
    if (!a) return { changed: false, reason: 'not_found', run_id: null };
    if (!['persisted', 'announced', 'waiting'].includes(a.status)) {
      return { changed: false, reason: `approval_${a.status}`, run_id: a.run_id };
    }
    const run = a.run_id ? this.getRunRow(a.run_id) : null;
    const next: RunStatus | null = run && !isTerminal(run.status)
      ? (opts.byStop ? 'cancelled' : 'failed')
      : null;
    const ts = nowIso();
    const seqs: number[] = [];
    let won = false;
    this.store.transaction((tx) => {
      // 与开窗使用同一组可操作状态做条件更新：先赢的那个事件决定终局。
      won = tx.run(
        `UPDATE approvals SET status = 'cancelled', decided_at = ?, decided_by = ?
         WHERE approval_id = ? AND status IN ('persisted','announced','waiting')`,
        ts,
        opts.byStop ? 'stop' : 'announce_failed',
        approvalId,
      ).changes === 1;
      if (!won) return;
      if (next && run) {
        tx.run(
          `UPDATE runs SET status = ?, finished_at = ?, updated_at = ?, blocking_reason = ?
           WHERE run_id = ?`,
          next,
          ts,
          ts,
          reason,
          run.run_id,
        );
        const elapsed = Date.parse(ts) - Date.parse(run.created_at);
        seqs.push(
          this.events.emit(tx, {
            type: 'run.finished',
            run_id: run.run_id,
            session_id: run.session_id,
            severity: next === 'failed' ? 'error' : 'warning',
            params: {
              outcome: next,
              detail: reason,
              duration_ms: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined,
            },
          }).seq,
        );
      }
      if (opts.byStop) {
        seqs.push(
          this.events.emit(tx, {
            type: 'approval.resolved',
            run_id: a.run_id,
            approval_id: approvalId,
            session_id: run?.session_id ?? null,
            params: {
              action_label: a.action_label,
              status: 'cancelled',
              decided_by: 'stop',
            },
          }).seq,
        );
      } else {
        seqs.push(
          this.events.emit(tx, {
            type: 'approval.unavailable',
            run_id: a.run_id,
            approval_id: approvalId,
            session_id: run?.session_id ?? null,
            params: { reason, kind: opts.kind ?? 'no_audio' },
          }).seq,
        );
      }
    });
    if (!won) {
      const fresh = this.getApproval(approvalId);
      return { changed: false, reason: fresh ? `approval_${fresh.status}` : 'not_found', run_id: a.run_id };
    }
    for (const seq of seqs) this.notify(seq);
    return { changed: true, reason: opts.byStop ? 'cancelled_by_stop' : 'announce_failed', run_id: a.run_id };
  }

  /** 当前唯一的活动 run（活动上限为 1）。 */
  activeRun(): RunRow | null {
    const placeholders = RUN_STATUSES.filter((s) => !isTerminal(s)).map(() => '?').join(',');
    return this.store.one<RunRow>(
      `SELECT * FROM runs WHERE status IN (${placeholders}) ORDER BY rowid DESC LIMIT 1`,
      ...RUN_STATUSES.filter((s) => !isTerminal(s)),
    );
  }

  /**
   * 崩溃恢复对账。
   *
   * 进程重启后，数据库里可能躺着 `executing` 的 run——它对应的 Harness 子进程
   * 已经没了。这类 run 不能装作还在跑：一律标为 `interrupted`，
   * 并明确写出「不确定是否执行过」，让人去看而不是自动重试。
   */
  reconcileOnStartup(): { interrupted: number; details: string[] } {
    const placeholders = RUN_STATUSES.filter((s) => !isTerminal(s)).map(() => '?').join(',');
    const stuck = this.store.all<RunRow>(
      `SELECT * FROM runs WHERE status IN (${placeholders}) ORDER BY rowid ASC`,
      ...RUN_STATUSES.filter((s) => !isTerminal(s)),
    );
    if (stuck.length === 0) return { interrupted: 0, details: [] };

    const ts = nowIso();
    const details: string[] = [];
    let interrupted = 0;
    for (const run of stuck) {
      // GH-27 之前的遗留：`clarified` 的 run 停在非终态，但它从未执行、也没有任何步骤可推进。
      // 把它报成 `interrupted` 等于每次重启都制造一条假故障，所以直接关闭（cancelled）。
      if (run.route === 'clarified') {
        this.store.transaction((tx) => {
          tx.run(
            `UPDATE runs SET status = 'cancelled', finished_at = ?, updated_at = ?, blocking_reason = ?
             WHERE run_id = ?`,
            ts,
            ts,
            '澄清请求没有执行意图，不占用活动任务名额；升级后不再创建 run',
            run.run_id,
          );
          this.events.emit(tx, {
            type: 'run.finished',
            run_id: run.run_id,
            session_id: run.session_id,
            severity: 'info',
            params: {
              outcome: 'cancelled',
              detail: '澄清请求没有执行，升级后不再为澄清创建任务。',
            },
          });
        });
        continue;
      }
      // 有已发出的工具调用 → 结局未知，不能重试
      const liveCalls = this.store.all<ToolCallRow>(
        `SELECT * FROM tool_calls WHERE run_id = ? AND state IN ('requested','running')`,
        run.run_id,
      );
      const nextStatus = liveCalls.length > 0 ? 'outcome_unknown' : 'interrupted';
      const note =
        liveCalls.length > 0
          ? `进程重启时有 ${liveCalls.length} 个工具调用已发出但未确认结果，不能自动重试`
          : '进程重启导致中断，未产生副作用';
      this.store.transaction((tx) => {
        tx.run(
          `UPDATE runs SET status = ?, finished_at = ?, updated_at = ?, blocking_reason = ?
           WHERE run_id = ?`,
          nextStatus,
          ts,
          ts,
          note,
          run.run_id,
        );
        for (const call of liveCalls) {
          tx.run(
            `UPDATE tool_calls SET state = 'outcome_unknown', finished_at = ?, evidence = ? WHERE tool_call_id = ?`,
            ts,
            '进程重启时状态未确认',
            call.tool_call_id,
          );
        }
        this.events.emit(tx, {
          type: 'run.finished',
          run_id: run.run_id,
          session_id: run.session_id,
          severity: nextStatus === 'outcome_unknown' ? 'error' : 'warning',
          params: {
            outcome: nextStatus,
            detail: `进程重启：${run.status} → ${nextStatus}。${note}`,
          },
        });
      });
      details.push(`${run.run_id}: ${run.status} → ${nextStatus}`);
      interrupted += 1;
    }
    this.log('startup reconciliation', { interrupted, details });
    return { interrupted, details };
  }

  // ---------------------------------------------------------------- 步骤与工具调用
  addStep(tx: Tx, runId: string, title: string, state = 'pending'): string {
    const row = tx.one<{ n: number }>('SELECT COUNT(*) AS n FROM run_steps WHERE run_id = ?', runId);
    const sid = newId('step');
    tx.run(
      `INSERT INTO run_steps(step_id, run_id, idx, title, state, started_at, finished_at, note)
       VALUES(?,?,?,?,?,?,?,?)`,
      sid,
      runId,
      (row?.n ?? 0) + 1,
      title,
      state,
      state === 'active' ? nowIso() : null,
      null,
      null,
    );
    return sid;
  }

  recordToolCall(
    tx: Tx,
    runId: string,
    capability: string,
    actionLabel: string,
    argsSummary: string,
    state: string,
    opts: { args?: Record<string, unknown>; requiresApproval?: boolean; toolCallId?: string } = {},
  ): string {
    const cid = opts.toolCallId ?? newId('call');
    tx.run(
      `INSERT INTO tool_calls(tool_call_id, run_id, capability, action_label, args_summary, args_json,
         state, requires_approval, approval_id, robot_task_id, evidence, error_code, detail,
         requested_at, finished_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      cid,
      runId,
      capability,
      actionLabel,
      argsSummary,
      compactJson(opts.args ?? {}),
      state,
      opts.requiresApproval ? 1 : 0,
      null,
      null,
      null,
      null,
      null,
      nowIso(),
      null,
    );
    return cid;
  }
}

/** 澄清事件的固定建议：不猜着执行。 */
const CLARIFY_ADVICE = '补充后我会继续，不会先猜着执行。';

function outcomeOf(status: string): string {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'interrupted':
      return 'interrupted';
    case 'outcome_unknown':
      return 'outcome_unknown';
    default:
      return 'in_progress';
  }
}

const PHASE_LABELS: Record<string, string> = {
  understanding: '正在理解请求',
  planning: '正在规划步骤',
  executing: '正在执行',
};

function isPhase(status: string): boolean {
  return status in PHASE_LABELS;
}

function explainOutcome(next: string, reason: string | null): string {
  const base: Record<string, string> = {
    succeeded: '任务已完成。',
    failed: '任务未完成。',
    cancelled: '任务已被取消。',
    interrupted: '任务因进程重启而中断。',
    outcome_unknown: '动作已发出但结果未确认，不能当作未执行。',
  };
  const head = base[next] ?? '任务已结束。';
  return reason ? `${head}${reason}` : head;
}

export function approvalView(row: any): Record<string, unknown> {
  const auth = loadJson<any>(row.authorization_json, null);
  return {
    approval_id: row.approval_id,
    run_id: row.run_id ?? null,
    tool_call_id: row.tool_call_id ?? null,
    capability: row.capability,
    args_summary: row.args_summary,
    status: row.status,
    prompt_text: row.prompt_text,
    window_opens_at: row.window_opens_at ?? null,
    window_closes_at: row.window_closes_at ?? null,
    created_at: row.created_at,
    decided_at: row.decided_at ?? null,
    decided_by: row.decided_by ?? null,
    authorization: auth
      ? { scope: auth.scope, expires_at: auth.expires_at, consumed: auth.consumed === true }
      : null,
  };
}

/** 消息/会话游标：`v1m:<iso>` —— 与事件游标（seq）区分开，避免混用。 */
export function encodeMsgCursor(iso: string): string {
  return `v1m:${Buffer.from(iso, 'utf8').toString('base64url')}`;
}

export function decodeMsgCursor(cursor: string): string | null {
  if (!cursor.startsWith('v1m:')) return null;
  try {
    const iso = Buffer.from(cursor.slice(4), 'base64url').toString('utf8');
    return iso.length > 0 ? iso : null;
  } catch {
    return null;
  }
}

export { compactJson };
