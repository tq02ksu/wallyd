/**
 * robotd 事件订阅（agentd → robotd `WS /v1/events`）。
 *
 * ## 为什么需要它
 *
 * 在此之前 agentd 只有 REST（health/state/tasks/stop），robotd 的 `speech.*`、
 * `task.*`、`device.*` 事件**一条都到不了大脑**——页面事件页因此只有 agentd 自己
 * 启动时写的那一条。语音识别结果要变成 agentd 可路由的输入，这条链路必须先通。
 *
 * ## 纪律（与 agentd 其余部分一致）
 *
 * 1. **断线要留痕，不能静默续接**：断开时写 `observation.gap`，重连成功才允许恢复。
 *    游标补发失败（`resync_required`）同样记一条——宁可让时间线出现一个明确的洞，
 *    也不假装那段时间什么都没发生。
 * 2. **不自行修补状态**：收到 `resync_required` 只重拉快照重建基线，
 *    不用残缺事件去推断身体状态（契约明写）。
 * 3. **高频事件不进语义事件库**：`speech.partial` 每秒十几条，进库会淹没时间线。
 *    订阅时只要**节点性**事件，部分更新走内存态与 UI 的实时推送。
 * 4. **失败不阻断**：robotd 不可达时 agentd 照常服务，只是没有增量；
 *    连接状态经 `/api/state` 的 `subscription` 字段如实暴露。
 */

import { EventEmitter } from 'node:events';

export type SubscriptionState =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'stopped';

export interface RobotdEvent {
  version: number;
  type: string;
  event_id: string;
  seq: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface SubscriptionStatus {
  state: SubscriptionState;
  /** 是否曾经连上过（用于区分「从没连上」与「连上后断了」） */
  ever_connected: boolean;
  /** 当前 robotd 的 instance_id；重连后可能变化 */
  instance_id: string | null;
  /** 已处理的最后一个 seq（用于游标补发） */
  last_seq: number | null;
  connected_at: string | null;
  disconnected_at: string | null;
  last_error: string | null;
  /** 累计收到的 node 事件数 */
  received: number;
  /** 累计重连次数 */
  reconnects: number;
}

/** 订阅哪些事件。**只订阅节点性事件**，故意排除 `speech.partial` / `audio.state`。
 *
 * `audio.state` 也不订阅：它每次静音/播报都会变，且完整快照已经在 `/v1/audio/state`；
 * 订阅它只会制造噪声。需要时按需拉取。
 */
export const NODE_EVENT_TYPES = [
  'speech.ready',
  'speech.started',
  'speech.speech_ended',
  'speech.endpoint',
  'speech.final',
  'speech.interrupted',
  'speech.tts_started',
  'speech.tts_finished',
  'speech.tts_cancelled',
  'task.started',
  // GH-48：暂停/恢复/到期是节点性事件。**目前只订阅、还没有 run 侧消费者**——
  // agentd 尚无「robotd 任务 → run」的状态映射（#12 接线）。提前订阅是为了接线时
  // 不静默丢掉这段历史，而不是假装这里已经产生了 run.paused。
  'task.paused',
  'task.resumed',
  'task.pause_expired',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'device.ready',
  'device.lost',
  'device.recovered',
  'device.reset',
  'device.changed',
  'safety.stopped',
  'safety.stop_requested',
] as const;

export class RobotdEventSubscriber extends EventEmitter {
  private readonly wsUrl: string;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;

  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs: number;

  private status: SubscriptionStatus = {
    state: 'idle',
    ever_connected: false,
    instance_id: null,
    last_seq: null,
    connected_at: null,
    disconnected_at: null,
    last_error: null,
    received: 0,
    reconnects: 0,
  };

  constructor(opts: {
    /** http://127.0.0.1:8787 → ws://127.0.0.1:8787/v1/events */
    baseUrl: string;
    log?: (msg: string, extra?: Record<string, unknown>) => void;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
  }) {
    super();
    const base = opts.baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
    this.wsUrl = `${base}/v1/events`;
    this.log = opts.log ?? (() => {});
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 500;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 10_000;
    this.backoffMs = this.reconnectBaseMs;
  }

  // ---------------------------------------------------------------- 生命周期
  start(): void {
    if (this.stopped) return;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeSocket();
    this.setStatus({ state: 'stopped' });
  }

  getStatus(): SubscriptionStatus {
    return { ...this.status };
  }

