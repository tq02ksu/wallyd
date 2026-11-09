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
import { ClarificationWindow } from '../../src/agentd/clarification-window.ts';

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

console.log('— GH-49：澄清被说出口，事件带 question');
const wroot = path.join(root, 'clarify-window.sqlite');
const wstore = new Store(wroot, { log: () => {} });
const wevents = new EventLog(wstore, loadRegistry(), 'boot-clarify-window');
const wsvc = new RunService({ store: wstore, events: wevents, log: () => {} });
let clock = 1_000_000;
const window = new ClarificationWindow({ now: () => clock, windowMs: 30_000 });
const announced = [];
const wExecuted = [];
const wHarness = [];
const wdeps = {
  runs: wsvc,
  availableCapabilities: () => new Set(['robot_stop', 'robot_follow']),
  executeFast: (runId, capability, args) => wExecuted.push({ runId, capability, args }),
  executeHarness: (runId) => wHarness.push(runId),
  clarificationWindow: window,
  announceClarification: (a) => announced.push(a),
};
function wRuns() {
  return wstore.one('SELECT COUNT(*) AS n FROM runs').n;
}
function wClarifyEvents() {
  return wevents.query({ limit: 300 }).events.filter((e) => e.type === 'route.clarify');
}
function wClarifyRaw() {
  return wstore
    .all("SELECT params_json FROM events WHERE type = 'route.clarify' ORDER BY seq DESC LIMIT 300")
    .map((r) => JSON.parse(r.params_json));
}
function wRunAcceptedRaw() {
  return wstore
    .all("SELECT params_json FROM events WHERE type = 'run.accepted' ORDER BY seq DESC LIMIT 300")
    .map((r) => JSON.parse(r.params_json));
}

const cw1 = submitRunRequest(wdeps, { prompt: '过来', source: 'asr' });
check('GH-49 澄清返回 clarified', cw1.route === 'clarified', JSON.stringify(cw1));
check('GH-49 澄清事件带 question', typeof wClarifyRaw()[0]?.question === 'string' && wClarifyRaw()[0].question.length > 0, JSON.stringify(wClarifyRaw()[0]));
check('GH-49 事件 question 与响应一致', wClarifyRaw()[0]?.question === cw1.clarify?.question, JSON.stringify(wClarifyRaw()[0]));
check('GH-49 事件 reason 结构化', wClarifyRaw()[0]?.reason === 'missing_arguments', JSON.stringify(wClarifyRaw()[0]));
check('GH-49 事件 data 也带 reason（接口可查）', wClarifyEvents()[0]?.data?.reason === 'missing_arguments', JSON.stringify(wClarifyEvents()[0]?.data));
check('GH-49 追问真的交给系统播报', announced.length === 1 && announced[0].kind === 'clarification', JSON.stringify(announced));
check('GH-49 播报只带结构化 missing', announced[0]?.missing?.includes('target_track_id') === true, JSON.stringify(announced[0]));
check('GH-49 播报不带用户原文', !JSON.stringify(announced[0]).includes('过来'), JSON.stringify(announced[0]));
check('GH-49 澄清不建 run', wRuns() === 0, String(wRuns()));
check('GH-49 窗口已打开', window.current()?.prompt === '过来', JSON.stringify(window.current()));

console.log('— GH-49 判据 2：5 秒内补充 → 拼接后命中 fast');
clock += 5_000;
const cw2 = submitRunRequest(wdeps, { prompt: 'track:t7', source: 'asr' });
check('GH-49 拼接后 route=fast', cw2.route === 'fast', JSON.stringify(cw2));
check('GH-49 拼接后命中 come_here@1', cw2.fast_rule === 'come_here@1', String(cw2.fast_rule));
check('GH-49 run.accepted.prompt 是拼接结果', wRunAcceptedRaw()[0]?.prompt === '过来 track:t7', JSON.stringify(wRunAcceptedRaw()[0]));
check('GH-49 拼接后的参数真的下发', wExecuted.at(-1)?.args?.target_track_id === 't7', JSON.stringify(wExecuted.at(-1)));
check('GH-49 拼接后窗口已消费', window.current() === null, JSON.stringify(window.current()));
wsvc.cancelRun(cw2.run_id, '测试收尾');

console.log('— GH-49 判据 3：超过 30 秒 → 不拼接，按新指令处理');
submitRunRequest(wdeps, { prompt: '过来', source: 'asr' });
clock += 31_000;
const cw3 = submitRunRequest(wdeps, { prompt: 'track:t7', source: 'asr' });
check('GH-49 过期补充不拼接', wRunAcceptedRaw()[0]?.prompt === 'track:t7', JSON.stringify(wRunAcceptedRaw()[0]));
check('GH-49 过期补充按新指令路由', cw3.route === 'harness', JSON.stringify(cw3));
check('GH-49 过期写了可查原因', wClarifyEvents().some((e) => e.data?.reason === 'window_expired'), JSON.stringify(wClarifyEvents().map((e) => e.data?.reason)));
wsvc.cancelRun(cw3.run_id, '测试收尾');

