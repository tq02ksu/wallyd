/**
 * 手动验证（不进 `npm test`）：直接驱动 createRuntime **已注册**的 `POST /api/run`
 * handler，覆盖 GH-27 的装配层行为——澄清不建 run、澄清后的「停」可执行、
 * `waiting_confirmation` 时的「停」仍可达、普通请求仍 E_BUSY。
 *
 * 为什么要打 listen 补丁：受限沙箱（以及部分 CI 容器）禁止 `listen(127.0.0.1)`，
 * 会直接 EPERM。这里不测 HTTP 传输层（那由 e2e 用真 robotd 覆盖），只测 handler 装配，
 * 所以把 `listen` 变成「立即回调」即可；router.match + handler 仍是生产代码路径。
 *
 * 用法：node --experimental-strip-types agentd/tests/manual/run-api-verify.mjs
 */
import http from 'node:http';
http.Server.prototype.listen = function (...args) {
  const cb = args.find((a) => typeof a === 'function');
  if (cb) process.nextTick(cb);
  return this;
};
import fs from 'node:fs';
import { createRuntime, defaultConfig, makeLogger } from '../../src/agentd/service.ts';

const root = new URL('../../../work/agentd-test/run-api-runtime', import.meta.url).pathname;
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

let failed = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
};

const runtime = await createRuntime(
  { ...defaultConfig(), httpPort: 0, dataDir: root, staticDir: null, logLevel: 'error', robotdUrl: 'http://127.0.0.1:1' },
  { log: makeLogger('error') },
);
try {
  const hit = runtime.router.match('POST', '/api/run');
  check('POST /api/run 已注册', Boolean(hit));
  const call = (body) => hit.route.handler({ req: {}, res: {}, params: {}, query: {}, body, sameOrigin: true });
  const runCount = () => runtime.store.one('SELECT COUNT(*) AS n FROM runs').n;

  // 能力表已知但没有 robot_stop → 路由必须澄清
  runtime.robotd.capabilities.store(
    [{ name: 'robot_speak', description: '', inputSchema: {}, approvalParams: ['text'] }],
    null,
  );
  const c = await call({ prompt: '停' });
  check('澄清响应 route=clarified', c.route === 'clarified', JSON.stringify(c));
  check('澄清响应没有 run_id', c.run_id == null);
  check('澄清没有写 run', runCount() === 0, String(runCount()));
  for (let i = 0; i < 2; i += 1) await call({ prompt: '停' });
  check('3 次澄清仍是 0 条 run', runCount() === 0, String(runCount()));
  const clarifyEvents = runtime.events.query({ limit: 50 }).events.filter((e) => e.type === 'route.clarify');
  check('写了 3 条 route.clarify', clarifyEvents.length === 3, String(clarifyEvents.length));

  // 恢复能力表：紧接着的「停」必须真的执行
  runtime.robotd.capabilities.store(
    [{ name: 'robot_stop', description: '', inputSchema: {} }],
    null,
  );
  let stopped = 0;
  runtime.robotd.callCapability = async () => {
    stopped += 1;
    return { robot_task_id: 't-verify' };
  };
  const stop = await call({ prompt: '停' });
  check('澄清后「停」被受理', typeof stop.run_id === 'string', JSON.stringify(stop));
  await new Promise((r) => setTimeout(r, 100));
  check('「停」真的下发到 robotd', stopped === 1, String(stopped));
  check('「停」run 已成功', runtime.runs.getRunRow(stop.run_id)?.status === 'succeeded', runtime.runs.getRunRow(stop.run_id)?.status);

  // 忙（waiting_confirmation）时「停」仍可达，普通请求仍 409
  const active = runtime.runs.submitRun({ prompt: '等确认', route: 'harness' });
  runtime.runs.transition(active.run_id, 'waiting_confirmation', { reason: 'approval_required' });
  let busyCode = null;
  try {
    await call({ prompt: '去厨房看看' });
  } catch (e) {
    busyCode = e.code;
  }
  check('普通请求遇忙 E_BUSY', busyCode === 'E_BUSY', String(busyCode));
  const stop2 = await call({ prompt: '停' });
  check('waiting_confirmation 时「停」仍被受理', typeof stop2.run_id === 'string', JSON.stringify(stop2));
  await new Promise((r) => setTimeout(r, 100));
  check('第二次「停」也真的下发', stopped === 2, String(stopped));
  runtime.runs.cancelRun(active.run_id, '清理');
} finally {
  await runtime.close();
}
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
