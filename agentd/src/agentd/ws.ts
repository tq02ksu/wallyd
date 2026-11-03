/**
 * agentd 实时事件推送（`GET /api/events/live` 升级为 WebSocket）。
 *
 * ## 协议（与契约 `agentd_events_live` 对齐）
 *
 * 服务端 → 客户端：
 *   `hello`      连接建立，带 boot_id 与保留窗口
 *   `subscribed` 订阅生效，带当前 head cursor
 *   `event`      一条事件（EventView 形状）
 *   `resync_required` 需要重新拉全量（见下）
 *   `pong`       心跳应答
 *
 * 客户端 → 服务端：
 *   `subscribe`  `{ cursor?: string }` 断线重连时带上次的 cursor
 *   `ping`
 *
 * ## 三种 resync 原因，必须区分
 *
 * - `instance_changed`：boot_id 不同（agentd 重启过），旧 cursor 的语义已不可比。
 * - `cursor_expired`：cursor 早于保留窗口，中间的事件已被清理。
 * - `invalid_cursor`：cursor 格式不合法（客户端 bug 或被篡改）。
 *
 * 三者的共同要求是：**客户端必须重新 `GET /api/state` 与 `/api/events` 首页，
 * 不能悄悄跳过**。所以服务端不重放、不猜测，直接要求重来。
 *
 * ## 阻塞式帧的心跳
 *
 * WS 没有内置超时。服务端定期 ping；客户端回 pong 后才算活着。
 * 不回就断开，让客户端按 resync 流程重连——而不是留一个「看起来还在、
 * 其实事件早就不推了」的僵尸连接。
 */
import type { Socket } from 'node:net';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { EventLog, EventView } from './events.ts';
import { encodeCursor, decodeCursor } from './events.ts';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const MAX_FRAME_BYTES = 64 * 1024;
/** 多久没收到任何帧就判定客户端失联。 */
const HEARTBEAT_MS = 30_000;

export function computeAccept(key: string): string {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

/**
 * 允许升级为 WebSocket 的路径白名单。
 *
 * 必须与契约里的 `x-websocket: true` 端点一致。放在这里而不是散在 service.ts 的字面量里，
 * 是为了让 `tests/contract/` 能读到同一份来源并断言「白名单 == 契约」——
 * 否则契约新增一个 WS 端点时，实现不会跟上，也没有门禁能发现。
 */
export const WS_PATHS: readonly string[] = ['/api/events/live'];

export interface UpgradeCheck {
  ok: boolean;
  status?: number;
  reason?: string;
}

/** 严格校验升级请求；不满足就 400，不给半吊子握手。 */
export function validateUpgrade(req: IncomingMessage): UpgradeCheck {
  const upgrade = (req.headers.upgrade ?? '').toLowerCase();
  if (upgrade !== 'websocket') return { ok: false, status: 400, reason: 'Upgrade 不是 websocket' };
  const connection = ((req.headers.connection ?? '') as string).toLowerCase();
  if (!connection.split(',').map((s) => s.trim()).includes('upgrade')) {
    return { ok: false, status: 400, reason: 'Connection 不含 upgrade' };
  }
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || key.length === 0) {
    return { ok: false, status: 400, reason: '缺少 Sec-WebSocket-Key' };
  }
  const version = req.headers['sec-websocket-version'];
  if (version !== '13') {
    return { ok: false, status: 426, reason: '只支持 Sec-WebSocket-Version: 13' };
  }
  return { ok: true };
}

type FrameCallback = (opcode: number, payload: Buffer) => void;

