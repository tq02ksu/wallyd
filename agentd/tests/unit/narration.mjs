/**
 * RunNarrator（GH-13）：run 结论 → speak，以及「被打断 ≠ 失败」。
 *
 * 每条断言都对着 issue 的验收判据：
 * 1. succeeded → speak → tts_finished → speech.spoken；
 * 2. barge_in → run 仍 succeeded + narration=interrupted + speech.speak_cancelled；
 * 3. 同一 run 重放只播一次；
 * 4. >500 字截断并说明；
 * 5. robotd 不可达 → run 仍 succeeded + speech.speak_failed；
 * 6. 只念执行事实（不念 prompt）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Store, nowIso } from '../../src/agentd/store.ts';
import { EventLog, loadRegistry } from '../../src/agentd/events.ts';
import { RunService } from '../../src/agentd/runs.ts';
import { RunNarrator } from '../../src/agentd/run-narrator.ts';
import { RobotdEventBridge } from '../../src/agentd/robotd-event-bridge.ts';

const root = new URL('../../../work/agentd-narration-test', import.meta.url).pathname;
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
const events = new EventLog(store, loadRegistry(), 'boot-narration');
const log = () => {};
const runs = new RunService({ store, events, log });

class FakeRobotd {
  constructor(opts = {}) {
    this.calls = [];
    this.error = opts.error ?? null;
  }
  async speak(input) {
    this.calls.push(input);
    if (this.error) throw this.error;
    return { task_id: `t-${this.calls.length}` };
  }
}

function setupWith(robotd) {
  const noted = [];
  let bridge = null;
  const narrator = new RunNarrator({
    runs,
    robotd,
    events,
    log,
    noteSpeak: (taskId, text, runId) => {
      noted.push({ taskId, text, runId });
      bridge?.noteSpeak(taskId, text, runId);
    },
  });
  bridge = new RobotdEventBridge({
    events,
    store,
    hooks: { onSpeechOutcome: (outcome) => narrator.onSpeechOutcome(outcome) },
  });
  return { robotd, noted, narrator, bridge };
}

function setup(opts) {
  return setupWith(new FakeRobotd(opts));
}

function makeSucceededRun(svc, prompt, note) {
  const run = svc.submitRun({ prompt, route: 'fast' });
  svc.transition(run.run_id, 'executing');
  store.transaction((tx) => {
    const sid = svc.addStep(tx, run.run_id, '执行 robot_move', 'active');
    tx.run(
      "UPDATE run_steps SET state = 'done', finished_at = ?, note = ? WHERE step_id = ?",
      nowIso(),
      note,
      sid,
    );
  });
  svc.transition(run.run_id, 'succeeded', { reason: 'fast_rule', detail: '已下发' });
  return run.run_id;
}

function eventCount(type, runId) {
  return store.one(
    'SELECT COUNT(*) AS n FROM events WHERE type = ? AND run_id = ?',
    type,
    runId,
  ).n;
}

console.log('— 判据 1：结论播报 + tts_finished → speech.spoken');
{
  const s = setup();
  const runId = makeSucceededRun(runs, '往前走一步', '向前走了一步');
  const res = await s.narrator.narrate(runId);
  const taskId = res.task_id;
  check('speak 被调用一次', s.robotd.calls.length === 1);
  check('播报文本来自最后一步 note', s.robotd.calls[0]?.text === '向前走了一步', s.robotd.calls[0]?.text);
  check('文本长度在契约上限内', Array.from(s.robotd.calls[0]?.text ?? '').length <= 500);
  check(
    '播报前 noteSpeak 留底（task_id + 文本）',
    s.noted.length === 1 && s.noted[0].taskId === taskId && s.noted[0].text === '向前走了一步',
    JSON.stringify(s.noted),
  );
  check('请求成功', res.ok === true);

  s.bridge.handle({
    type: 'speech.tts_finished',
    payload: { response_id: 'tts-1', task_id: taskId, chunks: 2, played: 2 },
  });
  const detail = runs.getRunDetail(runId);
  check('run 仍 succeeded', detail.run.status === 'succeeded', detail.run.status);
  check('narration=spoken', detail.run.narration === 'spoken', detail.run.narration);
  check('事件库出现 speech.spoken', eventCount('speech.spoken', runId) === 1);
}

console.log('— 判据 2：barge-in 只写 interrupted，不改 run 状态');
{
  const s = setup();
  const runId = makeSucceededRun(runs, '往前走一步', '向前走了一步');
  const accepted = await s.narrator.narrate(runId);
  s.bridge.handle({
    type: 'speech.tts_cancelled',
    payload: { response_id: 'tts-2', task_id: accepted.task_id, reason: 'barge_in', played: 1 },
  });
  const detail = runs.getRunDetail(runId);
  check('打断后 run 仍是 succeeded', detail.run.status === 'succeeded', detail.run.status);
  check('narration=interrupted', detail.run.narration === 'interrupted', detail.run.narration);
  const cancel = store.one(
    "SELECT params_json FROM events WHERE type = 'speech.speak_cancelled' AND run_id = ?",
    runId,
  );
  check('事件库出现 speech.speak_cancelled', Boolean(cancel));
  check(
    '取消原因保留 barge_in',
    cancel ? JSON.parse(cancel.params_json).reason === 'barge_in' : false,
    cancel?.params_json,
  );

  console.log('— 判据 3：同一 run 重放只播一次');
  const before = s.robotd.calls.length;
  const again = await s.narrator.narrate(runId);
  check('重放没有再次调用 speak', s.robotd.calls.length === before, String(s.robotd.calls.length));
  check('重放返回 already_narrated', again.reason === 'already_narrated', again.reason);
}

console.log('— 判据 4：超过 500 字必须截断并说明');
{
  const s = setup();
  const longNote = `向前走了很多步${'啊'.repeat(600)}`;
  const runId = makeSucceededRun(runs, '长文本', longNote);
  const res = await s.narrator.narrate(runId);
  const text = s.robotd.calls[0]?.text ?? '';
  check('截断后不超过 500 个字符', Array.from(text).length <= 500, String(Array.from(text).length));
  check('截断带「后面略」说明', text.endsWith('后面略'), text.slice(-10));
  check('没有因超长拒绝播报', res.ok === true);
}

console.log('— 判据 5：robotd 不可达 ≠ 任务没做成');
{
  const err = Object.assign(new Error('robotd 不可达：connect ECONNREFUSED'), { code: 'E_UNREACHABLE' });
  const s = setup({ error: err });
  const runId = makeSucceededRun(runs, '不可达', '向前走了一步');
  const res = await s.narrator.narrate(runId);
  const detail = runs.getRunDetail(runId);
  check('播报失败时 run 仍 succeeded', detail.run.status === 'succeeded', detail.run.status);
  check('narration=failed', detail.run.narration === 'failed', detail.run.narration);
  check('请求返回失败原因', res.ok === false && res.reason === 'E_UNREACHABLE', res.reason);
  const ev = store.one(
    "SELECT params_json FROM events WHERE type = 'speech.speak_failed' AND run_id = ?",
    runId,
  );
  check('事件库出现 speech.speak_failed', Boolean(ev));
  check(
    '失败事件带原因',
    ev ? JSON.parse(ev.params_json).reason === 'E_UNREACHABLE' : false,
    ev?.params_json,
  );
}

console.log('— 兜底短语必须诚实（失败不说「完成了」）');
{
  const s = setup();
  const run = runs.submitRun({ prompt: '做不成', route: 'fast' });
  runs.transition(run.run_id, 'executing');
  runs.transition(run.run_id, 'failed', { reason: 'capability_missing', detail: '对端没有提供能力' });
  const res = await s.narrator.narrate(run.run_id);
  check('失败兜底以「没做成」开头', res.text?.startsWith('没做成'), res.text);
  check('失败兜底保留原因', res.text?.includes('capability_missing'), res.text);
  check('失败兜底不说「完成」', !res.text?.includes('完成'), res.text);
}

console.log('— 只念执行事实，不念 prompt / 模型推理；result_summary 优先');
{
  const s = setup();
  const runId = makeSucceededRun(runs, '模型推理正文不应该被念出来', '移动了一步');
  const res = await s.narrator.narrate(runId);
  check('正文等于 step note', res.text === '移动了一步', res.text);
  check('正文不含 prompt 内容', !res.text?.includes('模型推理'), res.text);

  const runId2 = makeSucceededRun(runs, '另一条', '步骤备注');
  store.transaction((tx) => {
    tx.run('UPDATE runs SET result_summary = ? WHERE run_id = ?', '归纳后的结论', runId2);
  });
  const res2 = await s.narrator.narrate(runId2);
  check('result_summary 优先于 step note', res2.text === '归纳后的结论', res2.text);
}

console.log('— 装配层：终态自动触发播报，cancelled 不播');
{
  let autoNarrator = null;
  const autoRuns = new RunService({
    store,
    events,
    log,
    onTerminal: (runId) => {
      void autoNarrator?.narrate(runId);
    },
  });
  const robotd = new FakeRobotd();
  autoNarrator = new RunNarrator({
    runs: autoRuns,
    robotd,
    events,
    log,
    noteSpeak: () => {},
  });
  const runId = makeSucceededRun(autoRuns, '自动播报', '自动触发的一步');
  await new Promise((resolve) => setImmediate(resolve));
  check(
    'succeeded 自动调用 speak',
    robotd.calls.some((c) => c.text === '自动触发的一步'),
    JSON.stringify(robotd.calls),
  );

  const before = robotd.calls.length;
  const cancelled = autoRuns.submitRun({ prompt: '停止', route: 'fast' });
  autoRuns.cancelRun(cancelled.run_id, '收到停止指令');
  await new Promise((resolve) => setImmediate(resolve));
  check('cancelled 的 run 不播报', robotd.calls.length === before, String(robotd.calls.length));
}

store.close();
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
