/**
 * run 结论 → robotd 播报（GH-13）。
 *
 * ## 为什么单独一层
 *
 * run 的终态、事件库与 robotd 播报是三件事，装配层不应该把它们的顺序写死在
 * HTTP handler 里。这里只做三件确定的事：
 *
 * 1. 从**执行事实**（`result_summary` → 最后一步 `note` → 兜底短语）组一句话，
 *    **绝不念 prompt 或模型推理正文**；
 * 2. 播报前用 `noteSpeak(task_id, text)` 留底——robotd 的播报事件只带 task_id，
 *    不带文本；
 * 3. 把 `tts_finished` / `tts_cancelled` 关联回 run 的 `narration` 字段。
 *
 * ## 打断不是失败
 *
 * barge-in 产生的 `speech.tts_cancelled {reason:"barge_in"}` 只说明「话没说完」。
 * run 已经执行完了，所以这里**只写 narration=interrupted，永不改 run.status**。
 * 同理，robotd 不可达只记 `speech.speak_failed`，run 仍然 succeeded。
 *
 * ## 至多一次
 *
 * 幂等键是 run_id：`RunService.claimNarrationAttempt()` 用
 * `narration_requested_at IS NULL` 做原子认领，重放/并发都只有赢家会调用 speak。
 */
import type { EventLog } from './events.ts';
import type { NarrationOutcome, RunService } from './runs.ts';

/** 契约 `SpeakRequest.text.maxLength`。超长必须截断，不能 400 让用户什么都听不到。 */
export const SPEAK_MAX_CHARS = 500;
/** 截断标记：明确告诉用户「后面略」，而不是假装说完了。 */
export const SPEAK_TRUNCATION_SUFFIX = '…后面略';

export interface NarrationRobotd {
  speak(input: { text: string }): Promise<{ task_id: string | null }>;
}

export interface RunNarratorDeps {
  runs: RunService;
  robotd: NarrationRobotd;
  events: EventLog;
  noteSpeak: (taskId: string, text: string, runId?: string) => void;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  maxChars?: number;
}

export interface NarrationResult {
  ok: boolean;
  reason?: string;
  text?: string;
  task_id?: string | null;
}

/** 组播报正文所需的 run 事实；结构类型，便于单测直接构造。 */
export interface NarrationRunFacts {
  status: string;
  blocking_reason: string | null;
  result_summary: string | null;
}

export interface NarrationStepFacts {
  note: string | null;
}

/**
 * 结论正文。优先级：`result_summary` → 最后一步非空 `note` → 兜底短语。
 *
 * 兜底必须诚实：失败说失败，绝不说「完成了」。
 */
export function composeNarrationText(run: NarrationRunFacts, steps: readonly NarrationStepFacts[]): string {
  const summary = normalize(run.result_summary);
  if (summary) return summary;

  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const note = normalize(steps[i]?.note ?? null);
    if (note) return note;
  }
  return fallbackPhrase(run);
}

function fallbackPhrase(run: NarrationRunFacts): string {
  const reason = normalize(run.blocking_reason);
  switch (run.status) {
    case 'succeeded':
      return '做完了';
    case 'failed':
      return reason ? `没做成，原因：${reason}` : '没做成，执行失败了';
    case 'interrupted':
      return '没做成，任务中断了';
    case 'outcome_unknown':
      return '动作已经发出，但结果没确认';
    default:
      return '任务已结束';
  }
}

/** 按 Unicode 码点截断到 `maxChars` 以内，并在末尾说明「后面略」。 */
export function truncateForSpeech(text: string, maxChars = SPEAK_MAX_CHARS): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  const suffix = Array.from(SPEAK_TRUNCATION_SUFFIX);
  const cut = Math.max(0, maxChars - suffix.length);
  return `${chars.slice(0, cut).join('')}${SPEAK_TRUNCATION_SUFFIX}`;
}

function normalize(text: string | null | undefined): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