/** 一个已建立的 WS 连接：负责编解码、心跳与有序发送。 */
export class WsConnection {
  private socket: Socket;
  /**
   * 未解析完的字节。类型写 `Buffer<ArrayBufferLike>` 而不是让 `Buffer.alloc(0)` 推出
   * `Buffer<ArrayBuffer>`：socket 送进来的 chunk 来自 Node 内部池，是 `ArrayBufferLike`，
   * 两者不是同一类型，收窄会在 `feed()` 处炸。这里要的是「任意来源的字节」。
   */
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private closed = false;
  private fragments: Buffer[] = [];
  private lastSeen = Date.now();
  private heartbeat: NodeJS.Timeout | null = null;
  private onFrame: FrameCallback | null = null;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.feed(chunk));
    socket.on('close', () => this.markClosed());
    socket.on('error', () => this.markClosed());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 绑定帧处理器；解码在内部完成，回调只拿到完整消息。 */
  setHandler(handler: FrameCallback): void {
    this.onFrame = handler;
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      if (Date.now() - this.lastSeen > HEARTBEAT_MS * 2) {
        // 两个周期没动静：断开。宁可让客户端重连，也不留僵尸连接。
        this.close(1001, 'heartbeat timeout');
        return;
      }
      this.sendControl(OP_PING);
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private feed(chunk: Buffer): void {
    this.lastSeen = Date.now();
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (true) {
      const frame = this.tryParse();
      if (frame === null) return;
      this.handleFrame(frame.opcode, frame.payload);
      if (this.closed) return;
    }
  }

  private tryParse(): { opcode: number; payload: Buffer } | null {
    if (this.buffer.length < 2) return null;
    const b0 = this.buffer[0];
    const b1 = this.buffer[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (this.buffer.length < offset + 2) return null;
      length = this.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (this.buffer.length < offset + 8) return null;
      const big = this.buffer.readBigUInt64BE(offset);
      if (big > BigInt(MAX_FRAME_BYTES)) {
        // 客户端声称的帧太大：不必等它传完
        this.fail(1009, 'frame too large');
        return null;
      }
      length = Number(big);
      offset += 8;
    }
    if (length > MAX_FRAME_BYTES) {
      this.fail(1009, 'frame too large');
      return null;
    }
    // RFC 6455：客户端帧必须掩码
    if (!masked) {
      this.fail(1002, 'client frames must be masked');
      return null;
    }
    if (this.buffer.length < offset + 4 + length) return null;
    const mask = this.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    this.buffer = this.buffer.subarray(offset + length);

    if (opcode === OP_CONT) {
      this.fragments.push(payload);
      if (!fin) return null;
      const whole = Buffer.concat(this.fragments);
      this.fragments = [];
      return { opcode: OP_TEXT, payload: whole };
    }
    if (!fin) {
      this.fragments = [payload];
      return null;
    }
    if (opcode === OP_TEXT) {
      // 有半截分片时不能直接冲掉
      this.fragments = [];
    }
    return { opcode, payload };
  }

  private handleFrame(opcode: number, payload: Buffer): void {
    if (opcode === OP_CLOSE) {
      this.close(1000, '');
      return;
    }
    if (opcode === OP_PING) {
      this.sendControl(OP_PONG, payload);
      return;
    }
    if (opcode === OP_PONG) {
      return;
    }
    if (opcode === OP_BINARY) {
      // 协议只收 JSON 文本
      this.fail(1003, 'binary frames not supported');
      return;
    }
    this.onFrame?.(opcode, payload);
  }

  private fail(code: number, reason: string): void {
    this.close(code, reason);
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.markClosed();
    }
  }

  sendText(text: string): void {
    this.writeFrame(OP_TEXT, Buffer.from(text, 'utf8'));
  }

  sendJson(obj: unknown): void {
    this.sendText(JSON.stringify(obj));
  }

  private sendControl(opcode: number, payload: Buffer<ArrayBufferLike> = Buffer.alloc(0)): void {
    this.writeFrame(opcode, payload);
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    const reasonBuf = Buffer.from(reason, 'utf8').subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this.writeFrame(OP_CLOSE, payload);
    this.markClosed();
    // 给对端一点时间读 close 帧再销毁
    setTimeout(() => this.socket.destroy(), 50).unref?.();
  }
}

export interface LiveSession {
  conn: WsConnection;
  subscribed: boolean;
  lastCursor: string | null;
}

export type ResyncReason = 'instance_changed' | 'cursor_expired' | 'invalid_cursor';

export interface LiveHubOptions {
  bootId: string;
  events: EventLog;
  /** 保留窗口下界（seq）。小于它的 cursor 视为过期。 */
  retainedFromSeq: () => number;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * 订阅中心：把新事件扇出给所有已订阅连接。
 *
 * 顺序保证：先 `hello`，客户端 `subscribe` 后回 `subscribed`+订阅游标，
 * 再推 backlog，最后才推 live。任何一条新事件都不会越过 `subscribed` 先到。
 */
export class LiveHub {
  private opts: LiveHubOptions;
  private sessions = new Set<WsConnection>();
  private pending: Array<{ conn: WsConnection; frames: string[] }> = [];
  private flushScheduled = false;

  constructor(opts: LiveHubOptions) {
    this.opts = opts;
  }

  get connectionCount(): number {
    return this.sessions.size;
  }

  /** 把一条事件广播给所有已订阅连接。 */
  broadcast(view: EventView): void {
    if (this.sessions.size === 0) return;
    const payload = JSON.stringify({ type: 'event', event: view });
    for (const conn of this.sessions) {
      if (conn.isClosed) continue;
      this.enqueue(conn, payload);
    }
  }

