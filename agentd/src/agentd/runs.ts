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
import { classifyApprovalUtterance } from './approval-intent.ts';
import { isProtectedUtterance } from './router.ts';
import { announceLimits } from '../../../contracts/tools/announce-lexicon.mjs';
import type {
  ConversationAttribution,
  ConversationContext,
  ConversationPeek,
} from './conversation.ts';

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

/** 结论播报的结果。**与 run 状态无关**：被打断不等于任务失败。 */
export type NarrationOutcome = 'spoken' | 'interrupted' | 'failed';

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
  /** Harness thread：同一会话复用同一个 thread；未跑过 Harness 时为空。 */
  thread_id: string | null;
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
  /** 由执行步骤/工具结果归纳的「做了什么」；不是模型推理正文。 */
  result_summary: string | null;
  /** 播报请求的原子认领时间；非空 = 已经请求过播报，重放必须跳过。 */
  narration_requested_at: string | null;
  /** 播报结果；运行状态不受它影响。 */
  narration: string | null;
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
  repeat_count: number;
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
    narration: row.narration ?? null,
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
    approval_id: row.approval_id ?? null,
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
  /**
   * run 被取消后回调（装配层用来真正中断 Harness thread）。
   *
   * 状态与事件已经在事务里提交，这里只负责「让外部执行体停下来」。
   * 不在 RunService 里持有 AbortController：runs.ts 是纯状态机 + SQLite，
   * 引入执行细节会让它无法在无模型 SDK 的环境里测试。
   */
  onCancel?: (runId: string) => void;
  /**
   * run 进入终态且值得播报时回调（结论播报，GH-13）。
   *
   * 在事务提交之后调用；`cancelled` 不回调——用户停止/取消是安全旁路，
   * 停止后紧接着念一句「没做成」既吵又危险。回调里的异常不影响主流程。
   */
  onTerminal?: (runId: string) => void;
  /**
   * 把一条 ASR final 提交到**与 `POST /api/run` 相同的路径**（装配层注入）。
   *
   * 分发器本身只判定「这句话该不该变成一次 run」；路由、审批、幂等仍由
   * `submitRunRequest` 负责。未注入时 dispatcher 只做忽略判定（单测用）。
   */
  submitUtterance?: (input: {
    text: string;
    utterance_id: string;
    /** 本句所属的对话回合；装配层用它把 run 结论记回上下文。 */
    turn_id?: string;
  }) => { run_id?: string } | void;
  /**
   * 用户在确认窗口内说「再说一遍」：装配层据此重播**同一条**复述。
   *
   * 传入时已经落库 `repeat_count` 与 `approval.repeat_requested`；这里只负责发声，
   * **不得**重开窗口或推进审批状态。
   */
  onApprovalRepeat?: (approvalId: string, repeatCount: number, maxRepeats: number) => void;
  /** 复述次数用尽：装配层播报「我没有听清，这次没有执行」。 */
  onApprovalUnheard?: (approvalId: string) => void;
  /**
   * 有界对话上下文（GH-12）。用于回合记账与消歧：装配层把上一轮结论作为
   * `RouteContext.previous` 传给 `matchRoute`，并把最近几轮格式化成 Harness 提示块。
   * `matchRoute` 本身仍是纯函数，只读显式传入的 `previous`，不读这个对象。
   */
  conversation?: ConversationContext;
  /** 当前时间；测试可注入假时钟。默认 `() => Date.now()`。 */
  now?: () => number;
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
  /** 面向用户的追问（事件摘要直接用它；与 `run.waiting_input.question` 同名）。 */
  question: string;
  /** 缺失项，如 `capability:robot_stop` / `precondition`。 */
  missing?: string[];
  fast_rule?: string | null;
  /** 结构化原因：开窗原因或窗口收尾原因。 */
  reason?: string;
}

export interface RecordClarificationClosedInput {
  question: string;
  /** 窗口收尾原因，如 `window_expired` / `user_cancelled`。 */
  reason: string;
  session_id?: string;
  /** 用户用于结束澄清的那句话（如「算了」）；给出时落进会话历史。 */
  prompt?: string;
  source?: 'text' | 'asr';
}

/** 一次语音 settle 的输入。判定所需的窗口/回声事实由调用方（事件桥）提供。 */
export interface ApprovalSettleInput {
  approvalId: string;
  /** `speech.final` 的文本（已确认只来自 final）。 */
  text: string;
  utteranceId?: string | null;
  /** 该轮 `speech.started` 的 robotd 时间戳；缺失或早于开窗时刻一律不认。 */
  startedAt?: string | null;
  /** 这一轮是否是机器人自己 TTS 的回声（由事件桥判定，runs 不读 ERLE）。 */
  echo?: boolean;
}

export type ApprovalSettleOutcome = 'approved' | 'denied' | 'repeat' | 'ignored' | 'expired' | 'none';

export interface ApprovalSettleResult {
  outcome: ApprovalSettleOutcome;
  reason?: string;
  approval_id: string;
  run_id: string | null;
  action_label?: string;
  capability?: string;
  args?: Record<string, unknown>;
}

