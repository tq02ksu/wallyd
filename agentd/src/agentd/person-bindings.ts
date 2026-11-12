/**
 * 说话人 ↔ track 绑定表（GH-68）。
 *
 * ## 这是什么
 *
 * `speech.utterance_heard.speaker_id` 说明「是谁在说」，`person.*` 说明「画面里有哪些
 * 身体」。两者之间没有天然的对应关系；本模块只维护**已经观测到的绑定事实**：
 * 谁、绑定到哪条 track、置信度多少、证据来源是什么、什么时候到期。
 *
 * ## 不是什么
 *
 * - **不是 run**：绑定不占活动名额，不产生 run 事件，也没有独立任务生命周期；
 * - **不是身份判断**：`track_id` 只标识一条跨帧 track，`speaker_id` 只标识说话人分段；
 *   这里不做声纹、不做「这是谁」；
 * - **不做检测/跟踪**：track 生命周期由 `person.appeared/moved/lost` 事件驱动，
 *   本模块只消费事实，不产生观测。
 *
 * ## 纪律
 *
 * 1. `confidence` / `source` **落库**（`person_bindings`），不是日志；`follow` 的门限
 *    判断与事后审计都读同一行。
 * 2. `person.lost` 必须立即删除指向该 track 的绑定，并且读取时还会二次校验
 *    「绑定指向的 track 是否还活着」——宁可多删，不留悬空引用。
 * 3. 过期由读取方按注入时钟判定；测试可以推进时钟，不需要 sleep。
 * 4. 表有界：超过 `maxBindings` 时淘汰最早建立的条目；活 track 也有上限。
 * 5. 说话人键：上游省略 `speaker_id` 时使用固定的匿名键，**不得**把匿名绑定
 *    沿用给之后出现的有名说话人（旧上下文不跨人）。
 */
import type { Store, Tx } from './store.ts';
import { nowIso } from './store.ts';

export type BindingSource = 'doa' | 'visual_anchor' | 'explicit';

export interface PersonBinding {
  speaker_id: string;
  track_id: string;
  confidence: number;
  source: BindingSource;
  /** 毫秒时间戳（与 `expires_at` 同一时钟域）。 */
  bound_at: number;
  /** 毫秒时间戳；到点后绑定失效。 */
  expires_at: number;
}

export interface LiveTrack {
  track_id: string;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

/** 上游没有 speaker 分段时的匿名键。它不会与任何真实 speaker_id 相等。 */
export const UNIDENTIFIED_SPEAKER = '@unidentified';

export const DEFAULT_BINDING_TTL_MS = 60_000;
/**
 * 绑定置信度门限。
 *
 * 默认值写在配置里（`AgentdConfig` / CLI），这里只是配置缺省时的安全默认：
 * `follow` 只有 `confidence >= min` 才直接下发，否则澄清。
 */
export const DEFAULT_BINDING_MIN_CONFIDENCE = 0.5;
/**
 * 「画面里恰好只有一条活 track」时自动绑定的置信度。
 *
 * 这不是检测器算出来的分数，而是本实现**显式声明**的策略值：只有一条候选时，
 * 绑定证据视为 `visual_anchor`，置信度 0.6。它高于默认门限，因此单人场景可以直接
 * 绑定；门限一旦被配置到更高，同一场景也会如实落到澄清。
 */
export const DEFAULT_SINGLE_TRACK_CONFIDENCE = 0.6;

const MAX_BINDINGS = 32;
const MAX_LIVE_TRACKS = 64;

interface BindingRow {
  speaker_id: string;
  track_id: string;
  confidence: number;
  source: string;
  bound_at: number;
  expires_at: number;
}

export type FollowTargetResolution =
  /** 已有可用绑定，或恰好只有一条活 track 并刚刚自动绑定。 */
  | { status: 'bound'; binding: PersonBinding; auto_bound: boolean }
  /** 有绑定，但置信度低于门限：不得直接下发。 */
  | { status: 'low_confidence'; binding: PersonBinding; live_track_ids: string[] }
  /** 没有可用绑定，且画面里有多条活 track：必须澄清。 */
  | { status: 'multiple_tracks'; live_track_ids: string[] }
  /** 没有绑定，也没有任何活 track。 */
  | { status: 'no_tracks' };

/** `run-request` 只需要这一小组能力；测试可以注入实现，生产用本类。 */
export interface FollowBindingLookup {
  resolveFollowTarget(speaker_id?: string | null): FollowTargetResolution;
  isTrackLive(track_id: string): boolean;
  bindExplicit(speaker_id: string | null | undefined, track_id: string): PersonBinding;
}

export interface PersonBindingOptions {
  store: Store;
  now?: () => number;
  ttlMs?: number;
  minConfidence?: number;
  singleTrackConfidence?: number;
}

function speakerKey(speakerId: string | null | undefined): string {
  const trimmed = typeof speakerId === 'string' ? speakerId.trim() : '';
  return trimmed.length > 0 ? trimmed : UNIDENTIFIED_SPEAKER;
}

function isSource(value: unknown): value is BindingSource {
  return value === 'doa' || value === 'visual_anchor' || value === 'explicit';
}

function toBinding(row: BindingRow): PersonBinding {
  return {
    speaker_id: row.speaker_id,
    track_id: row.track_id,
    confidence: Number(row.confidence),
    source: isSource(row.source) ? row.source : 'visual_anchor',
    bound_at: Number(row.bound_at),
    expires_at: Number(row.expires_at),
  };
}

export class FollowTargetRegistry implements FollowBindingLookup {
  private readonly store: Store;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly minConfidence: number;
  private readonly singleTrackConfidence: number;
  /** track_id → 最近一次观测。插入顺序就是首次出现顺序，用于有界淘汰。 */
  private readonly live = new Map<string, LiveTrack>();

