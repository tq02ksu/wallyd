/**
 * 手验：`POST /api/run` 的准入逻辑（`run-request.ts`）。
 *
 * 覆盖 GH-27 的核心约定：
 *   - 澄清 / 歧义**不创建 run**，因此不占活动名额，也不会留下永不推进的 run；
 *   - 受保护的停止规则是安全旁路：忙的时候「停」仍能进路由并执行；
 *   - 其余请求仍遵守「活动 run 上限 1」。
 *
 * 这里直接调用装配层使用的 `submitRunRequest`，不监听端口：沙箱不允许 `listen`，
 * 而本文件的断言对象是「一句话落成 run 还是澄清」这件事本身。
 * 规则表通过参数注入，用来构造本工作树尚未包含的缺参场景（V05 的 `过来`），
 * 不修改 `matchRoute` 的默认规则。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/agentd/store.ts';
import { EventLog, loadRegistry } from '../../src/agentd/events.ts';
import { RunService } from '../../src/agentd/runs.ts';
import { FAST_RULES } from '../../src/agentd/router.ts';
import { submitRunRequest } from '../../src/agentd/run-request.ts';
import { toApiError } from '../../src/agentd/http.ts';

const root = new URL('../../../work/agentd-test/run-request-runtime', import.meta.url).pathname;
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

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
    return 'no-throw';
  } catch (e) {
    const mapped = toApiError(e);
    return mapped.code === code ? 'ok' : `${e.name}:${mapped.code}:${mapped.message}`;
  }
}

const store = new Store(path.join(root, 'agentd.sqlite'), { log: () => {} });
const events = new EventLog(store, loadRegistry(), 'boot-run-request');
const svc = new RunService({ store, events, log: () => {} });

function runCount() {
  return store.one('SELECT COUNT(*) AS n FROM runs').n;
}
function clarifyEvents() {
  return events.query({ limit: 200 }).events.filter((e) => e.type === 'route.clarify');
}

// 「过来」现在由规则表里的 `come_here@1` 覆盖：命中但缺 `target_track_id` → 澄清。
// 这里用生产规则表，不再注入伪造规则（V05 落地前那份注入已经多余且会造成重复 id）。
const executed = [];
const harnessExecuted = [];
const deps = {
  runs: svc,
  availableCapabilities: () => new Set(['robot_stop', 'robot_follow']),
  executeFast: (runId, capability, args) => executed.push({ runId, capability, args }),
  executeHarness: (runId) => harnessExecuted.push(runId),
};


console.log('— 澄清不建 run');
const c1 = submitRunRequest(deps, { prompt: '过来' });
check('返回 route=clarified', c1.route === 'clarified', c1.route);
check('没有 run_id', c1.run_id === undefined || c1.run_id === null, String(c1.run_id));
check('没有 status', c1.status === undefined || c1.status === null, String(c1.status));
check('带澄清问题', typeof c1.clarify?.question === 'string' && c1.clarify.question.length > 0, JSON.stringify(c1));
check('缺参如实给出', c1.clarify?.missing?.includes('slot:target_track_id') === true, JSON.stringify(c1.clarify));
check('库里 0 条 run', runCount() === 0, String(runCount()));
const cev = clarifyEvents();
check('写了 route.clarify 事件', cev.length === 1, cev.map((e) => e.type).join(','));
check('澄清事件可读', cev[0]?.title === '没听明白要做什么' && !cev[0].summary.includes('{'), JSON.stringify(cev[0]?.summary));
check('澄清事件建议无占位符', typeof cev[0]?.advice === 'string' && cev[0].advice.length > 0 && !cev[0].advice.includes('{'), JSON.stringify(cev[0]?.advice));

console.log('— 澄清之后紧接着「停」必须能执行');
const stop = submitRunRequest(deps, { prompt: '停' });
check('「停」不是 E_BUSY', stop.route === 'fast' && typeof stop.run_id === 'string', JSON.stringify(stop));
check('「停」被真正下发', executed.at(-1)?.capability === 'robot_stop', JSON.stringify(executed.at(-1)));
svc.cancelRun(stop.run_id, '测试收尾');
check('收尾后无活动 run', svc.activeRun() === null, JSON.stringify(svc.activeRun()));

console.log('— 连续 3 次澄清不留卡住的 run');
const s = svc.createSession('澄清会话');
const before = runCount();
for (let i = 0; i < 3; i += 1) submitRunRequest(deps, { prompt: '过来', session_id: s.session_id });
check('3 次澄清新增 0 条 run', runCount() === before, `${before} → ${runCount()}`);
check('3 条澄清事件都写了', clarifyEvents().length === 4, String(clarifyEvents().length));
// events.query 按新→旧返回，最新一条是 [0]
check('澄清事件带会话', clarifyEvents()[0]?.session_id === s.session_id, JSON.stringify(clarifyEvents()[0]));
const sess = svc.getSession(s.session_id, null, 50);
check('澄清的话仍进会话历史', sess.messages.filter((m) => m.text === '过来').length === 3, JSON.stringify(sess.messages));

console.log('— 忙的时候：普通请求仍 409，「停」仍可达');
const active = svc.submitRun({ prompt: '等模型理解', route: 'harness' });
// 模拟「已识别目标、等审批」的等待状态：它同样是非终态、同样占用活动名额。
svc.transition(active.run_id, 'waiting_confirmation', { reason: 'approval_required' });
check('普通请求遇忙 E_BUSY', expectApi(() => submitRunRequest(deps, { prompt: '去厨房看看' }), 'E_BUSY') === 'ok');
check('waiting_confirmation 也算活动 run', svc.activeRun()?.run_id === active.run_id, JSON.stringify(svc.activeRun()));
const stopBusy = submitRunRequest(deps, { prompt: '停' });
check('忙时「停」不被 E_BUSY 拦住', stopBusy.route === 'fast' && typeof stopBusy.run_id === 'string', JSON.stringify(stopBusy));
check('忙时「停」真的下发', executed.at(-1)?.capability === 'robot_stop', JSON.stringify(executed.at(-1)));
const activeBeforeClarify = svc.activeRun()?.run_id;
const clarifyWhileBusy = submitRunRequest(deps, { prompt: '过来' });
check('忙时澄清也不报 E_BUSY', clarifyWhileBusy.route === 'clarified', JSON.stringify(clarifyWhileBusy));
check('忙时澄清没有增加活动 run', svc.activeRun()?.run_id === activeBeforeClarify);
svc.cancelRun(stopBusy.run_id, '测试收尾');
svc.cancelRun(active.run_id, '测试收尾');

console.log('— 歧义同样不建 run');
const comeHere = FAST_RULES.find((r) => r.id === 'come_here');
// 再叠一条同形规则制造歧义：都是「过来」，但 id 不同。
const ambiguousDeps = { ...deps, rules: [...FAST_RULES, { ...comeHere, id: 'come_here_v2' }] };
const amb = submitRunRequest(ambiguousDeps, { prompt: '过来' });
check('歧义返回 route=clarified', amb.route === 'clarified', JSON.stringify(amb));
check('歧义带候选', Array.isArray(amb.ambiguous) && amb.ambiguous.length === 2, JSON.stringify(amb.ambiguous));
check('歧义没有 run_id', amb.run_id === undefined || amb.run_id === null);
check('歧义没有新增 run', svc.activeRun() === null);

console.log('— 守卫拦下的命中：日志说明原因，不猜着执行');
const logged = [];
const execBefore = executed.length;
const blocked = submitRunRequest(
  { ...deps, log: (m, x) => logged.push({ m, x }) },
  { prompt: '别过来' },
);
check('记了一条 router.blocked', logged.length === 1 && logged[0].m === 'router.blocked', JSON.stringify(logged));
check('原因标成否定', logged[0]?.x?.blocked?.[0]?.reason === 'negation', JSON.stringify(logged[0]));
check('没有下发任何能力', executed.length === execBefore, String(executed.length - execBefore));
check('拦下的命中落成 harness，不是快速路由', blocked.route === 'harness', blocked.route);
check('harness run 真的交给执行器', harnessExecuted.at(-1) === blocked.run_id, JSON.stringify(harnessExecuted));
if (blocked.run_id) svc.cancelRun(blocked.run_id, '测试收尾');

console.log('— 普通复杂指令也交给 Harness，而不是停在 accepted');
const complex = submitRunRequest(deps, { prompt: '去厨房看看有没有人' });
check('route=harness', complex.route === 'harness', JSON.stringify(complex));
check('harness 执行器收到同一个 run_id', harnessExecuted.at(-1) === complex.run_id, JSON.stringify(harnessExecuted));
check('两次 harness 都触发了执行', harnessExecuted.length === 2, String(harnessExecuted.length));
if (complex.run_id) svc.cancelRun(complex.run_id, '测试收尾');

store.close();
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
