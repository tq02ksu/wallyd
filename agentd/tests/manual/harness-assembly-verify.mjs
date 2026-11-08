/**
 * 手动验证（不进 `npm test`）：装配层 Harness 状态与「无凭证不崩」。
 *
 * 受限沙箱禁止 `listen(127.0.0.1)`，所以只把 listen 变成「立即回调」，
 * router.match + handler + createRuntime 仍是生产代码路径。覆盖 GH-10 判据 1/6：
 *
 * - `--harness <path>` 后 `/api/state` 的 `brain.harness.state == "ready"`；
 * - 没有 `CODEX_API_KEY` / `OPENAI_API_KEY` 时，复杂指令的 run 不崩，
 *   停在 `failed {reason:"harness_unconfigured"}`。
 *
 * 用法：node --experimental-strip-types agentd/tests/manual/harness-assembly-verify.mjs
 */
import http from 'node:http';
http.Server.prototype.listen = function (...args) {
  const cb = args.find((a) => typeof a === 'function');
  if (cb) process.nextTick(cb);
  return this;
};
import fs from 'node:fs';
import path from 'node:path';
import { createRuntime, defaultConfig, makeLogger } from '../../src/agentd/service.ts';

const root = new URL('../../../work/agentd-test/harness-assembly', import.meta.url).pathname;
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
process.env.AGENTD_CODEX_HOME = path.join(root, 'codex-home');
const fakeBinary = path.join(root, 'fake-codex');
fs.writeFileSync(fakeBinary, '#!/bin/sh\necho "codex-cli 9.9.9-assembly"\n', 'utf8');
fs.chmodSync(fakeBinary, 0o755);
delete process.env.CODEX_API_KEY;
delete process.env.OPENAI_API_KEY;

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

const runtime = await createRuntime(
  {
    ...defaultConfig(),
    httpPort: 0,
    dataDir: root,
    staticDir: null,
    logLevel: 'error',
    robotdUrl: 'http://127.0.0.1:1',
    harnessBinary: fakeBinary,
  },
  { log: makeLogger('error') },
);

try {
  const stateHit = runtime.router.match('GET', '/api/state');
  const state = await stateHit.route.handler({
    req: {},
    res: {},
    params: {},
    query: {},
    body: undefined,
    sameOrigin: true,
  });
  check(
    'brain.harness.state == ready',
    state.brain.harness.state === 'ready',
    JSON.stringify(state.brain.harness),
  );
  check(
    'version 可读',
    String(state.brain.harness.version).includes('9.9.9-assembly'),
    String(state.brain.harness.version),
  );
  check(
    'codex_home 是隔离目录',
    state.brain.harness.codex_home === process.env.AGENTD_CODEX_HOME,
    state.brain.harness.codex_home,
  );

  const runHit = runtime.router.match('POST', '/api/run');
  const call = (body) =>
    runHit.route.handler({ req: {}, res: {}, params: {}, query: {}, body, sameOrigin: true });
  const res = await call({ prompt: '去厨房看看有没有人' });
  check('复杂指令建 harness run', res.route === 'harness' && Boolean(res.run_id), JSON.stringify(res));

  const deadline = Date.now() + 3000;
  let detail = null;
  while (Date.now() < deadline) {
    detail = runtime.runs.getRunDetail(res.run_id);
    if (['failed', 'succeeded', 'cancelled'].includes(detail.run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  check('无 key 时 run 不崩，终态 failed', detail?.run.status === 'failed', detail?.run.status);
  check(
    '原因 harness_unconfigured',
    detail?.result.reason === 'harness_unconfigured',
    JSON.stringify(detail?.result),
  );
} finally {
  await runtime.close();
}

console.log('');
if (failed > 0) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('装配层验证通过');
