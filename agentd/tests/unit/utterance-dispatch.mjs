/**
 * 语音 final 分发器（GH-13 验收判据 7/8）。
 *
 * 顺序被钉死：回声/空文本 → 审批 settle → 忙 → 提交。
 * 这里守两件最容易写反的事：
 * - 回声（含机器人自己念出的「确认」）不能 settle 审批，也不能建 run；
 * - 审批窗口开着时，即使同时存在活动 run，这句话也只进 settle，
 *   不能新建 run，也不能记 speech_ignored。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Store, nowIso } from '../../src/agentd/store.ts';
import { EventLog, loadRegistry } from '../../src/agentd/events.ts';
import { RunService } from '../../src/agentd/runs.ts';
import { RobotdEventBridge } from '../../src/agentd/robotd-event-bridge.ts';

const root = new URL('../../../work/agentd-utterance-test', import.meta.url).pathname;
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

const store = new Store(path.join(root, 'agentd.sqlite'), { log: () => {} });
const events = new EventLog(store, loadRegistry(), 'boot-utterance');
const log = () => {};

function makeService(submit) {
  return new RunService({ store, events, log, submitUtterance: submit });
}

function runCount() {
  return store.one('SELECT COUNT(*) AS n FROM runs').n;
}

function ignoredEvents(utteranceId) {
  return store.all(
    "SELECT params_json FROM events WHERE type = 'observation.speech_ignored' AND params_json LIKE ?",
    `%${utteranceId}%`,
  );
}

console.log('— 判据 7a：回声只记事件，不建 run');
{
  const submitted = [];
  const svc = makeService((input) => {
    submitted.push(input);
    return { run_id: 'run-should-not-exist' };
  });
  const before = runCount();
  const res = svc.dispatchUtterance({ utterance_id: 'u-echo', text: '往前走一步', echo: true });
  check('动作为 ignored_echo', res.action === 'ignored_echo', res.action);
  check('没有调用提交入口', submitted.length === 0, JSON.stringify(submitted));
  check('没有新建 run', runCount() === before, String(runCount()));
  const ev = ignoredEvents('u-echo');
  check('写了 observation.speech_ignored', ev.length === 1, String(ev.length));
  check(
    '忽略原因是 echo',
    ev[0] ? JSON.parse(ev[0].params_json).reason === 'echo' : false,
    ev[0]?.params_json,
  );
}

console.log('— 判据 7b：回声不能 settle 审批（自听里的「确认」不算数）');
{
  const svc = makeService(() => ({ run_id: 'nope' }));
  const run = svc.submitRun({ prompt: '跟着我', route: 'fast' });
  const approval = svc.createApproval({
    runId: run.run_id,
    capability: 'robot_follow',
    actionLabel: '向前跟随',
    argsSummary: '目标：我',
  });
  svc.markApprovalAnnounced(approval.approval_id, '请确认：向前跟随。确认请说“确认”。');
  const window = svc.openConfirmationWindow(approval.approval_id, 30_000);
  const res = svc.dispatchUtterance({
    utterance_id: 'u-self',
    text: '确认',
    echo: true,
    started_at: new Date(Date.parse(window.window_opens_at) + 10).toISOString(),
  });
  check('动作为 ignored_echo', res.action === 'ignored_echo', res.action);
  check('审批仍是 waiting', svc.getApproval(approval.approval_id)?.status === 'waiting');
  check('run 仍在等确认', svc.getRunDetail(run.run_id).run.status === 'waiting_confirmation');
  svc.cancelRun(run.run_id, '清理');
}

console.log('— 判据 8：审批窗口 + 活动 run，final 只进 settle');
{
  const submitted = [];
  const svc = makeService((input) => {
    submitted.push(input);
    return { run_id: 'run-should-not-exist' };
  });
  const run = svc.submitRun({ prompt: '跟着我', route: 'fast' });
  const approval = svc.createApproval({
    runId: run.run_id,
    capability: 'robot_follow',
    actionLabel: '向前跟随',
    argsSummary: '目标：我',
  });
  svc.markApprovalAnnounced(approval.approval_id, '请确认：向前跟随。确认请说“确认”。');
  const window = svc.openConfirmationWindow(approval.approval_id, 30_000);
  const before = runCount();
  check('存在活动 run（waiting_confirmation 本身占名额）', svc.activeRun()?.run_id === run.run_id);

  const res = svc.dispatchUtterance({
    utterance_id: 'u-confirm',
    text: '确认',
    echo: false,
    started_at: new Date(Date.parse(window.window_opens_at) + 10).toISOString(),
  });
  check('走审批分支', res.action === 'approval', res.action);
  check('settle 结果为 approved', res.approval?.outcome === 'approved', res.approval?.outcome);
  check('没有新建 run', runCount() === before, String(runCount()));
  check('没有调用提交入口', submitted.length === 0, JSON.stringify(submitted));
  check('没有记 speech_ignored', ignoredEvents('u-confirm').length === 0);
  check('审批已结算', svc.getApproval(approval.approval_id)?.status === 'approved');
  svc.cancelRun(run.run_id, '清理');
}

console.log('— 忙时（无审批窗口）：记 speech_ignored {busy}，不建 run');
{
  const submitted = [];
  const svc = makeService((input) => {
    submitted.push(input);
    return { run_id: 'run-should-not-exist' };
  });
  const active = svc.submitRun({ prompt: '正在执行的任务', route: 'harness' });
  svc.transition(active.run_id, 'executing');
  const before = runCount();
  const res = svc.dispatchUtterance({ utterance_id: 'u-busy', text: '往前走一步', echo: false });
  check('动作为 ignored_busy', res.action === 'ignored_busy', res.action);
  check('返回活动 run', res.run_id === active.run_id);
  check('没有新建 run', runCount() === before, String(runCount()));
  check('没有调用提交入口', submitted.length === 0);
  const ev = ignoredEvents('u-busy');
  check('忽略原因是 busy', ev[0] ? JSON.parse(ev[0].params_json).reason === 'busy' : false, ev[0]?.params_json);
  svc.cancelRun(active.run_id, '清理');
}

console.log('— 正常兜底：交给与 POST /api/run 相同的提交入口');
{
  const submitted = [];
  const svc = makeService((input) => {
    submitted.push(input);
    return { run_id: 'run-fast-1' };
  });
  const res = svc.dispatchUtterance({ utterance_id: 'u-normal', text: '停止', echo: false });
  check('动作为 submitted', res.action === 'submitted', res.action);
  check('提交了原文', submitted[0]?.text === '停止', JSON.stringify(submitted));
  check('提交带 utterance_id（装配层据此做幂等键）', submitted[0]?.utterance_id === 'u-normal');
  check('返回新 run id', res.run_id === 'run-fast-1');
}

console.log('— 忙时「停」不被吞掉（受保护规则优先于忙判定）');
{
  const submitted = [];
  const svc = makeService((input) => {
    submitted.push(input);
    return { run_id: 'run-stop' };
  });
  const active = svc.submitRun({ prompt: '正在执行的任务', route: 'harness' });
  svc.transition(active.run_id, 'executing');
  const res = svc.dispatchUtterance({ utterance_id: 'u-stop-busy', text: '停', echo: false });
  check('停止仍被提交', res.action === 'submitted', res.action);
  check('提交的是停止指令', submitted[0]?.text === '停', JSON.stringify(submitted));
  check('没有记 busy 忽略', ignoredEvents('u-stop-busy').length === 0);
  svc.cancelRun(active.run_id, '清理');
}

console.log('— 竞态 E_BUSY 降级为 busy，不抛给事件桥');
{
  const svc = makeService(() => {
    throw Object.assign(new Error('已有任务在进行中'), { code: 'E_BUSY' });
  });
  const res = svc.dispatchUtterance({ utterance_id: 'u-race', text: '往前走', echo: false });
  check('动作为 ignored_busy', res.action === 'ignored_busy', res.action);
  check('写了一条 busy 事件', ignoredEvents('u-race').length === 1);
}

console.log('— 空文本不建 run');
{
  const submitted = [];
  const svc = makeService((input) => {
    submitted.push(input);
    return { run_id: 'x' };
  });
  const res = svc.dispatchUtterance({ utterance_id: 'u-empty', text: '   ', echo: false });
  check('动作为 ignored_empty', res.action === 'ignored_empty', res.action);
  check('没有提交', submitted.length === 0);
}

console.log('— 事件桥把 echo 事实交给分发器（播报期间听到的 final 不算指令）');
{
  const submitted = [];
  const svc = makeService((input) => {
    submitted.push(input);
    return { run_id: 'run-from-bridge' };
  });
  const bridge = new RobotdEventBridge({
    events,
    store,
    hooks: { onUtteranceHeard: (input) => svc.dispatchUtterance(input) },
  });
  // 播报进行中：期间开始的这一轮被事件桥判定为 echo。
  bridge.handle({ type: 'speech.tts_started', payload: { response_id: 'tts-echo', task_id: 't-echo' } });
  bridge.handle({ type: 'speech.started', payload: { utterance_id: 'u-during-tts', aec_erle_db: 20 } });
  bridge.handle({
    type: 'speech.final',
    payload: { utterance_id: 'u-during-tts', text: '确认', stop_reason: 'endpoint' },
  });
  check('播报期间的 final 没有提交', submitted.length === 0, JSON.stringify(submitted));
  check(
    '事件库记录了 echo 忽略',
    ignoredEvents('u-during-tts').length === 1,
    String(ignoredEvents('u-during-tts').length),
  );

  // 播报结束后：同一套路径应正常提交。
  bridge.handle({ type: 'speech.tts_finished', payload: { response_id: 'tts-echo', chunks: 1, played: 1 } });
  bridge.handle({ type: 'speech.started', payload: { utterance_id: 'u-after-tts', aec_erle_db: 20 } });
  bridge.handle({
    type: 'speech.final',
    payload: { utterance_id: 'u-after-tts', text: '停止', stop_reason: 'endpoint' },
  });
  check('播报结束后的 final 被提交', submitted.length === 1, JSON.stringify(submitted));
  check('提交的是原话', submitted[0]?.text === '停止', JSON.stringify(submitted[0]));
}

store.close();
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