  private enqueue(conn: WsConnection, payload: string): void {
    this.pending.push({ conn, frames: [payload] });
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // 用 microtask 合并同一轮里的多条事件，避免一条一 write
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;
    const batch = this.pending;
    this.pending = [];
    for (const { conn, frames } of batch) {
      if (conn.isClosed) continue;
      for (const f of frames) conn.sendText(f);
    }
  }

  /** 接管一个刚完成握手的连接。 */
  attach(socket: Socket, req: IncomingMessage): void {
    const conn = new WsConnection(socket);
    this.sessions.add(conn);
    const remote = `${req.socket.remoteAddress ?? '?'}`;
    this.opts.log('ws connected', { remote, total: this.sessions.size });

    let subscribed = false;

    conn.setHandler((opcode, payload) => {
      if (opcode !== OP_TEXT) return;
      let msg: any;
      try {
        msg = JSON.parse(payload.toString('utf8'));
      } catch {
        conn.sendJson({ type: 'error', error: { code: 'E_VALIDATION', message: '帧不是合法 JSON' } });
        conn.close(1008, 'invalid json');
        return;
      }
      if (msg?.type === 'ping') {
        conn.sendJson({ type: 'pong', at: new Date().toISOString() });
        return;
      }
      if (msg?.type !== 'subscribe') {
        conn.sendJson({
          type: 'error',
          error: { code: 'E_VALIDATION', message: `未知消息类型 ${String(msg?.type)}` },
        });
        return;
      }
      if (subscribed) {
        // 重复订阅：重放一次当前游标，避免客户端卡在「以为订阅了」
        conn.sendJson({ type: 'subscribed', cursor: this.opts.events.headCursor(), duplicate: true });
        return;
      }
      subscribed = true;

      const clientBoot = typeof msg.boot_id === 'string' ? msg.boot_id : null;
      const cursor = typeof msg.cursor === 'string' && msg.cursor ? msg.cursor : null;

      if (clientBoot && clientBoot !== this.opts.bootId) {
        // agentd 重启过：旧游标的 seq 语义不可比
        this.sendResync(conn, 'instance_changed', cursor);
        return;
      }
      if (cursor !== null) {
        const seq = decodeCursor(cursor);
        if (seq === null) {
          this.sendResync(conn, 'invalid_cursor', cursor);
          return;
        }
        const retainedFrom = this.opts.retainedFromSeq();
        if (seq + 1 < retainedFrom) {
          this.sendResync(conn, 'cursor_expired', cursor);
          return;
        }
        // 补发：从 cursor 之后到 head
        const backlog = this.backlogAfter(seq);
        this.sessions.add(conn);
        conn.sendJson({ type: 'subscribed', cursor, backlog_count: backlog.length });
        for (const view of backlog) {
          conn.sendJson({ type: 'event', event: view });
        }
        return;
      }
      conn.sendJson({ type: 'subscribed', cursor: this.opts.events.headCursor(), backlog_count: 0 });
    });

    conn.sendJson({
      type: 'hello',
      boot_id: this.opts.bootId,
      retained_from_cursor: encodeCursor(this.opts.retainedFromSeq()),
      head_cursor: this.opts.events.headCursor(),
      server_time: new Date().toISOString(),
    });

    socket.on('close', () => {
      this.sessions.delete(conn);
      this.opts.log('ws closed', { remote, total: this.sessions.size });
    });
  }

  private sendResync(conn: WsConnection, reason: ResyncReason, cursor: string | null): void {
    conn.sendJson({
      type: 'resync_required',
      reason,
      cursor,
      head_cursor: this.opts.events.headCursor(),
      boot_id: this.opts.bootId,
      note: '必须重新 GET /api/state 与 /api/events 首页；服务端不会补发缺失区间',
    });
    // 保持连接：客户端重拉全量后再 subscribe 一次
  }

  private backlogAfter(seq: number): EventView[] {
    const { events } = this.opts.events.query({ limit: 200 });
    // query 是降序；取 seq 更大的那些，再反转为升序补发
    const tail = events.filter((e) => decodeCursor(e.cursor)! > seq).reverse();
    return tail;
  }

  shutdown(): void {
    for (const conn of this.sessions) conn.close(1001, 'server shutting down');
    this.sessions.clear();
  }
}

/** 给原始 socket 写 101 响应（不用 res.writeHead，避免重复 Connection 头）。 */
export function writeUpgradeResponse(socket: Socket, key: string): void {
  const accept = computeAccept(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
}

export { OP_TEXT };
