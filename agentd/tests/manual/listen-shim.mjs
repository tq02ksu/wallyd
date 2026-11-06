/**
 * 受限沙箱/容器里 `listen(127.0.0.1)` 会 EPERM。这个 preload 只把监听变成
 * 「立即回调」，让**不依赖真实 HTTP 传输**的测试（如 contract/events.mjs 的路由表核对）
 * 能在本地跑；需要真实 HTTP 的 e2e 仍然要用正常环境。
 *
 * 用法：node --experimental-strip-types --import ./agentd/tests/manual/listen-shim.mjs agentd/tests/contract/events.mjs
 */
import http from 'node:http';

http.Server.prototype.listen = function (...args) {
  const cb = args.find((a) => typeof a === 'function');
  if (cb) process.nextTick(cb);
  return this;
};
