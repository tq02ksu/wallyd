/**
 * agentd 前端 API 客户端。
 *
 * 三条纪律：
 * 1. 写操作一定带 CSRF（从 `/api/session` 取一次），否则服务端 403。
 * 2. 错误一律按 `error.code` 分支，不解析 message。
 * 3. **停止机器人不走 agentd**：`stopBodyDirect()` 直达 robotd 的 `/v1/robot/stop`，
 *    agentd 挂了也能用。这是安全旁路，界面上与「取消任务」严格分开。
 */

export class ApiError extends Error {
  constructor(code, message, details, hint, status) {
    super(message);
    this.code = code;
    this.details = details ?? null;
    this.hint = hint ?? null;
    this.status = status;
  }
}

let csrf = null;
let bootId = null;

export function currentBootId() {
  return bootId;
}

export async function initSession() {
  const res = await fetch('/api/session');
  const body = await res.json();
  csrf = body.csrf;
  bootId = body.boot_id;
  return body;
}

async function call(method, route, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['x-agentd-csrf'] = csrf;
  let res;
  try {
    res = await fetch(route, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError('E_NETWORK', `连不上 agentd：${e.message}`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError('E_PARSE', `服务端返回了非 JSON 内容（HTTP ${res.status}）`);
  }
  if (!res.ok || json?.ok === false) {
    const err = json?.error ?? {};
    throw new ApiError(
      err.code ?? 'E_INTERNAL',
      err.message ?? `HTTP ${res.status}`,
      err.details,
      err.hint,
      res.status,
    );
  }
  return json;
}

export const api = {
  healthz: () => call('GET', '/healthz'),
  state: () => call('GET', '/api/state'),

  listSessions: (params = {}) => call('GET', `/api/sessions${qs(params)}`),
  createSession: (title) => call('POST', '/api/sessions', title ? { title } : {}),
  getSession: (id, params = {}) => call('GET', `/api/sessions/${encodeURIComponent(id)}${qs(params)}`),

  submitRun: (payload) => call('POST', '/api/run', payload),
  listRuns: (params = {}) => call('GET', `/api/runs${qs(params)}`),
  getRun: (id) => call('GET', `/api/runs/${encodeURIComponent(id)}`),
  cancelRun: (id, reason) =>
    call('POST', `/api/runs/${encodeURIComponent(id)}/cancel`, reason ? { reason } : {}),
  stop: () => call('POST', '/api/stop', {}),

  listEvents: (params = {}) => call('GET', `/api/events${qs(params)}`),

  listProfiles: () => call('GET', '/api/model-profiles'),
  getProfile: (id) => call('GET', `/api/model-profiles/${encodeURIComponent(id)}`),
  createProfile: (draft) => call('POST', '/api/model-profiles', draft),
  updateProfile: (id, patch) => call('PUT', `/api/model-profiles/${encodeURIComponent(id)}`, patch),
  validateProfile: (id, revision) =>
    call('POST', `/api/model-profiles/${encodeURIComponent(id)}/validate`, revision ? { revision } : {}),
  activateProfile: (id, revision, baseActiveRevision) =>
    call('POST', `/api/model-profiles/${encodeURIComponent(id)}/activate`, {
      revision,
      ...(baseActiveRevision ? { base_active_revision: baseActiveRevision } : {}),
    }),

  listApprovals: (params = {}) => call('GET', `/api/approvals${qs(params)}`),
};

function qs(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

// ---------------------------------------------------------------- 直达 robotd 的停止
/**
 * 软件停止的安全旁路：浏览器直接请求 robotd。
 *
 * 为什么不让 agentd 转发：agentd 崩了、模型挂了、Harness 卡死时，
 * 停止必须仍然可用。所以这条路不经过 agentd 的任何逻辑。
 *
 * 返回的 state 必须如实区分「已请求」与「已确认」。
 */
export async function stopBodyDirect(robotdBase = 'http://127.0.0.1:8787') {
  try {
    const res = await fetch(`${robotdBase}/v1/robot/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'ui_direct_stop' }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.ok === false) {
      return {
        state: 'unknown',
        detail: `robotd 拒绝或未响应（HTTP ${res.status}）${body?.error?.message ? '：' + body.error.message : ''}`,
        board_ack: null,
      };
    }
    if (body.board_ack === true) {
      return { state: 'confirmed', detail: 'robotd 已确认板侧收到停止', board_ack: true };
    }
    return {
      state: 'requested',
      detail: 'robotd 已受理，但未拿到板侧确认',
      board_ack: body.board_ack ?? null,
    };
  } catch (e) {
    return {
      state: 'unknown',
      detail: `无法确认停止是否生效：${e.message}（robotd 可能没在运行）`,
      board_ack: null,
    };
  }
}

// ---------------------------------------------------------------- 实时事件
/**
 * 订阅实时事件。
 *
 * 重连带 cursor 与 bootId：同一 boot 且游标未过期 → 补发；否则服务端回
 * `resync_required`，此时**必须重拉全量**，不能悄悄跳过缺口。
 */
export function listenEvents({ cursor = null, onEvent, onStatus, onResync }) {
  let ws = null;
  let closed = false;
  let retry = 0;
  let lastCursor = cursor;

  const connect = () => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/api/events/live`);

    ws.addEventListener('open', () => {
      retry = 0;
      onStatus?.('connected');
      ws.send(JSON.stringify({ type: 'subscribe', cursor: lastCursor, boot_id: bootId }));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'event') {
        lastCursor = msg.event.cursor;
        onEvent?.(msg.event);
      } else if (msg.type === 'resync_required') {
        onResync?.(msg);
      } else if (msg.type === 'subscribed') {
        onStatus?.('subscribed');
      } else if (msg.type === 'error') {
        onStatus?.('error');
      }
    });
    ws.addEventListener('close', () => {
      if (closed) return;
      onStatus?.('reconnecting');
      // 指数退避，最长 10 秒
      const delay = Math.min(1000 * 2 ** retry, 10000);
      retry += 1;
      setTimeout(connect, delay);
    });
    ws.addEventListener('error', () => {
      onStatus?.('error');
    });
  };

  connect();
  return {
    close() {
      closed = true;
      ws?.close();
    },
    setCursor(c) {
      lastCursor = c;
    },
  };
}