/** 一条 ASR final 的分发输入（由事件桥提供事实，不做意图解析）。 */
export interface UtteranceDispatchInput {
  utterance_id: string;
  text: string;
  /** 事件桥判定的自听（回声）。为 true 时不得建 run，也不得 settle 审批。 */
  echo?: boolean;
  /** 该轮 `speech.started` 的 robotd 时间戳（审批窗口因果判断用）。 */
  started_at?: string | null;
}

export type UtteranceDispatchAction =
  | 'ignored_empty'
  | 'ignored_echo'
  | 'ignored_busy'
  | 'conversation_ended'
  | 'approval'
  | 'submitted'
  | 'submit_failed';

export interface UtteranceDispatchResult {
  action: UtteranceDispatchAction;
  reason?: string;
  /** 走了审批分支时的 settle 结果（approved/denied/ignored/expired/none）。 */
  approval?: ApprovalSettleResult;
  /** 活动 run（busy）或新建 run（submitted）的 id。 */
  run_id?: string;
  /** 本句所属的对话回合（仅当装配层注入了 ConversationContext）。 */
  turn_id?: string;
}

/**
 * 显式结束语：**只认整句完全匹配**，不做子串匹配。
 * 「算了」不建 run——把它送进 Harness 只会让模型去猜。
 */
export const CONVERSATION_END_UTTERANCES: ReadonlySet<string> = new Set([
  '算了',
  '不聊了',
  '结束',
  '不用了',
]);

