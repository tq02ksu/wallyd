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
    for (const run of stuck) {
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
    }
    this.log('startup reconciliation', { interrupted: stuck.length, details });
    return { interrupted: stuck.length, details };
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
