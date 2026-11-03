/** 手验：http.ts 的安全边界（Host / Origin / CSRF / body 上限 / 路由匹配）。 */
import {
  ApiError,
  Router,
  compileRoute,
  checkHost,
  checkOrigin,
  checkCsrf,
  readBody,
  rejectUnknown,
  parseLimit,
  requireString,
  optionalEnum,
  serveStatic,
  abortOversized,
  ERROR_STATUS,
  MAX_BODY_BYTES,
} from '../../src/agentd/http.ts';
import http from 'node:http';

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}
function expectApi(fn, code) {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof ApiError && e.code === code ? e : `unexpected: ${e.name} ${e.code} ${e.message}`;
  }
}

console.log('— 错误码 → 状态');
check('E_VALIDATION=400', ERROR_STATUS.E_VALIDATION === 400);
check('E_CSRF=403', ERROR_STATUS.E_CSRF === 403);
check('E_CURSOR_EXPIRED=410', ERROR_STATUS.E_CURSOR_EXPIRED === 410);
check('E_STORE=503', ERROR_STATUS.E_STORE === 503);
const e1 = new ApiError('E_NOT_FOUND', '没有');
check('ApiError 状态由 code 推出', e1.status === 404);
const body = e1.toBody();
check('错误体形状', body.ok === false && body.error.code === 'E_NOT_FOUND');

console.log('— 路由匹配');
const r = new Router({ allowedOrigins: new Set(), csrfToken: 't', selfPort: null, bootId: 'b', staticDir: null, log: () => {} });
r.add(compileRoute('GET', '/api/runs/{run_id}', 'agentd_get_run', false, () => null));
r.add(compileRoute('POST', '/api/runs/{run_id}/cancel', 'agentd_cancel_run', true, () => null));
const m = r.match('GET', '/api/runs/run-1');
check('路径参数提取', m && m.params.run_id === 'run-1', JSON.stringify(m?.params));
check('长模板不误匹配短路径', r.match('GET', '/api/runs/run-1/cancel') === null);
const mc = r.match('POST', '/api/runs/run-1/cancel');
check('取消路由匹配', mc && mc.route.write === true);
check('405 候选方法', r.allowedMethods('/api/runs/run-1').join(',') === 'GET');

console.log('— 输入校验');
check('requireString 类型', expectApi(() => requireString(5, 'prompt'), 'E_VALIDATION') !== null);
check('requireString 最小长度', expectApi(() => requireString('', 'prompt', { min: 1 }), 'E_VALIDATION') !== null);
check('requireString 最大长度', expectApi(() => requireString('x'.repeat(10), 'prompt', { max: 3 }), 'E_VALIDATION') !== null);
check('rejectUnknown 拒未知字段', expectApi(() => rejectUnknown({ a: 1, b: 2 }, ['a']), 'E_VALIDATION') !== null);
check('rejectUnknown 放行已知', rejectUnknown({ a: 1 }, ['a']) === undefined);
check('optionalEnum 拒非法值', expectApi(() => optionalEnum('bogus', 'severity', ['info']), 'E_VALIDATION') !== null);
check('optionalEnum 放行 undefined', optionalEnum(undefined, 'severity', ['info']) === undefined);
check('parseLimit 默认', parseLimit(null) === 50);
check('parseLimit 越界', expectApi(() => parseLimit('999'), 'E_VALIDATION') !== null);
check('parseLimit 非数字', expectApi(() => parseLimit('abc'), 'E_VALIDATION') !== null);

// ---------------------------------------------------------------- 真实 socket
const dir = new URL('../../../work/agentd-test/static-fixture', import.meta.url).pathname;
const fs = await import('node:fs');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(`${dir}/index.html`, '<!doctype html><title>fixture</title>');
fs.writeFileSync(`${dir}/app.js`, 'export const x = 1;');

const router = new Router({
  allowedOrigins: new Set(['http://127.0.0.1:8791']),
  csrfToken: 'csrf-secret',
  selfPort: null,
  bootId: 'boot-1',
  staticDir: dir,
  log: () => {},
});
router.add(compileRoute('POST', '/api/echo', 'test_echo', true, (ctx) => ({ ok: true, body: ctx.body })));

