/**
 * 「等待补充」窗口（GH-49）。
 *
 * 澄清不建 run（GH-27），但用户补的那一句需要一个有界的落点。这里只保存**最近一次**
 * 澄清的内存状态，默认 30s；它不是 run，不占活动名额，也不写 `runs` 表。
 *
 * 纪律：
 * - 一个窗口最多拼接一次；拼接后仍缺参就重新问，开一个新窗口；
 * - 过期由读取方判定（`peek()`），这样单测可以注入时钟，不依赖真实 sleep；
 * - 这里不读文件、不读环境变量、不发网络请求。
 */

export type ClarificationReason =
  | 'missing_arguments'
  | 'capability_unavailable'
  | 'precondition'
  | 'ambiguous';

/** 窗口被丢弃/消费的原因；写进 `route.clarify.reason`，便于事后查账。 */
export type ClarificationCloseReason =
  | 'window_expired'
  | 'user_cancelled'
  | 'prompt_too_long'
  | 'stop'
  | 'superseded';

export interface PendingClarification {
  /** 澄清前那句话（拼接的左侧）。 */
  prompt: string;
  /** 面向用户的追问，事件与播报共用同一份来源。 */
  question: string;
  reason: ClarificationReason;
  /** 事件里的缺失项（诊断用，如 `slot:target_track_id`）。 */
  missing: string[];
  /** 播报用的结构化参数字段名（如 `target_track_id`）。 */
  announce_missing: string[];
  /** 歧义候选的规则摘要（已按播报上限截断）。 */
  candidates: string[];
  /** 候选还有「别的」。 */
  more: boolean;
  /** 命中规则的摘要；歧义时为空。 */
  action_label: string | null;
  fast_rule: string | null;
  session_id?: string;
  source?: 'text' | 'asr';
  opened_at: number;
  expires_at: number;
}

export type ClarificationPeek =
  | { status: 'none' }
  | { status: 'fresh'; pending: PendingClarification }
  | { status: 'expired'; pending: PendingClarification };

export const DEFAULT_CLARIFICATION_WINDOW_MS = 30_000;

export class ClarificationWindow {
  private pending: PendingClarification | null = null;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: { windowMs?: number; now?: () => number } = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_CLARIFICATION_WINDOW_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 开窗；新澄清覆盖旧窗口（同一时刻只接一句补充）。 */
  open(input: Omit<PendingClarification, 'opened_at' | 'expires_at'>): PendingClarification {
    const opened_at = this.now();
    const pending: PendingClarification = {
      ...input,
      opened_at,
      expires_at: opened_at + this.windowMs,
    };
    this.pending = pending;
    return pending;
  }

  /** 读窗口但不消费。过期窗口会以 `expired` 返回，由调用方记收尾原因。 */
  peek(): ClarificationPeek {
    if (!this.pending) return { status: 'none' };
    if (this.now() >= this.pending.expires_at) {
      return { status: 'expired', pending: this.pending };
    }
    return { status: 'fresh', pending: this.pending };
  }

  /** 清空窗口（消费或丢弃）。返回被清掉的窗口，便于记收尾原因。 */
  clear(): PendingClarification | null {
    const pending = this.pending;
    this.pending = null;
    return pending;
  }

  /** 当前窗口（不判过期，供测试/诊断）。 */
  current(): PendingClarification | null {
    return this.pending;
  }
}
