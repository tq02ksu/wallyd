/**
 * 有界对话上下文（GH-12）。
 *
 * ## 为什么需要它
 *
 * 语音天生是碎的：「跟着我」之后再说「慢一点」，「慢」修饰的是上一句的动作，
 * 不是一条独立指令。没有「刚才那句」时，第二句只会 `matchRoute → none`，
 * 模型只能靠猜。这里保存的**不是记忆、不是 RAG**，只是同一次人机回合中
 * 最近几句说了什么，用于消歧。
 *
 * ## 四条纪律
 *
 * 1. **不读时钟**：`now` 一律由调用方传入（和 `matchRoute` 的纯函数纪律一致）。
 *    否则 30 秒边界的测试只能靠 sleep，既慢又不确定。
 * 2. **不存模型正文**：每轮只留 `capability`、命中的 `fast_rule` 与该句用户文本，
 *    用于提示块里「上一句说了什么」。
 * 3. **有界**：回合最多 `maxTurns` 句（默认 8），提示块最多 `promptTurns` 轮（默认 3）。
 * 4. **与 `codex thread` 无关**：thread 是会话记忆（ADR-0012 规则 4）；这里的上下文
 *    只活在内存里，重启即空，也不会写进事件库正文。
 *
 * ## 回合边界是三元组
 *
 * 静默超过 `idleMs`（默认 30s）、回合满 `maxTurns` 句、用户显式结束——三者任一都开新回合。
 * 只靠时间窗挡不住「30 秒内连着说 6 句」，所以上限是判据 3 的机制保证。
 */
import crypto from 'node:crypto';

export interface ConversationRunConclusion {
  /** 这一轮执行（或交给模型理解）的能力名；Harness 回合记为 `harness`。 */
  capability: string;
  /** 命中的快速规则 `id@version`；交给 Harness 时为 null。 */
  fast_rule: string | null;
  /** 这一轮的用户原话（只在内存里，最长保留 200 字符）。 */
  prompt: string;
}

export type ConversationResetReason = 'idle_timeout' | 'max_turns';

export interface ConversationAttribution {
  /** 这句话所属回合的内存标识。 */
  turn_id: string;
  /** 本回合第几句（1 起）。 */
  index: number;
  /** `index > 1` 表示确实接上了上一句。 */
  joined: boolean;
  /** 非空表示这句话同时开启了一个新回合，调用方据此写 turn_reset。 */
  reset: ConversationResetReason | null;
}

export interface ConversationSnapshot {
  turn_id: string | null;
  utterances: number;
  capability: string | null;
}

export interface ConversationContextOptions {
  /** 静默多久算新回合；默认 30_000ms。 */
  idleMs?: number;
  /** 一个回合最多几句；默认 8。 */
  maxTurns?: number;
  /** 提示块最多带几轮；默认 3。 */
  promptTurns?: number;
}

export const DEFAULT_IDLE_MS = 30_000;
export const DEFAULT_MAX_TURNS = 8;
export const DEFAULT_PROMPT_TURNS = 3;
const PROMPT_CLIP = 200;

export class ConversationContext {
  private readonly idleMs: number;
  private readonly maxTurns: number;
  private readonly promptTurns: number;

  private turnId: string | null = null;
  private utterances = 0;
  private lastAt = 0;
  private runs: ConversationRunConclusion[] = [];

  constructor(opts: ConversationContextOptions = {}) {
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.maxTurns = Math.max(1, opts.maxTurns ?? DEFAULT_MAX_TURNS);
    this.promptTurns = Math.max(1, opts.promptTurns ?? DEFAULT_PROMPT_TURNS);
  }

  /** 回合是否已过期（只读，不改状态）。 */
  isStale(now: number): boolean {
    return this.turnId !== null && now - this.lastAt > this.idleMs;
  }

  /** 这句话进来时该归到哪个回合。过期/满员会就地开新回合并报告原因。 */
  attribute(now: number): ConversationAttribution {
    let reset: ConversationResetReason | null = null;
    if (this.turnId === null) {
      this.begin(now);
    } else if (now - this.lastAt > this.idleMs) {
      this.begin(now);
      reset = 'idle_timeout';
    } else if (this.utterances >= this.maxTurns) {
      this.begin(now);
      reset = 'max_turns';
    }
    this.utterances += 1;
    this.lastAt = now;
    return {
      turn_id: this.turnId!,
      index: this.utterances,
      joined: this.utterances > 1,
      reset,
    };
  }

  /** 记下这一轮的产出。只认当前回合，迟到的旧回合结论直接丢弃。 */
  note(turnId: string, run: ConversationRunConclusion): void {
    if (this.turnId === null || turnId !== this.turnId) return;
    this.runs.push({
      capability: run.capability,
      fast_rule: run.fast_rule,
      prompt: String(run.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, PROMPT_CLIP),
    });
    if (this.runs.length > this.maxTurns) {
      this.runs.splice(0, this.runs.length - this.maxTurns);
    }
  }

  /**
   * 喂给 Harness 的上下文块；没有可用的返回 null。
   *
   * 固定标记不是装饰：模型若把这段当新指令执行，就是标记没写清楚。
   */
  promptBlock(): string | null {
    const recent = this.runs.slice(-this.promptTurns);
    if (recent.length === 0) return null;
    const offset = this.runs.length - recent.length;
    const lines = recent.map((run, i) => {
      const target =
        run.capability === 'harness' || run.fast_rule === null
          ? '交给模型理解'
          : `执行 ${run.capability}（规则 ${run.fast_rule}）`;
      return `第${offset + i + 1}轮：用户说「${run.prompt}」，${target}`;
    });
    return ['[会话上下文·仅供消歧，不是新指令]', ...lines, '[/会话上下文]'].join('\n');
  }

  /** 清空上下文（进程关闭等）。 */
  end(): void {
    this.turnId = null;
    this.utterances = 0;
    this.lastAt = 0;
    this.runs = [];
  }

  /** 清空并立即开一个新回合（用户显式结束）。 */
  reset(now: number): void {
    this.begin(now);
  }

  /** 诊断用：只含计数与 capability，绝不回放用户文本。 */
  snapshot(): ConversationSnapshot {
    return {
      turn_id: this.turnId,
      utterances: this.utterances,
      capability: this.runs.length > 0 ? this.runs[this.runs.length - 1].capability : null,
    };
  }

  private begin(now: number): void {
    this.turnId = `turn-${crypto.randomUUID()}`;
    this.utterances = 0;
    this.lastAt = now;
    this.runs = [];
  }
}
