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

export interface SpeechRouterHooks {
  /** 收到一句定稿文本时调用（供 A11 路由使用）。默认没有消费者。 */
  onUtteranceHeard?: (input: {
    utterance_id: string;
    text: string;
    stop_reason?: string;
    route_hint?: string;
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

      case 'speech.tts_started':
        // 记下这次的文本，供 tts_finished 写摘要
        if (typeof p.task_id === 'string' && typeof p.response_id === 'string') {
          const txt = this.pendingSpeak.get(p.task_id);
          if (txt) this.speakText.set(p.response_id, txt);
        }
        return;

      case 'speech.tts_finished':
        this.emit('speech.spoken', {
          response_id: String(p.response_id ?? ''),
          chunks: int(p.chunks),
          played: int(p.played),
          excerpt: this.speakText.get(String(p.response_id ?? '')),
        });
        this.speakText.delete(String(p.response_id ?? ''));
        return;

      case 'speech.tts_cancelled':
        this.emit('speech.speak_cancelled', {
          response_id: String(p.response_id ?? ''),
          reason: normCancelReason(p.reason),
          played: int(p.played),
        });
        this.speakText.delete(String(p.response_id ?? ''));
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

    // 交给路由层（A11）。这里只转发，不做任何解释。
    this.hooks.onUtteranceHeard?.({
      utterance_id: utteranceId,
      text,
      stop_reason: stopReason,
      route_hint: typeof p.route_hint === 'string' ? p.route_hint : undefined,
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
    case 'requested':
      return r;
    default:
      return 'interrupted';
  }
}
