/**
 * robotd 事件 → agentd 语义事件（R14 / A11 的前置）。
 *
 * ## 边界
 *
 * robotd 只给**结构化**事件（`speech.final` 带文本与 stop_reason，不带「用户想干什么」）。
 * 这里只做**记录与关联**，不做意图解析——意图解析属于路由（A11），不在本模块。
 * 这是 R14 那条纪律的落点：「语音事件只供 agentd 路由，robotd 不解析通用自然语言命令」。
 *
 * ## 哪些进事件库、哪些不进
 *
 * | robotd 事件 | 处理 |
 * | --- | --- |
 * | `speech.final`（有文本） | → `speech.utterance_heard`（截断摘要，不存全文） |
 * | `speech.final`（空 / no_speech） | → `speech.no_speech`（如实记录「没听到」） |
 * | `speech.tts_finished` | → `speech.spoken`（句数与实播句数） |
 * | `speech.tts_cancelled` | → `speech.speak_cancelled` |
 * | `device.lost`(audio) / `bridge_exit` | → `speech.audio_unavailable` |
 * | `device.ready`(audio) | → `speech.audio_recovered` |
 * | `speech.partial` / `audio.state` | **不入库**（高频，会淹没时间线） |
 *
 * ## 隐私
 *
 * 事件登记表的 `forbidden_payload_keys` 禁止 `raw_transcript`。这里**不写全文**，
 * 只写截断到 `EXCERPT_MAX` 字的摘要——事件库会被导出、被历史页展示、被审计阅读。
 */

import type { EventLog } from './events.ts';
import type { Store } from './store.ts';
import type { RobotdEvent } from './robotd-events.ts';

/** 摘要上限。超过就截断并标注，绝不把整段对话写进事件库。 */
export const EXCERPT_MAX = 80;

/**
 * 回声判定门限（dB）：`aec_erle_db` 是「参考电平 − 麦克风电平」的回声抑制量。
 * 小于该值说明麦克风几乎还是喇叭的声音。
 *
 * 这里判的是**「这句话是不是回声」**（审批 settle 的证据：echo=true 的 utterance 不能确认
 * 审批），不是「要不要停播」——后者由 robotd 的 `AudioRuntime` 用 `speech.gate` 单点判定。
 * 两处共用 `aec_erle_db` 与 6 dB 属已知重复门限，收敛需一并改 V08 的 settle 用例，另开 issue。
 */
export const ECHO_ERLE_MAX_DB = 6;

interface UtteranceStart {
  started_at: string;
  aec_erle_db: number | null;
  during_tts: boolean;
}

