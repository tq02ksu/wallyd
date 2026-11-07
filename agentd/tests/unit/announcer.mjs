/**
 * ApprovalAnnouncer：审批复述的时序纪律。
 *
 * 核心断言：`robot_announce` 被受理 ≠ 用户听见了。只有 robotd 报 tts_finished
 * 才允许 run 进入 waiting_confirmation；失败/停止一律不开窗。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/agentd/store.ts';
import { EventLog, loadRegistry } from '../../src/agentd/events.ts';
import { RunService } from '../../src/agentd/runs.ts';
import { ApprovalAnnouncer } from '../../src/agentd/approval-announcer.ts';
import { RobotdEventBridge } from '../../src/agentd/robotd-event-bridge.ts';

const root = new URL('../../../work/agentd-announcer-test', import.meta.url).pathname;
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

class FakeRobotd {
  constructor() {
    this.calls = [];
    this.error = null;
    // 让测试能把「HTTP 响应」卡在播报完成事件之后，验证竞态。
    this.beforeReturn = null;
  }
  async announce(input) {
    this.calls.push(input);
    if (this.error) throw new Error(this.error);
    if (this.beforeReturn) await this.beforeReturn(input);
    return {
      task_id: `t-${this.calls.length}`,
      status: 'accepted',
      approval_id: input.approval_id,
      kind: input.kind,
      text: `请确认：${input.action_label}。参数：${input.args_summary}。确认请说“确认”。`,
    };
  }
}

const store = new Store(path.join(root, 'agentd.sqlite'), { log: () => {} });
const events = new EventLog(store, loadRegistry(), 'boot-announcer');
const runs = new RunService({ store, events, log: () => {} });
const robotd = new FakeRobotd();
const noted = [];
const announcer = new ApprovalAnnouncer({
  runs,
  robotd,
  log: () => {},
  windowMs: 30_000,
  announceTimeoutMs: 30_000,
  noteSpeak: (taskId, text) => noted.push({ taskId, text }),
});
const bridge = new RobotdEventBridge({
  events,
  store,
  hooks: { onAnnouncementFinished: (outcome) => announcer.onFinished(outcome) },
});

function approvalFor(prompt) {
  const run = runs.submitRun({ prompt, route: 'fast' });
  const approval = runs.createApproval({
    runId: run.run_id,
    capability: 'robot_follow',
    actionLabel: '向前跟随',
    argsSummary: '目标：穿红衣服的人',
    argsJson: '{"target":"穿红衣服的人"}',
  });
  return { run, approval };
}

function countEvents(type, approvalId) {
  return store.one(
    'SELECT COUNT(*) AS n FROM events WHERE type = ? AND approval_id = ?',
    type,
    approvalId,
  ).n;
}

console.log('— 成功路径：受理 → tts_finished → 开窗');
{
  const { run, approval } = approvalFor('跟着穿红衣服的人');
  const res = await announcer.announce(approval.approval_id);
  check('announce 成功', res.ok === true);
  check('调用的是结构化系统播报', robotd.calls[0]?.kind === 'approval_repeat');
  check('请求里没有 text 字段', !('text' in robotd.calls[0]));
  check('正文由 robotd 渲染并回传', res.text.includes('确认请说'));
  check('记录播报摘要', noted.length === 1 && noted[0].taskId === res.task_id);

  check('受理后仍不是 waiting_confirmation', runs.getRunDetail(run.run_id).run.status !== 'waiting_confirmation');
  check('受理后不开窗', countEvents('run.waiting_confirmation', approval.approval_id) === 0);

  bridge.handle({
    type: 'speech.tts_finished',
    payload: {
      response_id: 'tts-1',
      approval_id: approval.approval_id,
      kind: 'approval_repeat',
      task_id: res.task_id,
      chunks: 2,
      played: 2,
    },
  });
  check('播完后 run waiting_confirmation', runs.getRunDetail(run.run_id).run.status === 'waiting_confirmation');
  check('播完后开窗事件只一条', countEvents('run.waiting_confirmation', approval.approval_id) === 1);
  check('approval.waiting 也写了', countEvents('approval.waiting', approval.approval_id) === 1);
  const spokenSeq = store.one(
    "SELECT seq FROM events WHERE type = 'speech.spoken' ORDER BY seq DESC LIMIT 1",
  ).seq;
  const waitSeq = store.one(
    'SELECT seq FROM events WHERE type = ? AND approval_id = ?',
    'run.waiting_confirmation',
    approval.approval_id,
  ).seq;
  check('tts_played 事件先于开窗进入事件流', spokenSeq < waitSeq, { spokenSeq, waitSeq });

  bridge.handle({
    type: 'speech.tts_finished',
    payload: {
      response_id: 'tts-1',
      approval_id: approval.approval_id,
      kind: 'approval_repeat',
      chunks: 2,
      played: 2,
    },
  });
  check('重复完成幂等', countEvents('run.waiting_confirmation', approval.approval_id) === 1);
  runs.cancelRun(run.run_id, '清理');
}

console.log('— 播报失败：不开窗，run failed');
{
  const { run, approval } = approvalFor('跟着我');
  robotd.error = '语音桥不可用';
  const res = await announcer.announce(approval.approval_id);
  robotd.error = null;
  check('announce 失败返回 ok:false', res.ok === false);
  check('run failed', runs.getRunDetail(run.run_id).run.status === 'failed');
  check('approval unavailable 事件', countEvents('approval.unavailable', approval.approval_id) === 1);
  check('失败不开窗', countEvents('run.waiting_confirmation', approval.approval_id) === 0);
}

console.log('— 复述中被 stop：取消而非确认');
{
  const { run, approval } = approvalFor('向前两步');
  await announcer.announce(approval.approval_id);
  bridge.handle({
    type: 'speech.tts_cancelled',
    payload: {
      response_id: 'tts-2',
      approval_id: approval.approval_id,
      kind: 'approval_repeat',
      reason: 'stop',
      played: 0,
    },
  });
  check('stop 后 run cancelled', runs.getRunDetail(run.run_id).run.status === 'cancelled');
  check('stop 不开窗', countEvents('run.waiting_confirmation', approval.approval_id) === 0);
  check('stop 写 approval.resolved', countEvents('approval.resolved', approval.approval_id) === 1);
}

console.log('— robotd 报 announce_failed：不开窗');
{
  const { run, approval } = approvalFor('桥不可用的事件');
  await announcer.announce(approval.approval_id);
  bridge.handle({
    type: 'speech.announce_failed',
    payload: {
      approval_id: approval.approval_id,
      kind: 'approval_repeat',
      task_id: 't-fail',
      reason: '语音桥不可用',
    },
  });
  check('announce_failed 后 run failed', runs.getRunDetail(run.run_id).run.status === 'failed');
  check('announce_failed 不开窗', countEvents('run.waiting_confirmation', approval.approval_id) === 0);
  check('announce_failed 写 approval.unavailable', countEvents('approval.unavailable', approval.approval_id) === 1);
}

console.log('— 已经结束的 run 收到迟到完成事件：不开窗');
{
  const { run, approval } = approvalFor('迟到事件');
  await announcer.announce(approval.approval_id);
  runs.cancelRun(run.run_id, '用户取消');
  bridge.handle({
    type: 'speech.tts_finished',
    payload: {
      response_id: 'tts-3',
      approval_id: approval.approval_id,
      kind: 'approval_repeat',
      chunks: 1,
      played: 1,
    },
  });
  check('终态 run 不被改回 waiting_confirmation', runs.getRunDetail(run.run_id).run.status === 'cancelled');
  check('迟到完成不开窗', countEvents('run.waiting_confirmation', approval.approval_id) === 0);
}

console.log('— 完成事件抢在 HTTP 响应之前：仍只开一次窗，正文不丢');
{
  const { run, approval } = approvalFor('竞态复述');
  let release;
  robotd.beforeReturn = () => new Promise((resolve) => {
    release = resolve;
  });
  const pending = announcer.announce(approval.approval_id);
  bridge.handle({
    type: 'speech.tts_finished',
    payload: {
      response_id: 'tts-race',
      approval_id: approval.approval_id,
      kind: 'approval_repeat',
      task_id: 't-race',
      chunks: 1,
      played: 1,
    },
  });
  check('先到的完成事件已开窗', runs.getRunDetail(run.run_id).run.status === 'waiting_confirmation');
  release();
  const res = await pending;
  check('HTTP 响应随后返回成功', res.ok === true);
  const row = runs.getApproval(approval.approval_id);
  check('开窗状态没有被响应回退', row.status === 'waiting');
  check('审计正文仍被补上', typeof row.prompt_text === 'string' && row.prompt_text.includes('确认请说'));
  check('窗口事件只有一条', countEvents('run.waiting_confirmation', approval.approval_id) === 1);
  robotd.beforeReturn = null;
  runs.cancelRun(run.run_id, '清理');
}

console.log('— 终态事件丢失：超时按失败收尾，不开窗');
{
  const short = new ApprovalAnnouncer({
    runs,
    robotd,
    log: () => {},
    windowMs: 30_000,
    announceTimeoutMs: 20,
  });
  const { run, approval } = approvalFor('事件丢失');
  const res = await short.announce(approval.approval_id);
  check('受理成功', res.ok === true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  check('超时后 run failed', runs.getRunDetail(run.run_id).run.status === 'failed');
  check('超时不开窗', countEvents('run.waiting_confirmation', approval.approval_id) === 0);
  const unavailable = store.one(
    'SELECT params_json FROM events WHERE type = ? AND approval_id = ?',
    'approval.unavailable',
    approval.approval_id,
  );
  check('超时写 approval.unavailable', Boolean(unavailable));
  check(
    '超时原因可区分',
    unavailable ? JSON.parse(unavailable.params_json).kind === 'announce_timeout' : false,
  );
}

console.log('— 非审批复述/未知审批的终态事件：忽略');
{
  const { run, approval } = approvalFor('无关事件');
  await announcer.announce(approval.approval_id);
  bridge.handle({
    type: 'speech.tts_finished',
    payload: {
      response_id: 'tts-x',
      approval_id: approval.approval_id,
      kind: 'robot_speak',
      chunks: 1,
      played: 1,
    },
  });
  check('非 approval_repeat 不开窗', countEvents('run.waiting_confirmation', approval.approval_id) === 0);
  bridge.handle({
    type: 'speech.tts_finished',
    payload: { response_id: 'tts-nokind', approval_id: approval.approval_id },
  });
  check('缺 kind 的完成事件不开窗', countEvents('run.waiting_confirmation', approval.approval_id) === 0);
  bridge.handle({
    type: 'speech.tts_finished',
    payload: { response_id: 'tts-y', approval_id: 'appr-does-not-exist', kind: 'approval_repeat' },
  });
  check('未知审批不开窗', countEvents('run.waiting_confirmation', approval.approval_id) === 0);
  check('未知审批不影响当前 run', runs.getRunDetail(run.run_id).run.status !== 'waiting_confirmation');
  bridge.handle({
    type: 'speech.tts_finished',
    payload: { response_id: 'tts-z', approval_id: approval.approval_id, kind: 'approval_repeat' },
  });
  check('真正的复述完成仍能开窗', runs.getRunDetail(run.run_id).run.status === 'waiting_confirmation');
  runs.cancelRun(run.run_id, '清理');
}

console.log('— 已开窗的审批不再二次播报');
{
  const { run, approval } = approvalFor('重复播报');
  await announcer.announce(approval.approval_id);
  bridge.handle({
    type: 'speech.tts_finished',
    payload: { response_id: 'tts-d', approval_id: approval.approval_id, kind: 'approval_repeat' },
  });
  const callsBefore = robotd.calls.length;
  const again = await announcer.announce(approval.approval_id);
  check('二次播报被拒绝', again.ok === false);
  check('没有再次调用 robotd', robotd.calls.length === callsBefore);
  runs.cancelRun(run.run_id, '清理');
}

store.close();
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