const server = http.createServer(async (req, res) => {
  try {
    checkHost(req, router.config.selfPort);
    const url = new URL(req.url, 'http://x');
    const { sameOrigin } = checkOrigin(req, router.config.allowedOrigins);
    const hit = router.match(req.method, url.pathname);
    if (hit) {
      if (hit.route.write) checkCsrf(req, router.config.csrfToken);
      const raw = await readBody(req);
      let parsed = null;
      if (raw.length) {
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new ApiError('E_VALIDATION', '请求体不是合法 JSON');
        }
      }
      const out = await hit.route.handler({ req, res, params: hit.params, query: Object.fromEntries(url.searchParams), body: parsed, sameOrigin });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }
    if (serveStatic(res, dir, url.pathname, () => {})) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code: 'E_NOT_FOUND', message: '没有' } }));
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError('E_INTERNAL', String(e.message ?? e));
    if (err.details && 'max_bytes' in err.details) {
      abortOversized(req, res, err, () => {});
      return;
    }
    res.writeHead(err.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(err.toBody()));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

console.log('— Host / Origin / CSRF（真实请求）');
async function call(opts) {
  const res = await fetch(`${base}${opts.path ?? '/api/echo'}`, {
    method: opts.method ?? 'POST',
    headers: opts.headers ?? {},
    body: opts.body,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, headers: res.headers };
}

const good = await call({
  headers: { 'content-type': 'application/json', 'x-agentd-csrf': 'csrf-secret' },
  body: JSON.stringify({ hello: 'world' }),
});
check('合法写请求 200', good.status === 200, JSON.stringify(good.json));
check('body 被解析', good.json?.body?.hello === 'world');

const noCsrf = await call({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
check('缺 CSRF → 403', noCsrf.status === 403 && noCsrf.json.error.code === 'E_CSRF', JSON.stringify(noCsrf.json));

const badCsrf = await call({ headers: { 'content-type': 'application/json', 'x-agentd-csrf': 'wrong' }, body: '{}' });
check('错 CSRF → 403', badCsrf.status === 403 && badCsrf.json.error.code === 'E_CSRF');

const badOrigin = await call({
  headers: { 'content-type': 'application/json', 'x-agentd-csrf': 'csrf-secret', origin: 'http://evil.example' },
  body: '{}',
});
check('跨源 Origin → 403', badOrigin.status === 403 && badOrigin.json.error.code === 'E_ORIGIN', JSON.stringify(badOrigin.json));

const okOrigin = await call({
  headers: { 'content-type': 'application/json', 'x-agentd-csrf': 'csrf-secret', origin: 'http://127.0.0.1:8791' },
  body: '{}',
});
check('同源 Origin → 200', okOrigin.status === 200);

const badJson = await call({ headers: { 'content-type': 'application/json', 'x-agentd-csrf': 'csrf-secret' }, body: '{not json' });
check('非法 JSON → 400', badJson.status === 400 && badJson.json.error.code === 'E_VALIDATION');

const big = await call({
  headers: { 'content-type': 'application/json', 'x-agentd-csrf': 'csrf-secret' },
  body: JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES + 1000) }),
});
check('超大 body → 400 而非断连', big.status === 400 && big.json?.error?.code === 'E_VALIDATION', `status=${big.status} ${JSON.stringify(big.json)}`);

// Host 校验：伪造 Host 头
const rebind = await new Promise((resolve) => {
  const req = http.request(
    { host: '127.0.0.1', port, path: '/api/echo', method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json', 'x-agentd-csrf': 'csrf-secret' } },
    (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    },
  );
  req.end('{}');
});
check('伪造 Host（DNS rebinding）→ 403', rebind.status === 403, rebind.data);
check('错误体是 E_ORIGIN', JSON.parse(rebind.data).error.code === 'E_ORIGIN');

console.log('— 静态托管');
const idx = await fetch(`${base}/`);
check('index.html 200', idx.status === 200);
check('index CSP 头', (idx.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"));
check('index 无通配 CORS', idx.headers.get('access-control-allow-origin') === null);
const js = await fetch(`${base}/app.js`);
check('app.js mime', (js.headers.get('content-type') ?? '').includes('javascript'));
const trav = await fetch(`${base}/../http.ts`);
check('目录穿越被挡', trav.status === 404, String(trav.status));
const missing = await fetch(`${base}/definitely-missing.json`);
check('缺失资源 404', missing.status === 404);

server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