export interface SpeechRouterHooks {
  /** 收到一句定稿文本时调用（供 A11 路由使用）。默认没有消费者。 */
  onUtteranceHeard?: (input: {
    utterance_id: string;
    text: string;
    stop_reason?: string;
    route_hint?: string;
    /** 该轮 `speech.started` 的 robotd 时间戳（窗口因果判断用）。 */
    started_at?: string;
    /** 该轮是否是机器人自己 TTS 的回声（事实 + 门限判定，见 ECHO_ERLE_MAX_DB）。 */
    echo: boolean;
  }) => void;
  /**
   * 系统播报（审批复述）的真实终态。
   *
   * `ok:false` 包括被 stop 打断、桥退出、播报失败——调用方**不得**据此开启确认窗口。
   */
  onAnnouncementFinished?: (input: {
    approval_id: string;
    kind?: string;
    ok: boolean;
    reason?: string;
    response_id?: string;
    task_id?: string;
    played?: number;
  }) => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export class RobotdEventBridge {
  private events: EventLog;
  private store: Store;
  private hooks: SpeechRouterHooks;
  /** 上一次播报的摘要文本（按 response_id 存，用于 tts_finished 时带上 excerpt） */
  private speakText = new Map<string, string>();
  /** 待播报文本（按 task_id 存，等 tts_started 到达后转成 response_id 关联） */
  private pendingSpeak = new Map<string, string>();
  /** 上一次音频可用性，避免重复写同一状态 */
  private audioAvailable: boolean | null = null;
  /** 每一轮 `speech.started` 的事实，供确认窗口判断「窗口开启之后才开始」。 */
  private utteranceStarts = new Map<string, UtteranceStart>();
  /** 正在播放的 TTS response；用于判断一轮 utterance 是否发生在播报期间。 */
  private activeResponses = new Set<string>();

  constructor(deps: { events: EventLog; store: Store; hooks?: SpeechRouterHooks }) {
    this.events = deps.events;
    this.store = deps.store;
    this.hooks = deps.hooks ?? {};
  }

  /** 处理一条 robotd 事件。未知类型静默忽略（robotd 的事件面比 agentd 大）。 */
  handle(ev: RobotdEvent): void {
    try {
      this.route(ev);
    } catch (e: any) {
      this.hooks.log?.('翻译 robotd 事件失败', { type: ev.type, error: e.message });
    }
  }

  private route(ev: RobotdEvent): void {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    switch (ev.type) {
      case 'speech.final':
        this.onFinal(p);
        return;

      case 'speech.started':
        this.onStarted(ev.timestamp, p);
        return;

      case 'speech.tts_started':
        // 记下这次的文本，供 tts_finished 写摘要
        if (typeof p.task_id === 'string' && typeof p.response_id === 'string') {
          const txt = this.pendingSpeak.get(p.task_id);
          if (txt) this.speakText.set(p.response_id, txt);
        }
        if (typeof p.response_id === 'string' && p.response_id) this.activeResponses.add(p.response_id);
        return;

      case 'speech.tts_finished':
        this.emit('speech.spoken', {
          response_id: String(p.response_id ?? ''),
          chunks: int(p.chunks),
          played: int(p.played),
          excerpt: this.speakText.get(String(p.response_id ?? '')),
        });
        this.speakText.delete(String(p.response_id ?? ''));
        if (typeof p.response_id === 'string') this.activeResponses.delete(p.response_id);
        if (typeof p.approval_id === 'string' && p.approval_id) {
          this.hooks.onAnnouncementFinished?.({
            approval_id: p.approval_id,
            kind: typeof p.kind === 'string' ? p.kind : undefined,
            ok: true,
            response_id: typeof p.response_id === 'string' ? p.response_id : undefined,
            task_id: typeof p.task_id === 'string' ? p.task_id : undefined,
            played: playedValue(p.played),
          });
        }
        return;

      case 'speech.tts_cancelled':
        this.emit('speech.speak_cancelled', {
          response_id: String(p.response_id ?? ''),
          reason: normCancelReason(p.reason),
          played: int(p.played),
        });
        this.speakText.delete(String(p.response_id ?? ''));
        if (typeof p.response_id === 'string') this.activeResponses.delete(p.response_id);
        if (typeof p.approval_id === 'string' && p.approval_id) {
          this.hooks.onAnnouncementFinished?.({
            approval_id: p.approval_id,
            kind: typeof p.kind === 'string' ? p.kind : undefined,
            ok: false,
            reason: typeof p.reason === 'string' ? p.reason : 'interrupted',
            response_id: typeof p.response_id === 'string' ? p.response_id : undefined,
            task_id: typeof p.task_id === 'string' ? p.task_id : undefined,
            played: playedValue(p.played),
          });
        }
        return;

      case 'speech.announce_failed':
        if (typeof p.approval_id === 'string' && p.approval_id) {
          this.hooks.onAnnouncementFinished?.({
            approval_id: p.approval_id,
            kind: typeof p.kind === 'string' ? p.kind : undefined,
            ok: false,
            reason: typeof p.reason === 'string' ? p.reason : 'announce_failed',
            task_id: typeof p.task_id === 'string' ? p.task_id : undefined,
          });
        }
        return;

      case 'device.lost':
        if (String(p.device) === 'audio') {
          this.setAudioAvailable(false, String(p.reason ?? '语音桥断开'));
        }
        return;

      case 'device.ready':
        if (String(p.device) === 'audio') {
          this.setAudioAvailable(true, String(p.format ?? 'ready'));
        }
        return;

      default:
        // speech.partial / audio.state / task.* / safety.* 等：不在这里落库。
        // task.* 与 safety.* 各有自己的语义事件产生点（runs / stop 路由）。
        return;
    }
  }

  // ---------------------------------------------------------------- 听
  private onStarted(timestamp: string, p: Record<string, unknown>): void {
    const utteranceId = String(p.utterance_id ?? '');
    if (!utteranceId) return;
    const erle = typeof p.aec_erle_db === 'number' && Number.isFinite(p.aec_erle_db)
      ? p.aec_erle_db
      : null;
    this.utteranceStarts.set(utteranceId, {
      started_at: timestamp,
      aec_erle_db: erle,
      // 播报期间开始的这一轮，最可能是机器人自己的声音（barge-in 当前关闭）。
      during_tts: this.activeResponses.size > 0,
    });
    if (this.utteranceStarts.size > 200) {
      const first = this.utteranceStarts.keys().next().value;
      if (first !== undefined) this.utteranceStarts.delete(first);
    }
  }

  private onFinal(p: Record<string, unknown>): void {
    const utteranceId = String(p.utterance_id ?? '');
    const text = typeof p.text === 'string' ? p.text.trim() : '';
    const stopReason = typeof p.stop_reason === 'string' ? p.stop_reason : undefined;
    const noSpeech = p.no_speech === true || text.length === 0;

    if (noSpeech) {
      this.emit('speech.no_speech', {
        utterance_id: utteranceId,
        stop_reason: normNoSpeechReason(stopReason),
        duration_ms: intOrUndef(p.audio_ms),
      });
      return;
    }

    // 被中断 / 静音收尾的一轮，即使已经攒出了部分文本，也**不是**「听到了一句话」。
    // robotd 在这些终态里用 stop_reason 说明原因（`cancelled` / `muted` / `barge_in` …），
    // 而契约的 utterance_heard.stop_reason 只允许 silence/endpoint/max_seconds/cancelled，
    // 不能直接透传。这里落成 no_speech：如实记「这一轮没拿到可用的一句话」，
    // 不把它伪装成一次成功的听音。
    if (isInterrupted(stopReason)) {
      this.emit('speech.no_speech', {
        utterance_id: utteranceId,
        stop_reason: 'cancelled',
        duration_ms: intOrUndef(p.audio_ms),
      });
      this.hooks.log?.('听音被中断，部分文本不作为一句话记录', {
        utterance_id: utteranceId,
        stop_reason: stopReason,
        chars: text.length,
      });
      return;
    }

    this.emit('speech.utterance_heard', {
      utterance_id: utteranceId,
      excerpt: excerpt(text),
      chars: text.length,
      duration_ms: intOrUndef(p.audio_ms),
      stop_reason: normHeardReason(stopReason),
      route_hint: typeof p.route_hint === 'string' ? p.route_hint : undefined,
    });

    const info = this.utteranceStarts.get(utteranceId);
    const echo = info
      ? info.during_tts || (info.aec_erle_db !== null && info.aec_erle_db < ECHO_ERLE_MAX_DB)
      : false;
    this.utteranceStarts.delete(utteranceId);

    // 交给路由层（A11）。这里只转发，不做任何解释。
    this.hooks.onUtteranceHeard?.({
      utterance_id: utteranceId,
      text,
      stop_reason: stopReason,
      route_hint: typeof p.route_hint === 'string' ? p.route_hint : undefined,
      started_at: info?.started_at,
      echo,
    });
  }

  // ---------------------------------------------------------------- 可用性
  private setAudioAvailable(available: boolean, detail: string): void {
    if (this.audioAvailable === available) return;
    this.audioAvailable = available;
    if (available) {
      this.emit('speech.audio_recovered', { bridge: detail });
    } else {
      this.emit('speech.audio_unavailable', { detail, bridge: 'lost' });
    }
  }

  /**
   * 把待播报文本与任务关联起来。
   *
   * 由发出播报请求的入口在请求前调用——事件里只有 task_id/response_id，
   * 没有文本（robotd 不回显），所以要在这里留底。
   */
  noteSpeak(taskId: string, text: string): void {
    this.pendingSpeak.set(taskId, excerpt(text));
    // 防止长会话无限增长
    if (this.pendingSpeak.size > 200) {
      const first = this.pendingSpeak.keys().next().value;
      if (first !== undefined) this.pendingSpeak.delete(first);
    }
  }

  // ---------------------------------------------------------------- 写库
  private emit(type: string, params: Record<string, unknown>): void {
    if (!this.events.isRegistered(type)) {
      this.hooks.log?.('未登记的事件类型，拒绝写入', { type });
      return;
    }
    // 去掉 undefined：compactJson 会把它们写成 null，污染 payload
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) clean[k] = v;
    }
    this.events.emitStandalone({
      type,
      source: 'robotd',
      params: clean,
    });
  }
}

