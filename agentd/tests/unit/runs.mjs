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
// GH-27：升级前遗留的 clarified run 停在 accepted，重启时不得被报成 interrupted。
const legacyClarified = svc.submitRun({ prompt: '过来', route: 'clarified' });
check('遗留澄清 run 仍是 accepted（模拟旧行为）', legacyClarified.status === 'accepted', legacyClarified.status);
const rec = svc.reconcileOnStartup();
// 3 条：r3（有未决调用）、r4，外加幂等用例里停在 accepted 的 dup run；遗留澄清 run 不算中断
check('对账报告中断数', rec.interrupted === 3, JSON.stringify(rec));
check('澄清类 run 不算中断', rec.details.every((d) => !d.startsWith(legacyClarified.run_id)), JSON.stringify(rec.details));
const legacyDetail = svc.getRunDetail(legacyClarified.run_id);
check('遗留澄清 run → cancelled（从未执行）', legacyDetail.run.status === 'cancelled', legacyDetail.run.status);
const legacyEv = events.query({ limit: 200 }).events.filter((e) => e.type === 'run.finished' && e.run_id === legacyClarified.run_id);
check('遗留澄清 run 写「已取消」而非中断', legacyEv.length === 1 && legacyEv[0].title === '任务已取消', JSON.stringify(legacyEv.map((e) => e.title)));
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

console.log('— 不可写 fail-closed');
store.markUnwritable('磁盘满（模拟）');
check('写会话被拒 E_STORE', expectApi(() => svc.createSession('x'), 'E_STORE') === 'ok');
check('提交 run 被拒 E_STORE', expectApi(() => svc.submitRun({ prompt: 'x', route: 'fast' }), 'E_STORE') === 'ok');
store.probeWritable();

store.close();
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