console.log('— GH-49 判据 4：窗口内说「算了」→ 清空、无 run、有原因');
submitRunRequest(wdeps, { prompt: '过来', source: 'asr' });
const beforeCancel = wRuns();
const cw4 = submitRunRequest(wdeps, { prompt: '算了', source: 'asr' });
check('GH-49 算了返回 clarified', cw4.route === 'clarified' && cw4.run_id === undefined, JSON.stringify(cw4));
check('GH-49 算了不建 run', wRuns() === beforeCancel, `${beforeCancel} → ${wRuns()}`);
check('GH-49 算了清空窗口', window.current() === null, JSON.stringify(window.current()));
check('GH-49 算了写收尾原因', wClarifyEvents()[0]?.data?.reason === 'user_cancelled', JSON.stringify(wClarifyEvents()[0]?.data));

console.log('— GH-49 判据 5：澄清期间说「停」仍走 STOP 旁路');
submitRunRequest(wdeps, { prompt: '过来', source: 'asr' });
const cw5 = submitRunRequest(wdeps, { prompt: '停', source: 'asr' });
check('GH-49 澄清期间「停」route=fast', cw5.route === 'fast' && cw5.fast_rule === 'stop_robot@1', JSON.stringify(cw5));
check('GH-49 澄清期间「停」真的下发', wExecuted.at(-1)?.capability === 'robot_stop', JSON.stringify(wExecuted.at(-1)));
check('GH-49 「停」关窗并留原因', wClarifyEvents()[0]?.data?.reason === 'stop', JSON.stringify(wClarifyEvents()[0]?.data));
check('GH-49 「停」不拼接上一句', wRunAcceptedRaw()[0]?.prompt === '停', JSON.stringify(wRunAcceptedRaw()[0]));
wsvc.cancelRun(cw5.run_id, '测试收尾');

console.log('— GH-49 判据 6：澄清不占活动名额，完整指令正常建 run');
submitRunRequest(wdeps, { prompt: '过来', source: 'asr' });
let busyError = null;
let cw6 = null;
try {
  cw6 = submitRunRequest(wdeps, { prompt: '过来 track:t7', source: 'asr' });
} catch (e) {
  busyError = e;
}
check('GH-49 澄清中完整指令不报 E_BUSY', busyError === null, String(busyError));
check('GH-49 完整指令不拼接上一句', wRunAcceptedRaw()[0]?.prompt === '过来 track:t7', JSON.stringify(wRunAcceptedRaw()[0]));
check('GH-49 完整指令正常建 run', typeof cw6?.run_id === 'string' && cw6.route === 'fast', JSON.stringify(cw6));
check('GH-49 完整指令顶掉窗口并留原因', wClarifyEvents()[0]?.data?.reason === 'superseded', JSON.stringify(wClarifyEvents()[0]?.data));
wsvc.cancelRun(cw6.run_id, '测试收尾');

console.log('— GH-49：拼接长度有上限，超过就重新问');
submitRunRequest(wdeps, { prompt: '过来', source: 'asr' });
const longFragment = 'x'.repeat(600);
const cw7 = submitRunRequest(wdeps, { prompt: longFragment, source: 'asr' });
check('GH-49 超长补充不拼接', cw7.route === 'clarified', JSON.stringify(cw7));
check('GH-49 超长补充写了原因', wClarifyEvents().some((e) => e.data?.reason === 'prompt_too_long'), JSON.stringify(wClarifyEvents().map((e) => e.data?.reason)));
check('GH-49 超长补充重新问而不是累加', window.current()?.prompt === longFragment, JSON.stringify(window.current()?.prompt));
check('GH-49 超长补充仍然播报追问', announced.at(-1)?.kind === 'clarification', JSON.stringify(announced.at(-1)));

console.log('— GH-49：歧义候选要念得出来，>3 只念前两条 +「还是别的」');
const comeHereRule = FAST_RULES.find((r) => r.id === 'come_here');
const manyRules = [
  ...FAST_RULES,
  { ...comeHereRule, id: 'come_here_v2', summary: '走到左边那位那儿' },
  { ...comeHereRule, id: 'come_here_v3', summary: '走到右边那位那儿' },
  { ...comeHereRule, id: 'come_here_v4', summary: '走到门口' },
];
const ambDeps = { ...wdeps, rules: manyRules };
const amb1 = submitRunRequest(ambDeps, { prompt: '过来' });
const ambQuestion = wClarifyRaw()[0]?.question;
check('GH-49 歧义返回 candidates', amb1.ambiguous?.length === 4, JSON.stringify(amb1.ambiguous));
check('GH-49 歧义响应也带 question', amb1.clarify?.question === ambQuestion, JSON.stringify(amb1.clarify));
check('GH-49 歧义 question 带候选摘要', ambQuestion?.includes('走到我这儿来') && ambQuestion?.includes('走到左边那位那儿'), JSON.stringify(ambQuestion));
check('GH-49 歧义 question 带「还是别的」', ambQuestion?.includes('还是别的') === true, JSON.stringify(ambQuestion));
check('GH-49 歧义播报只念前两条', announced.at(-1)?.candidates?.length === 2, JSON.stringify(announced.at(-1)));
check('GH-49 歧义播报带 more', announced.at(-1)?.more === true, JSON.stringify(announced.at(-1)));
check('GH-49 歧义事件也带 question', typeof ambQuestion === 'string' && ambQuestion.length > 0, JSON.stringify(wClarifyRaw()[0]));

wstore.close();
store.close();
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