  constructor(opts: PersonBindingOptions) {
    this.store = opts.store;
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = Math.max(1, opts.ttlMs ?? DEFAULT_BINDING_TTL_MS);
    this.minConfidence = opts.minConfidence ?? DEFAULT_BINDING_MIN_CONFIDENCE;
    this.singleTrackConfidence = opts.singleTrackConfidence ?? DEFAULT_SINGLE_TRACK_CONFIDENCE;
  }

  // ---------------------------------------------------------------- track 生命周期
  /** `person.appeared`：只记事实。重复出现不会重置首次时间，但会刷新顺序。 */
  trackAppeared(trackId: string, firstSeenAt?: string | null): void {
    if (!trackId) return;
    const existing = this.live.get(trackId);
    this.live.delete(trackId);
    this.live.set(trackId, {
      track_id: trackId,
      first_seen_at: existing?.first_seen_at ?? (firstSeenAt ?? nowIso(this.now())),
      last_seen_at: nowIso(this.now()),
    });
    this.trimLiveTracks();
  }

  /** `person.moved`：只刷新已知 track；未知 track 的 moved 不凭空创建活体。 */
  trackMoved(trackId: string): void {
    if (!trackId) return;
    const existing = this.live.get(trackId);
    if (!existing) return;
    existing.last_seen_at = nowIso(this.now());
    this.live.delete(trackId);
    this.live.set(trackId, existing);
  }

  /**
   * `person.lost`：track 失效，同时删掉所有指向它的绑定。
   *
   * 删除是事务内完成的；即使事件写入随后失败，绑定也已经失效——安全侧优先。
   */
  trackLost(trackId: string): void {
    if (!trackId) return;
    this.live.delete(trackId);
    this.store.transaction((tx) => {
      tx.run('DELETE FROM person_bindings WHERE track_id = ?', trackId);
    });
  }

  isTrackLive(trackId: string): boolean {
    return this.live.has(trackId);
  }

  liveTrackIds(): string[] {
    return [...this.live.keys()];
  }

  // ---------------------------------------------------------------- 绑定读写
  bind(input: {
    speaker_id: string | null | undefined;
    track_id: string;
    confidence: number;
    source: BindingSource;
  }): PersonBinding {
    const speaker = speakerKey(input.speaker_id);
    const confidence =
      typeof input.confidence === 'number' && Number.isFinite(input.confidence)
        ? Math.min(1, Math.max(0, input.confidence))
        : 0;
    const boundAt = this.now();
    const expiresAt = boundAt + this.ttlMs;
    const binding: PersonBinding = {
      speaker_id: speaker,
      track_id: input.track_id,
      confidence,
      source: input.source,
      bound_at: boundAt,
      expires_at: expiresAt,
    };
    this.store.transaction((tx) => {
      tx.run(
        `INSERT INTO person_bindings(speaker_id, track_id, confidence, source, bound_at, expires_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(speaker_id) DO UPDATE SET
           track_id = excluded.track_id,
           confidence = excluded.confidence,
           source = excluded.source,
           bound_at = excluded.bound_at,
           expires_at = excluded.expires_at`,
        binding.speaker_id,
        binding.track_id,
        binding.confidence,
        binding.source,
        binding.bound_at,
        binding.expires_at,
      );
      this.enforceCapacity(tx);
    });
    return binding;
  }

