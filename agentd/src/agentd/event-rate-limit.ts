/**
 * 事件频率上限（契约声明，运行时执行）。
 *
 * 为什么放在事件入口而不是发布端：`person.moved` 的未来发布方是 robotd 的跟踪实现，
 * 而 agentd 是**事件库**。同一份上限必须对「任何来源、任何实现」一致，
 * 所以上限写在 `agentd/contracts/events.json`，由 `EventLog.emit` 的单一入口执行。
 *
 * 语义（契约 `rate_limit.excess`）：超出上限的观测**直接丢弃**，不排队、不补发。
 * 位置流是「最新值有用」而不是「每条都必须送达」；补发只会把事件库撑大，
 * 且旧位置对新位置没有价值。这是降频，不是状态迁移。
 */

export interface RateLimitSpec {
  /** 任意一个 window_ms 窗口内允许的最大条数。 */
  max_hz?: number;
  /** 滑窗长度；缺省 1000ms。 */
  window_ms?: number;
  /** 以 payload 里的哪个字段做计数键（如 track_id）；缺省为全局单键。 */
  key_field?: string;
  /** 超出上限时怎么办；目前只允许 drop。 */
  excess?: string;
  /** 人读说明；契约门禁要求非空。 */
  note?: string;
}

const DEFAULT_WINDOW_MS = 1000;

export class EventRateLimiter {
  /** `${type}\0${key}` → 窗口内已放行的时间戳（升序）。 */
  private readonly hits = new Map<string, number[]>();
  private readonly dropped = new Map<string, number>();

  /**
   * 是否放行。没有 `rate_limit` 声明的事件永远放行。
   * `nowMs` 由调用方注入（测试用假时钟跑 60 秒模拟，不必真的等待）。
   */
  allow(
    type: string,
    spec: RateLimitSpec | null | undefined,
    params: Record<string, unknown>,
    nowMs: number,
  ): boolean {
    const max = spec?.max_hz;
    if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return true;
    const windowMs =
      typeof spec?.window_ms === 'number' && spec.window_ms > 0 ? spec.window_ms : DEFAULT_WINDOW_MS;
    const keyField = typeof spec?.key_field === 'string' ? spec.key_field : '';
    const key = `${type}\u0000${keyField ? String(params[keyField] ?? '') : ''}`;

    const cutoff = nowMs - windowMs;
    const hits = this.hits.get(key) ?? [];
    // 滑窗是左闭右开：恰好 window_ms 之前的那一条不再占额度。
    let expired = 0;
    while (expired < hits.length && hits[expired] <= cutoff) expired += 1;
    if (expired) hits.splice(0, expired);

    if (hits.length >= max) {
      this.hits.set(key, hits);
      this.dropped.set(key, (this.dropped.get(key) ?? 0) + 1);
      return false;
    }
    hits.push(nowMs);
    this.hits.set(key, hits);
    return true;
  }

  /** 某个事件类型累计被压掉的条数（诊断/测试用）。 */
  droppedCount(type: string): number {
    let total = 0;
    for (const [key, count] of this.dropped) {
      if (key.startsWith(`${type}\u0000`)) total += count;
    }
    return total;
  }
}