// ---------------------------------------------------------------- 小工具
function excerpt(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= EXCERPT_MAX ? one : `${one.slice(0, EXCERPT_MAX)}…`;
}

function int(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
}

function intOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined;
}

/** `played` 要保留「缺失」与「明确为 0」的区别。 */
function playedValue(v: unknown): number | undefined {
  if (v === false) return 0;
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined;
}

function normNoSpeechReason(reason?: string): string {
  switch (reason) {
    case 'silence':
    case 'empty':
    case 'cancelled':
    case 'bridge_exit':
      return reason;
    default:
      return 'silence';
  }
}

function normHeardReason(reason?: string): string | undefined {
  // 契约 utterance_heard.stop_reason 的枚举：silence / endpoint / max_seconds / cancelled。
  // 中断类终态已在 onFinal 里提前分流，走不到这里。
  switch (reason) {
    case 'silence':
    case 'endpoint':
    case 'max_seconds':
    case 'cancelled':
      return reason;
    default:
      return undefined;
  }
}

/** 这一轮是否属于「被外部终止」而非「正常说完 / 无人说话」。 */
function isInterrupted(reason?: string): boolean {
  switch (reason) {
    case 'cancelled':
    case 'muted':
    case 'interrupted':
    case 'barge_in':
    case 'bridge_exit':
      return true;
    default:
      return false;
  }
}

function normCancelReason(reason: unknown): string {
  const r = String(reason ?? '');
  switch (r) {
    case 'barge_in':
    case 'interrupted':
    case 'bridge_exit':
    case 'muted':
    case 'stop':
    case 'requested':
      return r;
    default:
      return 'interrupted';
  }
}