  /** 用户显式给出 `target_track_id`：证据来源如实记为 `explicit`，置信度 1。 */
  bindExplicit(speakerId: string | null | undefined, trackId: string): PersonBinding {
    return this.bind({ speaker_id: speakerId, track_id: trackId, confidence: 1, source: 'explicit' });
  }

  /**
   * 读取当前说话人的有效绑定。
   *
   * 过期或 track 已不在画面里的绑定会被就地删除并返回 null——读取路径也承担清理，
   * 避免只在 `person.lost` 一个入口维护一致性。
   */
  bindingFor(speakerId?: string | null): PersonBinding | null {
    const speaker = speakerKey(speakerId);
    const row = this.store.one<BindingRow>(
      'SELECT * FROM person_bindings WHERE speaker_id = ?',
      speaker,
    );
    if (!row) return null;
    const binding = toBinding(row);
    if (binding.expires_at <= this.now() || !this.live.has(binding.track_id)) {
      this.deleteBySpeaker(speaker);
      return null;
    }
    return binding;
  }

  /** `follow` 的绑定解析：已有的用已有，单人自动绑定，多人/低置信度交给调用方澄清。 */
  resolveFollowTarget(speakerId?: string | null): FollowTargetResolution {
    this.pruneExpired();
    const tracks = this.liveTrackIds();
    // 多人优先：即使这个说话人之前有一条有效绑定，画面里出现 ≥2 条活 track 时也
    // **不得**直接下发。「跟着我」在多人场景下必须澄清——旧绑定可能是单人时刻
    // 自动建立的，不能当成「现在已经确认了是谁」。
    if (tracks.length >= 2) return { status: 'multiple_tracks', live_track_ids: tracks };
    const binding = this.bindingFor(speakerId);
    if (binding) {
      if (binding.confidence < this.minConfidence) {
        return {
          status: 'low_confidence',
          binding,
          live_track_ids: this.liveTrackIds(),
        };
      }
      return { status: 'bound', binding, auto_bound: false };
    }
    if (tracks.length === 1) {
      const auto = this.bind({
        speaker_id: speakerId,
        track_id: tracks[0],
        confidence: this.singleTrackConfidence,
        source: 'visual_anchor',
      });
      return { status: 'bound', binding: auto, auto_bound: true };
    }
    if (tracks.length >= 2) return { status: 'multiple_tracks', live_track_ids: tracks };
    return { status: 'no_tracks' };
  }

  /** 诊断/测试：当前全部未过期且指向活 track 的绑定。 */
  listBindings(): PersonBinding[] {
    this.pruneExpired();
    const rows = this.store.all<BindingRow>(
      'SELECT * FROM person_bindings ORDER BY bound_at ASC, speaker_id ASC',
    );
    return rows.map(toBinding);
  }

  /** 删除过期与悬空绑定；有界表的日常维护入口。 */
  pruneExpired(): void {
    const rows = this.store.all<BindingRow>('SELECT * FROM person_bindings');
    const now = this.now();
    for (const row of rows) {
      if (row.expires_at <= now || !this.live.has(row.track_id)) {
        this.deleteBySpeaker(row.speaker_id);
      }
    }
  }

  // ---------------------------------------------------------------- 内部
  private deleteBySpeaker(speakerId: string): void {
    this.store.transaction((tx) => {
      tx.run('DELETE FROM person_bindings WHERE speaker_id = ?', speakerId);
    });
  }

  private enforceCapacity(tx: Tx): void {
    const count = Number(
      tx.one<{ n: number }>('SELECT COUNT(*) AS n FROM person_bindings')?.n ?? 0,
    );
    if (count <= MAX_BINDINGS) return;
    tx.run(
      `DELETE FROM person_bindings WHERE speaker_id IN (
         SELECT speaker_id FROM person_bindings ORDER BY bound_at ASC, rowid ASC LIMIT ?
       )`,
      count - MAX_BINDINGS,
    );
  }

  private trimLiveTracks(): void {
    while (this.live.size > MAX_LIVE_TRACKS) {
      const oldest = this.live.keys().next().value;
      if (oldest === undefined) break;
      this.live.delete(oldest);
    }
  }
}