export class RunService {
  private store: Store;
  private events: EventLog;
  private log: (msg: string, extra?: Record<string, unknown>) => void;
  private onEvent: ((seq: number) => void) | undefined;
  private onTerminal: ((runId: string) => void) | undefined;
  private onCancel: ((runId: string) => void) | undefined;
  private onApprovalRepeat:
    | ((approvalId: string, repeatCount: number, maxRepeats: number) => void)
    | undefined;
  private onApprovalUnheard: ((approvalId: string) => void) | undefined;
  private maxRepeats: number;
  private submitUtterance:
    | ((input: {
        text: string;
        utterance_id: string;
        turn_id?: string;
      }) => { run_id?: string } | void)
    | undefined;
  private conversation: ConversationContext | undefined;
  private clock: () => number;
  /** 确认窗口的过期定时器；unref 过，不拖住进程退出。 */
  private windowTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: RunServiceOptions) {
    this.store = opts.store;
    this.events = opts.events;
    this.log = opts.log;
    this.onEvent = opts.onEvent;
    this.onTerminal = opts.onTerminal;
    this.onCancel = opts.onCancel;
    this.onApprovalRepeat = opts.onApprovalRepeat;
    this.onApprovalUnheard = opts.onApprovalUnheard;
    this.maxRepeats = announceLimits().max_repeats;
    this.submitUtterance = opts.submitUtterance;
    this.conversation = opts.conversation;
    this.clock = opts.now ?? (() => Date.now());
  }

  /** 释放定时器（进程关闭 / 测试结束）。 */
  dispose(): void {
    for (const timer of this.windowTimers.values()) clearTimeout(timer);
    this.windowTimers.clear();
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
    this.notifyTerminal(seq);
  }

  /**
   * 从「已提交的事件」识别 run 终态并回调。
   *
   * 集中在这里而不是散在 transition/cancel/expire/deny/abort 五处：
   * 这些实时终态路径都会先 `events.emit` 再 `notify(seq)`，漏一处就会漏播。
   * 启动对账（`reconcileOnStartup`）**故意不经过这里**：重启时把历史结论念一遍，
   * 会让用户分不清「刚做完」还是「上次没做完的旧账」。
   */
  private notifyTerminal(seq: number): void {
    if (!this.onTerminal) return;
    const row = this.events.get(seq);
    if (!row || typeof row.run_id !== 'string' || !row.run_id) return;
    // run.cancelled 也看一眼：它虽然随后还会写 run.finished，但 cancelled 不播报。
    if (row.type !== 'run.finished' && row.type !== 'run.cancelled') return;
    const run = this.getRunRow(row.run_id);
    if (!run || !isTerminal(run.status) || run.status === 'cancelled') return;
    try {
      this.onTerminal(run.run_id);
    } catch (e: any) {
      this.log('run terminal callback failed', { run_id: run.run_id, error: e.message });
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

  /** 该会话已绑定的 Harness thread；没有则 null。 */
  getSessionThreadId(sessionId: string): string | null {
    const row = this.store.one<{ thread_id: string | null }>(
      'SELECT thread_id FROM sessions WHERE session_id = ?',
      sessionId,
    );
    return row?.thread_id ?? null;
  }

  /**
   * 绑定/解绑会话的 Harness thread。
   *
   * 只改 sessions 表，不写事件：thread_id 是执行器的复用键，不是用户可解释的
   * 业务状态变化；真正需要让用户看见的「重建」由执行器写 run.step_changed。
   */
  setSessionThreadId(sessionId: string, threadId: string | null): void {
    this.store.requireWritable();
    this.store.transaction((tx) => {
      tx.run(
        'UPDATE sessions SET thread_id = ?, updated_at = ? WHERE session_id = ?',
        threadId,
        nowIso(),
        sessionId,
      );
    });
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
        // summary 模板是 `{question}`；reason 是结构化原因，不拿它当问句。
        // 缺失项（capability:... / precondition）是给诊断看的标识符，放 data，不塞进摘要。
        params: {
          question: input.question,
          advice: CLARIFY_ADVICE,
          ...(input.reason ? { reason: input.reason } : {}),
        },
        // reason 同时放进 data：EventView 会原样暴露 data，页面/接口能直接筛「为什么没接上」。
        data: { missing, fast_rule: input.fast_rule ?? null, reason: input.reason ?? null },
      }).seq;
    });
    this.notify(seq);
    return ts;
  }

  /**
   * 记录澄清窗口的收尾原因（GH-49）。
   *
   * 窗口过期、用户说「算了」、被完整新指令顶掉或被 STOP 关闭时，都写一条
   * `route.clarify`；`question` 仍是当时的追问，`reason` 说明为什么没接上。
   * 这不是新的 run，也不占活动名额。
   */
  recordClarificationClosed(input: RecordClarificationClosedInput): string {
    this.store.requireWritable();
    const ts = nowIso();
    const seq = this.store.transaction((tx) => {
      if (input.session_id && input.prompt !== undefined) {
        this.appendMessage(tx, input.session_id, 'user', input.prompt, input.source ?? 'asr', null);
      }
      return this.events.emit(tx, {
        type: 'route.clarify',
        session_id: input.session_id ?? null,
        params: {
          question: input.question,
          reason: input.reason,
          advice: CLARIFY_CLOSE_ADVICE[input.reason] ?? CLARIFY_ADVICE,
        },
        data: { closed: true, reason: input.reason },
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
        summary: run.result_summary ?? null,
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
  transition(
    runId: string,
    next: RunStatus,
    opts: { reason?: string; detail?: string; summary?: string } = {},
  ): void {
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
           updated_at = ?, blocking_reason = ?, result_summary = COALESCE(?, result_summary)
         WHERE run_id = ?`,
        next,
        finished,
        ts,
        opts.reason ?? null,
        opts.summary ?? null,
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
    const cleared: string[] = [];
    const seq = this.store.transaction((tx) => {
      const pending = tx.all<{ approval_id: string; capability: string }>(
        `SELECT approval_id, capability FROM approvals
         WHERE run_id = ? AND status IN ('persisted','announced','waiting')`,
        runId,
      );
      for (const a of pending) {
        cleared.push(a.approval_id);
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
            approval_id: a.approval_id,
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
    for (const id of cleared) this.clearWindowTimer(id);
    this.notify(seq);
    // 状态已是 cancelled 之后才中断执行体：即使 abort 抛错/慢半拍，
    // 终态也不会被覆盖成 failed。取消是安全旁路，不能反过来被执行器劫持。
    this.runCancelHook(runId);
    return { detail: this.getRunDetail(runId), changed: true, voidedApprovals: voided };
  }

  private runCancelHook(runId: string): void {
    if (!this.onCancel) return;
    try {
      this.onCancel(runId);
    } catch (e: any) {
      this.log('run cancel hook failed', { run_id: runId, error: e.message });
    }
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
    // 窗口到点必须**自己失效**：没有语音事件时也要把 run 收尾成 cancelled，
    // 不能等下一句话。settle 仍会再比一次 window_closes_at（防定时器丢失/乱序）。
    this.armWindowTimer(approvalId, windowMs);
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

  // ---------------------------------------------------------------- 语音 settle
  /**
   * 最近一条与语音确认有关的审批。
   *
   * - `waiting`：可以做 settle；
   * - `timeout`（5 分钟内）：迟到的「确认」要留下 `approval.ignored {reason:"expired"}`；
   * - 其它状态（cancelled/denied/approved/persisted…）返回 null：不产生任何判定。
   */
  latestApprovalForVoice(): ApprovalRow | null {
    const a = this.store.one<ApprovalRow>(
      'SELECT * FROM approvals ORDER BY created_at DESC, rowid DESC LIMIT 1',
    );
    if (!a) return null;
    if (a.status === 'waiting') return a;
    if (a.status === 'timeout' && a.decided_at) {
      const age = Date.now() - Date.parse(a.decided_at);
      if (Number.isFinite(age) && age >= 0 && age <= 5 * 60_000) return a;
    }
    return null;
  }

  /**
   * 用一句 `speech.final` settle 一个审批。
   *
   * 顺序（任何一步不通过都**不改状态**，只写 `approval.ignored`）：
   * 过期 → 窗口外开口 → 回声 → 意图判定（否定优先）。
   */
  settleApproval(input: ApprovalSettleInput): ApprovalSettleResult {
    this.store.requireWritable();
    const a = this.getApproval(input.approvalId);
    const base = {
      approval_id: input.approvalId,
      run_id: a?.run_id ?? null,
      action_label: a?.action_label,
    };
    if (!a) return { outcome: 'none', reason: 'not_found', ...base };

    if (a.status === 'timeout') {
      // 过期后的「确认」不能再生效；只有确实想确认/拒绝时才留一条 ignored，
      // 避免窗口结束后每一句闲聊都刷事件。
      if (classifyApprovalUtterance(input.text).intent !== 'none') {
        this.recordIgnored(a, 'expired', input.utteranceId);
      }
      return { outcome: 'ignored', reason: 'expired', ...base };
    }
    if (a.status !== 'waiting') return { outcome: 'none', reason: `approval_${a.status}`, ...base };

    const now = nowIso();
    if (a.window_closes_at && Date.parse(now) >= Date.parse(a.window_closes_at)) {
      this.expireApproval(a.approval_id);
      if (classifyApprovalUtterance(input.text).intent !== 'none') {
        this.recordIgnored(a, 'expired', input.utteranceId);
      }
      return { outcome: 'expired', reason: 'expired', ...base };
    }

    const run = a.run_id ? this.getRunRow(a.run_id) : null;
    if (!run || isTerminal(run.status) || run.status !== 'waiting_confirmation') {
      // run 已经不在这道门上了：不凭一句语音改任何状态。
      return { outcome: 'none', reason: run ? `run_${run.status}` : 'run_missing', ...base };
    }

    const opensAt = a.window_opens_at ? Date.parse(a.window_opens_at) : NaN;
    const startedAt = input.startedAt ? Date.parse(input.startedAt) : NaN;
    if (!Number.isFinite(opensAt) || !Number.isFinite(startedAt) || !(startedAt > opensAt)) {
      this.recordIgnored(a, 'before_window', input.utteranceId);
      return { outcome: 'ignored', reason: 'before_window', ...base };
    }

    if (input.echo === true) {
      this.recordIgnored(a, 'echo', input.utteranceId);
      return { outcome: 'ignored', reason: 'echo', ...base };
    }

    const classified = classifyApprovalUtterance(input.text);
    if (classified.intent === 'none') {
      this.recordIgnored(a, 'unrecognized', input.utteranceId);
      return { outcome: 'ignored', reason: 'unrecognized', ...base };
    }
    if (classified.intent === 'repeat') {
      // 重播不是同意也不是拒绝：窗口有效期、window_opened_at 与审批状态都不动。
      return this.requestApprovalRepeat(a, input.utteranceId);
    }
    return classified.intent === 'deny'
      ? this.resolveDenied(a, input.utteranceId)
      : this.resolveApproved(a, input.utteranceId);
  }

  /**
   * 确认窗口内要求重播。
   *
   * 次数上限是安全边界：无限重播会变成「用户一直没听清、机器人一直问」的死循环。
   * 第 `maxRepeats + 1` 次按「没听清即不执行」收尾，并让装配层播报明确说明。
   */
  private requestApprovalRepeat(a: ApprovalRow, utteranceId?: string | null): ApprovalSettleResult {
    const base = {
      approval_id: a.approval_id,
      run_id: a.run_id,
      action_label: a.action_label,
    };
    const run = a.run_id ? this.getRunRow(a.run_id) : null;
    let count = 0;
    let won = false;
    let seq = 0;
    this.store.transaction((tx) => {
      // 条件更新同时做两件事：占一次重播名额；计数到上限后拒绝再增加。
      won = tx.run(
        `UPDATE approvals SET repeat_count = repeat_count + 1
         WHERE approval_id = ? AND status = 'waiting' AND repeat_count < ?`,
        a.approval_id,
        this.maxRepeats,
      ).changes === 1;
      if (!won) return;
      const row = tx.one<{ repeat_count: number }>(
        'SELECT repeat_count FROM approvals WHERE approval_id = ?',
        a.approval_id,
      );
      count = row?.repeat_count ?? 0;
      seq = this.events.emit(tx, {
        type: 'approval.repeat_requested',
        run_id: a.run_id,
        approval_id: a.approval_id,
        session_id: run?.session_id ?? null,
        params: {
          approval_id: a.approval_id,
          action_label: a.action_label,
          repeat_count: count,
          max_repeats: this.maxRepeats,
          utterance_id: utteranceId ?? undefined,
        },
      }).seq;
    });
    if (!won) {
      // 名额已用尽：按不执行收尾。这里复用 deny 的原子状态迁移，但 reason 如实写 repeat_limit。
      const denied = this.resolveDenied(a, utteranceId, 'repeat_limit');
      if (denied.outcome === 'denied') this.fireUnheard(a.approval_id);
      return denied;
    }
    this.notify(seq);
    this.fireRepeat(a.approval_id, count);
    return { outcome: 'repeat', reason: 'repeat', ...base };
  }

  /** 审批过期：审批 `timeout`、run `cancelled`，并显式写 `approval.expired`。 */
  expireApproval(approvalId: string): { changed: boolean; run_id: string | null } {
    this.store.requireWritable();
    const a = this.getApproval(approvalId);
    if (!a) return { changed: false, run_id: null };
    if (a.status !== 'waiting') return { changed: false, run_id: a.run_id };
    const run = a.run_id ? this.getRunRow(a.run_id) : null;
    const ts = nowIso();
    const seqs: number[] = [];
    let won = false;
    this.store.transaction((tx) => {
      won = tx.run(
        `UPDATE approvals SET status = 'timeout', decided_at = ?, decided_by = 'timeout'
         WHERE approval_id = ? AND status = 'waiting'`,
        ts,
        approvalId,
      ).changes === 1;
      if (!won) return;
      seqs.push(
        this.events.emit(tx, {
          type: 'approval.expired',
          run_id: a.run_id,
          approval_id: approvalId,
          session_id: run?.session_id ?? null,
          params: { approval_id: approvalId, action_label: a.action_label, expired_at: ts },
        }).seq,
      );
      if (run && !isTerminal(run.status)) {
        tx.run(
          `UPDATE runs SET status = 'cancelled', finished_at = ?, updated_at = ?, blocking_reason = 'expired'
           WHERE run_id = ?`,
          ts,
          ts,
          run.run_id,
        );
        seqs.push(
          this.events.emit(tx, {
            type: 'run.finished',
            run_id: run.run_id,
            session_id: run.session_id,
            severity: 'warning',
            params: { outcome: 'cancelled', detail: '确认窗口已过期（expired），没有执行。' },
          }).seq,
        );
      }
    });
    if (!won) return { changed: false, run_id: a.run_id };
    this.clearWindowTimer(approvalId);
    for (const seq of seqs) this.notify(seq);
    return { changed: true, run_id: a.run_id };
  }

  private resolveApproved(a: ApprovalRow, utteranceId?: string | null): ApprovalSettleResult {
    const run = a.run_id ? this.getRunRow(a.run_id) : null;
    if (!run || isTerminal(run.status) || run.status !== 'waiting_confirmation') {
      return { outcome: 'none', reason: run ? `run_${run.status}` : 'run_missing', approval_id: a.approval_id, run_id: a.run_id, action_label: a.action_label };
    }
    const ts = nowIso();
    const seqs: number[] = [];
    let won = false;
    this.store.transaction((tx) => {
      won = tx.run(
        `UPDATE approvals SET status = 'approved', decided_at = ?, decided_by = 'voice'
         WHERE approval_id = ? AND status = 'waiting'`,
        ts,
        a.approval_id,
      ).changes === 1;
      if (!won) return;
      tx.run(
        `UPDATE runs SET status = 'executing', updated_at = ?, blocking_reason = NULL WHERE run_id = ?`,
        ts,
        run.run_id,
      );
      seqs.push(
        this.events.emit(tx, {
          type: 'approval.resolved',
          run_id: run.run_id,
          approval_id: a.approval_id,
          session_id: run.session_id,
          params: {
            approval_id: a.approval_id,
            action_label: a.action_label,
            status: 'approved',
            decided_by: 'voice',
            utterance_id: utteranceId ?? undefined,
          },
        }).seq,
      );
      seqs.push(
        this.events.emit(tx, {
          type: 'run.step_changed',
          run_id: run.run_id,
          session_id: run.session_id,
          params: { step_id: 'phase-executing', step_title: PHASE_LABELS.executing, state: 'active' },
        }).seq,
      );
    });
    if (!won) {
      return { outcome: 'none', reason: 'lost_race', approval_id: a.approval_id, run_id: a.run_id, action_label: a.action_label };
    }
    this.clearWindowTimer(a.approval_id);
    for (const seq of seqs) this.notify(seq);
    return {
      outcome: 'approved',
      approval_id: a.approval_id,
      run_id: run.run_id,
      action_label: a.action_label,
      capability: a.capability,
      args: loadJson<Record<string, unknown>>(a.args_json, {}),
    };
  }

  private resolveDenied(
    a: ApprovalRow,
    utteranceId?: string | null,
    reason: string = 'denied',
  ): ApprovalSettleResult {
    const run = a.run_id ? this.getRunRow(a.run_id) : null;
    const ts = nowIso();
    const seqs: number[] = [];
    let won = false;
    this.store.transaction((tx) => {
      won = tx.run(
        `UPDATE approvals SET status = 'denied', decided_at = ?, decided_by = 'voice'
         WHERE approval_id = ? AND status = 'waiting'`,
        ts,
        a.approval_id,
      ).changes === 1;
      if (!won) return;
      if (run && !isTerminal(run.status)) {
        tx.run(
          `UPDATE runs SET status = 'cancelled', finished_at = ?, updated_at = ?, blocking_reason = ?
           WHERE run_id = ?`,
          ts,
          ts,
          reason,
          run.run_id,
        );
      }
      seqs.push(
        this.events.emit(tx, {
          type: 'approval.resolved',
          run_id: a.run_id,
          approval_id: a.approval_id,
          session_id: run?.session_id ?? null,
          params: {
            approval_id: a.approval_id,
            action_label: a.action_label,
            status: 'denied',
            decided_by: 'voice',
            utterance_id: utteranceId ?? undefined,
            reason,
          },
        }).seq,
      );
      if (run && !isTerminal(run.status)) {
        seqs.push(
          this.events.emit(tx, {
            type: 'run.finished',
            run_id: run.run_id,
            session_id: run.session_id,
            severity: 'warning',
            params: {
              outcome: 'cancelled',
              detail:
                reason === 'repeat_limit'
                  ? '连续多次没有听清（repeat_limit），这次没有执行。'
                  : '用户拒绝（denied），没有执行。',
            },
          }).seq,
        );
      }
    });
    if (!won) {
      return { outcome: 'none', reason: 'lost_race', approval_id: a.approval_id, run_id: a.run_id, action_label: a.action_label };
    }
    this.clearWindowTimer(a.approval_id);
    for (const seq of seqs) this.notify(seq);
    return { outcome: 'denied', reason, approval_id: a.approval_id, run_id: a.run_id, action_label: a.action_label };
  }

  /** 记一条 `approval.ignored`；**不改任何状态**。 */
  private recordIgnored(a: ApprovalRow, reason: string, utteranceId?: string | null): void {
    try {
      const res = this.events.emitStandalone({
        type: 'approval.ignored',
        run_id: a.run_id,
        approval_id: a.approval_id,
        session_id: null,
        params: {
          approval_id: a.approval_id,
          reason,
          utterance_id: utteranceId ?? undefined,
        },
      });
      this.notify(res.seq);
    } catch (e: any) {
      this.log('写 approval.ignored 失败', { approval_id: a.approval_id, reason, error: e.message });
    }
  }

  private fireRepeat(approvalId: string, repeatCount: number): void {
    if (!this.onApprovalRepeat) return;
    try {
      this.onApprovalRepeat(approvalId, repeatCount, this.maxRepeats);
    } catch (e: any) {
      this.log('重播回调失败', { approval_id: approvalId, error: e.message });
    }
  }

  private fireUnheard(approvalId: string): void {
    if (!this.onApprovalUnheard) return;
    try {
      this.onApprovalUnheard(approvalId);
    } catch (e: any) {
      this.log('没听清收尾播报回调失败', { approval_id: approvalId, error: e.message });
    }
  }

  private armWindowTimer(approvalId: string, windowMs: number): void {
    this.clearWindowTimer(approvalId);
    const timer = setTimeout(() => {
      this.windowTimers.delete(approvalId);
      try {
        this.expireApproval(approvalId);
      } catch (e: any) {
        this.log('确认窗口过期收尾失败', { approval_id: approvalId, error: e.message });
      }
    }, Math.max(0, windowMs));
    (timer as { unref?: () => void }).unref?.();
    this.windowTimers.set(approvalId, timer);
  }

  private clearWindowTimer(approvalId: string): void {
    const timer = this.windowTimers.get(approvalId);
    if (!timer) return;
    clearTimeout(timer);
    this.windowTimers.delete(approvalId);
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
              approval_id: approvalId,
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
            params: { approval_id: approvalId, reason, kind: opts.kind ?? 'no_audio' },
          }).seq,
        );
      }
    });
    if (!won) {
      const fresh = this.getApproval(approvalId);
      return { changed: false, reason: fresh ? `approval_${fresh.status}` : 'not_found', run_id: a.run_id };
    }
    this.clearWindowTimer(approvalId);
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
   * 按 robotd 任务 ID 找回对应 run（安全停止归属用，GH-57）。
   *
   * 不按「当前活动 run」猜：语音「停」本身也会建一个 run，猜活动 run 会把
   * 停止指令自己的 run 取消掉。只有 robotd 明确给出被停止的 task_id 时才能归属。
   */
  findRunByRobotTask(robotTaskId: string): { run_id: string; status: string } | null {
    return this.store.one<{ run_id: string; status: string }>(
      `SELECT r.run_id, r.status
         FROM runs r
         JOIN tool_calls c ON c.run_id = r.run_id
        WHERE c.robot_task_id = ?
        ORDER BY c.rowid DESC
        LIMIT 1`,
      robotTaskId,
    );
  }

  // ---------------------------------------------------------------- 语音分发
  /**
   * 一条 ASR final 该不该变成一次 run（#13 验收判据 7/8，口径见 #7）。
   *
   * 固定顺序，**不许改**：
   * 0. 空文本 / 回声：只记 `observation.speech_ignored`，不建 run、不 settle 审批
   *    （自听可能包含「确认」，拿去 settle 等于让机器人批准自己念的内容）；
   * 1. 有 `waiting_confirmation` 窗口：这是回答，交给 settle 并**吞掉**这条 final；
   * 2. 有活动 run：记 `observation.speech_ignored {reason:"busy"}`，不排队、不建 run；
   * 3. 兜底：交给装配层注入的 `submitUtterance`（走 `submitRunRequest`，与
   *    `POST /api/run` 同一条路由/审批/幂等路径）。
   *
   * 先建 run 再问审批，会把「确认」当成一次新指令再执行一遍。
   */
  dispatchUtterance(input: UtteranceDispatchInput): UtteranceDispatchResult {
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text) {
      this.recordSpeechIgnored('empty', input.utterance_id);
      return { action: 'ignored_empty', reason: 'empty' };
    }
    if (input.echo === true) {
      this.recordSpeechIgnored('echo', input.utterance_id);
      return { action: 'ignored_echo', reason: 'echo' };
    }

    // 1. 审批优先：窗口开着时，这句话是回答，不是新指令。
    const approval = this.latestApprovalForVoice();
    if (approval && approval.status === 'waiting') {
      const settled = this.settleApproval({
        approvalId: approval.approval_id,
        text,
        utteranceId: input.utterance_id,
        startedAt: input.started_at ?? null,
        // 回声已在上面拦掉；走到这里的事实是「不是自听」。
        echo: false,
      });
      return { action: 'approval', approval: settled, run_id: settled.run_id ?? undefined };
    }

    // 窗口刚过期（`latestApprovalForVoice` 只回 5 分钟内的 timeout）：迟到的「确认」
    // 必须留下 `approval.ignored {reason:"expired"}` 的账，而不是被当成一条新指令。
    // 但**只吞下确实像审批回答的那一句**——过期之后的普通指令照常提交，不能被一个
    // 已经死掉的窗口堵住 5 分钟；「停」是安全旁路，任何时候都不当审批回答。
    // 窗口还开着时上一条分支已经接管，走不到这里。
    if (
      approval &&
      approval.status === 'timeout' &&
      !isProtectedUtterance(text) &&
      classifyApprovalUtterance(text).intent !== 'none'
    ) {
      const settled = this.settleApproval({
        approvalId: approval.approval_id,
        text,
        utteranceId: input.utterance_id,
        startedAt: input.started_at ?? null,
        echo: false,
      });
      return { action: 'approval', approval: settled, run_id: settled.run_id ?? undefined };
    }

    // 1.5 对话回合（GH-12）：审批之后。显式结束先处理；其余**只做只读探测**——
    //     被「忙/空」吞掉的句子没有变成 run，就不能计数，更不能写「接上了上一句」。
    //     真正的记账挪到忙判定通过、确定要提交之后（见下面的 advance()）。
    //     上下文只影响消歧性规则的命中与 Harness 提示块；matchRoute 仍是纯函数，
    //     只读装配层显式传入的 previous。
    let probe: ConversationPeek | null = null;
    if (this.conversation) {
      if (CONVERSATION_END_UTTERANCES.has(text)) {
        // 显式结束：清空并开新回合。这句本身不建 run。
        this.conversation.reset(this.clock());
        this.emitConversationEvent('conversation.turn_reset', { reason: 'user_ended' });
        return { action: 'conversation_ended', reason: 'user_ended' };
      }
      probe = this.conversation.peek(this.clock());
    }

    // 2. 忙：语音侧不排队，也不静默丢弃。
    //    例外是受保护规则（停止）：停止是安全旁路，语音不能比 POST /api/run 更弱。
    const busy = this.activeRun();
    if (busy && !isProtectedUtterance(text)) {
      this.recordSpeechIgnored('busy', input.utterance_id, busy.run_id);
      // 这句没有建 run：不记账、不写 conversation.* 事件；turn_id 只是只读探测的归属线索。
      return { action: 'ignored_busy', reason: 'busy', run_id: busy.run_id, turn_id: probe?.turn_id ?? undefined };
    }

    // 3. 兜底：真正的路由在 submitRunRequest；这里只负责「该提交了」。
    if (!this.submitUtterance) {
      return { action: 'submit_failed', reason: 'no_submitter' };
    }
    // 到这里才确定这句话要变成一次 run，开始回合记账。
    const turn = this.conversation ? this.conversation.advance(this.clock()) : undefined;
    const turnId = turn?.turn_id;
    try {
      const res = this.submitUtterance({ text, utterance_id: input.utterance_id, turn_id: turnId });
      if (turn && !res?.run_id) {
        // 提交入口没给出 run_id（没建成 run）：退回这一句的计数，别在时间线上留下影子。
        this.conversation?.release(turn);
      } else if (turn) {
        this.recordTurn(turn);
      }
      return { action: 'submitted', run_id: res?.run_id, turn_id: turnId };
    } catch (e: any) {
      // 竞态：判定空闲之后、提交之前刚好有 run 变活动。按忙处理，不把异常丢给事件桥。
      if (e?.code === 'E_BUSY') {
        if (turn) this.conversation?.release(turn);
        const active = this.activeRun();
        this.recordSpeechIgnored('busy', input.utterance_id, active?.run_id);
        return { action: 'ignored_busy', reason: 'busy', run_id: active?.run_id, turn_id: probe?.turn_id ?? undefined };
      }
      if (turn) this.conversation?.release(turn);
      this.log('语音提交失败', { utterance_id: input.utterance_id, error: e?.message ?? String(e) });
      return { action: 'submit_failed', reason: 'submit_error' };
    }
  }

  /**
   * 一句真的变成 run 之后才写回合事件。
   *
   * `turn_joined` 只在**真的接上了上一句**（`index ≥ 2`）时写——事件名说的就是
   * 「接上了」，第一句没有可接的东西。`index` 是本回合第几句（1 起），只有计数、没有文本。
   */
  private recordTurn(turn: ConversationAttribution): void {
    // 过期/满员时 advance 已经开了新回合；单独记一条原因，惰性判定不设定时器。
    if (turn.reset) {
      this.emitConversationEvent('conversation.turn_reset', { reason: turn.reset });
    }
    if (turn.joined) {
      this.emitConversationEvent('conversation.turn_joined', {
        turn_id: turn.turn_id,
        index: turn.index,
      });
    }
  }

  /**
   * 记一条 conversation.* 事件。参数只有 turn_id / index / reason；
   * 用户原文不进事件库（隐私红线见 events.json 的 forbidden_payload_keys）。
   */
  private emitConversationEvent(
    type: 'conversation.turn_joined' | 'conversation.turn_reset',
    params: Record<string, unknown>,
  ): void {
    try {
      const res = this.events.emitStandalone({ type, params });
      this.notify(res.seq);
    } catch (e: any) {
      this.log('写会话回合事件失败', { type, error: e?.message ?? String(e) });
    }
  }

  /** 记一条 `observation.speech_ignored`；不改任何 run 状态。 */
  private recordSpeechIgnored(
    reason: 'busy' | 'echo' | 'empty',
    utteranceId?: string,
    runId?: string,
  ): void {
    try {
      const res = this.events.emitStandalone({
        type: 'observation.speech_ignored',
        run_id: runId ?? null,
        params: {
          reason,
          utterance_id: utteranceId ? utteranceId : undefined,
        },
      });
      this.notify(res.seq);
    } catch (e: any) {
      this.log('写 observation.speech_ignored 失败', {
        reason,
        utterance_id: utteranceId,
        error: e?.message ?? String(e),
      });
    }
  }

  // ---------------------------------------------------------------- 结论播报
  /**
   * 原子认领「这个 run 要播报一次」。
   *
   * 幂等键就是 run_id：`narration_requested_at` 为 NULL 时才认领成功，
   * 并发/重放/进程重启后的再次触发都会拿到 false，因此至多播一次。
   * `cancelled` 的 run 不播报（停止是安全旁路，见 RunServiceOptions.onTerminal）。
   */
  claimNarrationAttempt(runId: string): boolean {
    this.store.requireWritable();
    const run = this.getRunRow(runId);
    if (!run || !isTerminal(run.status) || run.status === 'cancelled') return false;
    const ts = nowIso();
    return this.store.transaction((tx) => {
      const res = tx.run(
        `UPDATE runs SET narration_requested_at = ?, updated_at = ?
         WHERE run_id = ? AND narration_requested_at IS NULL`,
        ts,
        ts,
        runId,
      );
      return res.changes === 1;
    });
  }

  /** 记录播报结果。**只写 narration，不改 run.status**。 */
  setNarration(runId: string, outcome: NarrationOutcome): void {
    this.store.requireWritable();
    this.store.transaction((tx) => {
      tx.run(
        'UPDATE runs SET narration = ?, updated_at = ? WHERE run_id = ?',
        outcome,
        nowIso(),
        runId,
      );
    });
  }

  /**
   * 崩溃恢复对账。
   *
   * 进程重启后，数据库里可能躺着 `executing` 的 run——它对应的 Harness 子进程
   * 已经没了。这类 run 不能装作还在跑：一律标为 `interrupted`，
   * 并明确写出「不确定是否执行过」，让人去看而不是自动重试。
   */
  reconcileOnStartup(): { interrupted: number; details: string[]; cancelledApprovals: number } {
    const ts = nowIso();
    // 进程重启后，内存里的确认窗口定时器已经不存在了：残留的审批不可能再被
    // 合法 settle，一律作废。不能让它们停在 persisted/announced/waiting 上，
    // 否则界面会显示一个永远等不到的「等待确认」。
    const stale = this.store.all<{ approval_id: string; run_id: string | null; action_label: string }>(
      `SELECT approval_id, run_id, action_label FROM approvals
       WHERE status IN ('persisted','announced','waiting')`,
    );
    if (stale.length > 0) {
      this.store.transaction((tx) => {
        for (const a of stale) {
          tx.run(
            `UPDATE approvals SET status = 'cancelled', decided_at = ?, decided_by = 'system'
             WHERE approval_id = ?`,
            ts,
            a.approval_id,
          );
          this.events.emit(tx, {
            type: 'approval.resolved',
            run_id: a.run_id,
            approval_id: a.approval_id,
            params: {
              approval_id: a.approval_id,
              action_label: a.action_label,
              status: 'cancelled',
              decided_by: 'system',
            },
          });
        }
      });
    }
    const placeholders = RUN_STATUSES.filter((s) => !isTerminal(s)).map(() => '?').join(',');
    const stuck = this.store.all<RunRow>(
      `SELECT * FROM runs WHERE status IN (${placeholders}) ORDER BY rowid ASC`,
      ...RUN_STATUSES.filter((s) => !isTerminal(s)),
    );
    if (stuck.length === 0) {
      this.log('startup reconciliation', { interrupted: 0, details: [], cancelledApprovals: stale.length });
      return { interrupted: 0, details: [], cancelledApprovals: stale.length };
    }

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
    this.log('startup reconciliation', { interrupted, details, cancelledApprovals: stale.length });
    return { interrupted, details, cancelledApprovals: stale.length };
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
    // `approvalParams` 是这次调用实际绑定的审批参数字段；`[]`（或缺省）表示没有绑定。
    // 持久化列仍叫 `requires_approval`（布尔），语义是「本次调用是否绑定了审批参数」。
    opts: {
      args?: Record<string, unknown>;
      approvalParams?: string[];
      approvalId?: string | null;
      toolCallId?: string;
      robotTaskId?: string | null;
    } = {},
  ): string {
    const cid = opts.toolCallId ?? newId('call');
    const gated = Boolean(opts.approvalId) || Boolean(opts.approvalParams && opts.approvalParams.length > 0);
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
      gated ? 1 : 0,
      opts.approvalId ?? null,
      opts.robotTaskId ?? null,
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

/** 窗口收尾时的建议：说明这句话为什么没有接上。 */
const CLARIFY_CLOSE_ADVICE: Record<string, string> = {
  window_expired: '超过等待时间，这句话没有和上一句拼接。',
  user_cancelled: '已取消这次补充。',
  prompt_too_long: '拼接后的句子太长，已重新问。',
  stop: '收到停止指令，澄清窗口已关闭。',
  superseded: '这句话是完整指令，已按新指令处理。',
};

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
