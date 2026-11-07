/**
 * 手动验证用的**内存传输层** preload：受限沙箱里 `listen()` 一律 EPERM（AF_INET /
 * AF_INET6 / unix socket 都被拒绝），HTTP 级验收于是只能在 CI 跑——GH-11 第 1 轮的
 * 夹具错误就是这么漏过去的（本地只跑判定谓词，CI 首跑才发现）。
 *
 * 这个 preload 把三件事换成同进程直连：
 * - `http.createServer()` 返回一个假 Server（`listen` 立即回调、`address()` 给假端口）；
 * - `fetch()` 不再走 socket，而是按端口找到假 Server，直接 `emit('request')` 并把
 *   response 包成标准 `Response`；
 * - 请求/响应对象只实现被测代码真正用到的表面（headers、body 流、writeHead/end）。
 *
 * **被测代码路径不变**：router.match、CSRF 校验、JSON 编解码、handler 装配全都真的跑，
 * 换掉的只有 `127.0.0.1` 之间的那一段 TCP。真实 HTTP 传输仍由 CI 的 e2e 覆盖，
 * 所以这只是「本地也能跑同一份用例」，不是用假传输冒充验收。
 *
 * 用法：
 *   node --experimental-strip-types \
 *     --import ./agentd/tests/manual/in-memory-http.mjs \
 *     agentd/tests/unit/approval-settle.mjs
 */
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const servers = new Map();
let nextPort = 41000;

/** 请求体一次性灌进去即可：被测代码只做 readBody 的整读，不做流式解析。 */
class FakeRequest extends Readable {
  constructor(method, url, headers, body) {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.httpVersion = '1.1';
    this.socket = { remoteAddress: '127.0.0.1', destroy() {} };
    this._body = body;
  }

  _read() {
    if (this._body !== undefined) {
      this.push(this._body);
      this._body = undefined;
    }
    this.push(null);
  }
}

/** 只实现被测代码用到的响应表面：状态码、头部、一次性 end。 */
class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headersSent = false;
    this._headers = {};
    this._chunks = [];
    this._ended = false;
  }

  setHeader(key, value) {
    this._headers[String(key).toLowerCase()] = value;
  }

  getHeader(key) {
    return this._headers[String(key).toLowerCase()];
  }

  writeHead(status, headers) {
    this.statusCode = status;
    for (const [k, v] of Object.entries(headers ?? {})) this.setHeader(k, v);
    this.headersSent = true;
    return this;
  }

  write(chunk) {
    this._chunks.push(Buffer.from(chunk));
    return true;
  }

  flushHeaders() {
    this.headersSent = true;
  }

  end(chunk) {
    if (chunk) this._chunks.push(Buffer.from(chunk));
    if (this._ended) return this;
    this._ended = true;
    this.headersSent = true;
    this.emit('finish');
    return this;
  }
}

class FakeServer extends EventEmitter {
  constructor(listener) {
    super();
    this._port = null;
    if (listener) this.on('request', listener);
  }

  listen(port, host, cb) {
    const done = typeof host === 'function' ? host : cb;
    this._port = port === 0 ? nextPort++ : port;
    servers.set(this._port, this);
    queueMicrotask(() => done?.());
    return this;
  }

  address() {
    return { address: '127.0.0.1', family: 'IPv4', port: this._port };
  }

  close(cb) {
    if (this._port !== null) servers.delete(this._port);
    queueMicrotask(() => cb?.());
    return this;
  }

  setTimeout() {
    return this;
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }
}

http.createServer = (listener) => new FakeServer(listener);

globalThis.fetch = async function inMemoryFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const server = servers.get(Number(url.port || 80));
  if (!server) throw new TypeError(`fetch failed: ECONNREFUSED ${url.host}`);
  const headers = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
  if (!headers.host) headers.host = url.host;
  const body = init.body === undefined ? undefined : Buffer.from(String(init.body));
  if (body) headers['content-length'] = String(body.length);
  const req = new FakeRequest(init.method ?? 'GET', url.pathname + url.search, headers, body);
  const res = new FakeResponse();
  const finished = new Promise((resolve) => res.once('finish', resolve));
  server.emit('request', req, res);
  await finished;
  const text = Buffer.concat(res._chunks).toString('utf8');
  // 204/304 不允许带 body，Response 构造器会直接报错。
  const bodyless = res.statusCode === 204 || res.statusCode === 304;
  return new Response(bodyless ? null : text, { status: res.statusCode, headers: res._headers });
};