export class RunNarrator {
  private runs: RunService;
  private robotd: NarrationRobotd;
  private events: EventLog;
  private noteSpeak: (taskId: string, text: string, runId?: string) => void;
  private log: (msg: string, extra?: Record<string, unknown>) => void;
  private maxChars: number;
  /** task_id → run_id：把播报终态事件关联回 run。 */
  private pending = new Map<string, string>();

  constructor(deps: RunNarratorDeps) {
    this.runs = deps.runs;
    this.robotd = deps.robotd;
    this.events = deps.events;
    this.noteSpeak = deps.noteSpeak;
    this.log = deps.log;
    this.maxChars = deps.maxChars ?? SPEAK_MAX_CHARS;
  }

  /** 播报一个已终结的 run。重复调用只会成功一次。 */
  async narrate(runId: string): Promise<NarrationResult> {
    const run = this.runs.getRunRow(runId);
    if (!run) return { ok: false, reason: 'not_found' };
    if (run.status === 'cancelled') return { ok: false, reason: 'cancelled' };
    if (!this.runs.claimNarrationAttempt(runId)) {
      return { ok: false, reason: 'already_narrated' };
    }

    let steps: NarrationStepFacts[] = [];
    try {
      const detail = this.runs.getRunDetail(runId);
      steps = (detail.steps as NarrationStepFacts[] | undefined) ?? [];
    } catch (e: any) {
      // 读步骤失败不阻断播报：回落到兜底短语，至少让用户知道结果。
      this.log('读取 run 步骤失败，播报回落到兜底短语', { run_id: runId, error: e?.message });
    }

    const text = truncateForSpeech(composeNarrationText(run, steps), this.maxChars);
    try {
      const accepted = await this.robotd.speak({ text });
      const taskId = accepted?.task_id ?? null;
      if (taskId) {
        this.rememberPending(taskId, runId);
        // 播报前留底：robotd 的事件只有 task_id，没有文本。
        this.noteSpeak(taskId, text, runId);
      }
      return { ok: true, text, task_id: taskId };
    } catch (e: any) {
      const reason = typeof e?.code === 'string' && e.code ? e.code : 'unavailable';
      const detail = e?.message ? String(e.message) : String(e);
      this.log('结论播报请求失败', { run_id: runId, reason, detail });
      // robotd 不可达 / 拒绝播报 ≠ 任务没做成：run 状态保持不变。
      this.runs.setNarration(runId, 'failed');
      this.emitFailed(runId, reason, detail);
      return { ok: false, reason, text };
    }
  }

  /**
   * 播报真实终态（由事件桥在 `tts_finished` / `tts_cancelled` 时回调）。
   *
   * `ok:false` 只写 `narration=interrupted`。**这里没有改 run.status 的代码路径**，
   * 所以 barge-in 不可能把 run 标成 failed。
   */
  onSpeechOutcome(input: { task_id?: string; ok: boolean; reason?: string }): void {
    if (!input.task_id) return;
    const runId = this.pending.get(input.task_id);
    if (!runId) return;
    this.pending.delete(input.task_id);
    const outcome: NarrationOutcome = input.ok ? 'spoken' : 'interrupted';
    this.runs.setNarration(runId, outcome);
    if (!input.ok) {
      this.log('结论播报被打断，run 状态不变', { run_id: runId, reason: input.reason ?? 'interrupted' });
    }
  }

  private rememberPending(taskId: string, runId: string): void {
    this.pending.set(taskId, runId);
    if (this.pending.size > 200) {
      const first = this.pending.keys().next().value;
      if (first !== undefined) this.pending.delete(first);
    }
  }

  private emitFailed(runId: string, reason: string, detail: string): void {
    if (!this.events.isRegistered('speech.speak_failed')) {
      this.log('speech.speak_failed 未登记，拒绝写入', { run_id: runId });
      return;
    }
    try {
      this.events.emitStandalone({
        type: 'speech.speak_failed',
        run_id: runId,
        params: { reason, detail },
      });
    } catch (e: any) {
      this.log('写 speech.speak_failed 失败', { run_id: runId, error: e?.message });
    }
  }
}