  // ---------------------------------------------------------------- 连接
  private connect(): void {
    if (this.stopped) return;
    if (typeof WebSocket === 'undefined') {
      this.setStatus({ state: 'stopped', last_error: '运行时不支持 WebSocket（需 Node 22+）' });
      return;
    }
    this.setStatus({ state: this.status.ever_connected ? 'reconnecting' : 'connecting' });
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl);
    } catch (e: any) {
      this.onFailure(`建立连接失败：${e.message}`);
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      // 握手帧由服务端推 `hello`；订阅在 hello 之后发，才拿得到 supported_event_types
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        this.log('robotd WS 收到非 JSON 帧', { preview: String(ev.data).slice(0, 200) });
        return;
      }
      this.handleMessage(msg);
    });

    ws.addEventListener('error', () => {
      // error 之后必定有 close；不在两处重复处理
    });

    ws.addEventListener('close', () => {
      const wasLive = this.status.state === 'live';
      this.setStatus({
        state: this.stopped ? 'stopped' : 'reconnecting',
        disconnected_at: new Date().toISOString(),
      });
      if (wasLive) {
        // 明确留痕：这段时间的增量没有收到
        this.emit('gap', {
          reason: 'ws_disconnected',
          from: this.status.last_seq,
          at: new Date().toISOString(),
        });
      }
      this.scheduleReconnect();
    });
  }

  private handleMessage(msg: any): void {
    switch (msg?.type) {
      case 'hello': {
        this.setStatus({
          state: 'live',
          ever_connected: true,
          instance_id: msg.instance_id ?? null,
          connected_at: new Date().toISOString(),
          last_error: null,
        });
        if (this.status.ever_connected && this.status.reconnects > 0) {
          // 重连成功：把退避重置
        }
        this.backoffMs = this.reconnectBaseMs;
        // 带游标订阅：能补发就补发，不能补发服务端会回 resync_required
        const subscribe: Record<string, unknown> = {
          type: 'subscribe',
          event_types: [...NODE_EVENT_TYPES],
        };
        // 只在本实例内续接；instance_id 变了就从头开始（旧 seq 无意义）
        if (this.status.last_seq !== null) {
          subscribe.resume_from_seq = this.status.last_seq;
        }
        this.send(subscribe);
        this.emit('live', { instance_id: msg.instance_id ?? null });
        return;
      }
      case 'subscription.accepted':
        this.log('robotd 订阅已生效', {
          // 服务端回的是 `filters`（契约字段名），不是 `event_types`
          filters: msg.filters?.length ?? 0,
          resume_from_seq: msg.resume?.requested_from_seq ?? null,
          verdict: msg.resume?.verdict ?? null,
          replayed: msg.resume?.replayed ?? null,
        });
        return;
      case 'state.snapshot':
        this.emit('snapshot', msg);
        return;
      case 'resync_required': {
        // 契约：不得用残缺事件自行修补状态，必须重拉快照重建基线
        this.log('robotd 补发不可用，需要重建基线', {
          reason: msg.reason,
          instance_id: msg.instance_id,
        });
        this.status.last_seq = null;
        this.emit('resync_required', {
          reason: msg.reason,
          instance_id: msg.instance_id ?? null,
        });
        return;
      }
      case 'pong':
        return;
      case 'event': {
        const event = this.extractEvent(msg);
        if (event) {
          this.status.last_seq = event.seq;
          this.status.received += 1;
          this.emit('event', event);
        }
        return;
      }
      default:
        // 事件也可能是裸封套（不带 type: "event"），按 seq 识别
        if (typeof msg?.seq === 'number' && typeof msg?.type === 'string' && msg.payload) {
          this.status.last_seq = msg.seq;
          this.status.received += 1;
          this.emit('event', msg as RobotdEvent);
        }
    }
  }

  /** WS 的事件封套有两种可能形状：`{type:'event', event:{...}}` 或裸封套。都要认。 */
  private extractEvent(msg: any): RobotdEvent | null {
    if (msg?.event && typeof msg.event.seq === 'number') {
      return msg.event as RobotdEvent;
    }
    if (typeof msg?.seq === 'number' && msg.payload) {
      return msg as RobotdEvent;
    }
    return null;
  }

  private send(obj: unknown): void {
    try {
      this.ws?.send(JSON.stringify(obj));
    } catch (e: any) {
      this.log('向 robotd 发送失败', { error: e.message });
    }
  }

  // ---------------------------------------------------------------- 重连
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.reconnectMaxMs);
    this.status.reconnects += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    // 不要让重连定时器把进程钉住
    this.reconnectTimer.unref?.();
  }

  private onFailure(reason: string): void {
    this.setStatus({ last_error: reason, state: 'reconnecting' });
    this.log('robotd 事件订阅失败', { reason });
    this.scheduleReconnect();
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      ws.close();
    } catch {
      /* 已经断了 */
    }
  }

  private setStatus(patch: Partial<SubscriptionStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatus());
  }
}
