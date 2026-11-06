/**
 * 手验：RunService 对真实 Store + EventLog 的行为。
 * 重点验证「状态与事件同事务」「幂等」「崩溃恢复对账」「事件类型必须已登记」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Store, nowIso } from '../../src/agentd/store.ts';
import { EventLog, loadRegistry } from '../../src/agentd/events.ts';
import { RunService, isTerminal } from '../../src/agentd/runs.ts';
import { ApiError, toApiError } from '../../src/agentd/http.ts';

// 运行产物统一落到 work/（见 .gitignore），测试代码本身留在 tests/ 里受版本控制。
const root = new URL('../../../work/agentd-test/runtime', import.meta.url).pathname;
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

const dbPath = path.join(root, 'agentd.sqlite');
const store = new Store(dbPath, { log: () => {} });
const registry = loadRegistry();
const bootId = 'boot-test-1';
const events = new EventLog(store, registry, bootId);
const log = () => {};
const svc = new RunService({ store, events, log });

console.log('— 会话');
const s1 = svc.createSession('试试');
check('会话有 id', typeof s1.session_id === 'string');
check('会话标题', s1.title === '试试');
check('默认标题非空', typeof svc.createSession(null).title === 'string');
const sessPage = svc.listSessions(null, 50);
check('会话分页形状', sessPage.ok === true && Array.isArray(sessPage.sessions));

console.log('— 提交任务 + 事件同事务');
const r1 = svc.submitRun({ prompt: '往前走一米', session_id: s1.session_id, route: 'harness' });
check('run 受理', typeof r1.run_id === 'string' && r1.status === 'accepted');
check('非重复', r1.duplicate === false);

const evAfter = events.query({ limit: 50 });
check('写了 run.accepted 事件', evAfter.events.some((e) => e.type === 'run.accepted' && e.run_id === r1.run_id));
const accepted = evAfter.events.find((e) => e.type === 'run.accepted');
check('标题是中文且已填充', accepted.title === '收到请求', accepted.title);
check('摘要不含未解析占位符', !accepted.summary.includes('{'), accepted.summary);
console.log(`       摘要: ${accepted.summary}`);

console.log('— 幂等');
const dup = svc.submitRun({ prompt: '往前走一米', route: 'harness', idempotency_key: 'k-1' });
const dup2 = svc.submitRun({ prompt: '往前走一米', route: 'harness', idempotency_key: 'k-1' });
check('同幂等键返回同 run', dup.run_id === dup2.run_id);
check('第二次标 duplicate', dup2.duplicate === true);
const runCount = store.one('SELECT COUNT(*) AS n FROM runs WHERE idempotency_key = ?', 'k-1').n;
check('只产生 1 条 run', runCount === 1, String(runCount));

console.log('— 状态机');
svc.transition(r1.run_id, 'understanding');
svc.transition(r1.run_id, 'planning');
svc.transition(r1.run_id, 'executing');
const afterExec = events.query({ limit: 50 }).events.filter((e) => e.run_id === r1.run_id);
check('阶段推进写了 step_changed', afterExec.some((e) => e.type === 'run.step_changed'));
const stepEv = afterExec.find((e) => e.type === 'run.step_changed' && e.title.includes('正在执行'));
check('阶段标题可读', Boolean(stepEv), afterExec.map((e) => `${e.type}:${e.title}`).join(' | '));

svc.transition(r1.run_id, 'succeeded', { detail: '已到达目标位置' });
const detail = svc.getRunDetail(r1.run_id);
check('终态 succeeded', detail.run.status === 'succeeded');
check('result.outcome', detail.result.outcome === 'succeeded');
check('duration_ms 有值', typeof detail.run.duration_ms === 'number' && detail.run.duration_ms >= 0);
const finEv = events.query({ limit: 50 }).events.find((e) => e.type === 'run.finished' && e.run_id === r1.run_id);
check('run.finished 事件存在', Boolean(finEv));
check('finished 标题按结局渲染', finEv.title === '任务已完成', finEv.title);
check('finished 摘要无占位符', !finEv.summary.includes('{'), finEv.summary);
console.log(`       ${finEv.title} / ${finEv.summary}`);

check('终态不可改写', expectApi(() => svc.transition(r1.run_id, 'executing'), 'E_CONFLICT') === 'ok');

console.log('— 取消');
const r2 = svc.submitRun({ prompt: '去客厅', route: 'harness' });
svc.transition(r2.run_id, 'executing');
const cancel = svc.cancelRun(r2.run_id, null);
check('取消生效', cancel.changed === true);
check('取消后终态', isTerminal(cancel.detail.run.status) && cancel.detail.run.status === 'cancelled');
const cancelEv = events.query({ limit: 50 }).events.find((e) => e.type === 'run.cancelled' && e.run_id === r2.run_id);
check('写 run.cancelled 事件', Boolean(cancelEv));
check('cancelled 摘要无占位符', !cancelEv.summary.includes('{'), cancelEv.summary);
const again = svc.cancelRun(r2.run_id, null);
check('重复取消不报错、不改变', again.changed === false && again.detail.run.status === 'cancelled');

console.log('— 未登记事件类型必须被拒');
try {
  events.emitStandalone({ type: 'run.succeeded', params: {} });
  check('未登记类型抛错', false);
} catch (e) {
  check('未登记类型抛错', e.message.includes('未在 agentd/contracts/events.json 登记'), `${e.name}:${e.message}`);
}

console.log('— 崩溃恢复对账');
const r3 = svc.submitRun({ prompt: '举起来', route: 'harness', idempotency_key: 'crash-1' });
svc.transition(r3.run_id, 'executing');
const r4 = svc.submitRun({ prompt: '放下来', route: 'harness', idempotency_key: 'crash-2' });
svc.transition(r4.run_id, 'executing');
// 模拟「工具已发出但没回结果」
store.transaction((tx) => {
  svc.recordToolCall(tx, r3.run_id, 'robot_lift', '举起', '{"height_mm":100}', 'running', {
    args: { height_mm: 100 },
    requiresApproval: true,
  });
});
const rec = svc.reconcileOnStartup();
// 3 条：r3（有未决调用）、r4，外加幂等用例里停在 accepted 的 dup run
check('对账报告中断数', rec.interrupted === 3, JSON.stringify(rec));
const r3d = svc.getRunDetail(r3.run_id);
const r4d = svc.getRunDetail(r4.run_id);
check('有未决调用的 → outcome_unknown', r3d.run.status === 'outcome_unknown', r3d.run.status);
check('无未决调用的 → interrupted', r4d.run.status === 'interrupted', r4d.run.status);
check('工具调用也标为 outcome_unknown', r3d.tool_calls[0]?.state === 'outcome_unknown');
check('不改写已成功的历史', svc.getRunDetail(r1.run_id).run.status === 'succeeded');
const recEv = events.query({ limit: 100 }).events.filter((e) => e.type === 'run.finished' && e.run_id === r3.run_id);
check('恢复写 run.finished（不谎称成功）', recEv.length === 1 && !recEv[0].title.includes('已完成'), recEv[0]?.title);

console.log('— 活动任务');
const r5 = svc.submitRun({ prompt: '继续', route: 'harness' });
check('activeRun 返回最新非终态', svc.activeRun()?.run_id === r5.run_id);
svc.cancelRun(r5.run_id, '清理');
check('全部终态后 activeRun 为 null', svc.activeRun() === null);

console.log('— 详情形状');
const d = svc.getRunDetail(r5.run_id);
for (const key of ['ok', 'run', 'steps', 'tool_calls', 'approvals', 'result', 'diagnostics']) {
  check(`详情含 ${key}`, key in d, JSON.stringify(Object.keys(d)));
}
check('run 必填字段齐全', ['run_id', 'prompt', 'status', 'created_at', 'route'].every((k) => k in d.run));

console.log('— 审批播报与确认窗口');
const r6 = svc.submitRun({ prompt: '跟着穿红衣服的人', route: 'fast' });
const ap1 = svc.createApproval({
  runId: r6.run_id,
  capability: 'robot_follow',
  actionLabel: '向前跟随',
  argsSummary: '目标：穿红衣服的人',
  argsJson: '{"target":"穿红衣服的人"}',
});
check('审批先落库', svc.getApproval(ap1.approval_id)?.status === 'persisted');
svc.markApprovalAnnounced(ap1.approval_id, '请确认：向前跟随。参数：目标：穿红衣服的人。确认请说“确认”。');
check('播报受理后状态 announced', svc.getApproval(ap1.approval_id)?.status === 'announced');
check(
  '受理不等于开窗',
  svc.getRunDetail(r6.run_id).run.status !== 'waiting_confirmation',
  svc.getRunDetail(r6.run_id).run.status,
);

const win = svc.openConfirmationWindow(ap1.approval_id, 30000);
check('播报完成后开窗', win.opened === true);
check('run 进入 waiting_confirmation', svc.getRunDetail(r6.run_id).run.status === 'waiting_confirmation');
const apRow = svc.getApproval(ap1.approval_id);
check('审批进入 waiting', apRow.status === 'waiting');
check('窗口开启时刻落库', typeof apRow.window_opens_at === 'string' && apRow.window_opens_at.length > 0);
check('窗口关闭时刻晚于开启', Date.parse(apRow.window_closes_at) > Date.parse(apRow.window_opens_at));
const waitRow = store.one(
  'SELECT params_json FROM events WHERE type = ? AND run_id = ?',
  'run.waiting_confirmation',
  r6.run_id,
);
const waitParams = JSON.parse(waitRow.params_json);
check('waiting_confirmation 带 approval_id', waitParams.approval_id === ap1.approval_id);
check('waiting_confirmation 带窗口开启时刻', waitParams.window_opened_at === apRow.window_opens_at);

const winAgain = svc.openConfirmationWindow(ap1.approval_id, 30000);
const waitCount = store.one(
  'SELECT COUNT(*) AS n FROM events WHERE type = ? AND run_id = ?',
  'run.waiting_confirmation',
  r6.run_id,
).n;
check('重复完成事件幂等', winAgain.opened === true && winAgain.reason === 'already_open' && waitCount === 1);
svc.cancelRun(r6.run_id, '清理审批用例');

console.log('— 播报失败不开窗');
const r7 = svc.submitRun({ prompt: '跟着我', route: 'fast' });
const ap2 = svc.createApproval({
  runId: r7.run_id,
  capability: 'robot_follow',
  actionLabel: '向前跟随',
  argsSummary: '目标：我',
});
const aborted = svc.abortApproval(ap2.approval_id, '系统播报未完成（bridge_exit）');
check('失败收尾生效', aborted.changed === true);
check('失败后 run failed', svc.getRunDetail(r7.run_id).run.status === 'failed');
check('失败后审批 cancelled', svc.getApproval(ap2.approval_id)?.status === 'cancelled');
const unavailable = store.one(
  'SELECT COUNT(*) AS n FROM events WHERE type = ? AND approval_id = ?',
  'approval.unavailable',
  ap2.approval_id,
).n;
check('失败发 approval.unavailable', unavailable === 1);
const windowForR7 = store.one(
  'SELECT COUNT(*) AS n FROM events WHERE type = ? AND run_id = ?',
  'run.waiting_confirmation',
  r7.run_id,
).n;
check('失败绝不开窗', windowForR7 === 0);

console.log('— 确认窗口只能由播报完成开启');
const r8 = svc.submitRun({ prompt: '绕过检查', route: 'fast' });
check(
  'transition 不能直改 waiting_confirmation',
  expectApi(() => svc.transition(r8.run_id, 'waiting_confirmation'), 'E_CONFLICT') === 'ok',
);
svc.cancelRun(r8.run_id, '清理');

console.log('— 不可写 fail-closed');
store.markUnwritable('磁盘满（模拟）');
check('写会话被拒 E_STORE', expectApi(() => svc.createSession('x'), 'E_STORE') === 'ok');
check('提交 run 被拒 E_STORE', expectApi(() => svc.submitRun({ prompt: 'x', route: 'fast' }), 'E_STORE') === 'ok');
store.probeWritable();

store.close();
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
