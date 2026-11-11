/**
 * GH-57：robotd 的 safety.stop_requested → agentd run 的结构化 blocking_reason。
 *
 * 只认 robotd 给出的 task_id 归属 run：语音「停」本身也是一次 run，
 * 按 activeRun() 猜会把停止指令自己取消掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/agentd/store.ts';
import { EventLog, loadRegistry } from '../../src/agentd/events.ts';
import { RunService } from '../../src/agentd/runs.ts';
import { RobotdEventBridge, STOP_CAUSES } from '../../src/agentd/robotd-event-bridge.ts';
import { NODE_EVENT_TYPES } from '../../src/agentd/robotd-events.ts';
import { composeNarrationText, blockingReasonLabel } from '../../src/agentd/run-narrator.ts';

const root = new URL('../../../work/agentd-safety-bridge-test', import.meta.url).pathname;
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
const events = new EventLog(store, loadRegistry(), 'boot-safety');
const runs = new RunService({ store, events, log: () => {} });
const bridge = new RobotdEventBridge({ events, store, runs, hooks: { log: () => {} } });

function makeExecutingRun(taskId) {
  const run = runs.submitRun({ prompt: '往前走', route: 'fast' });
  runs.transition(run.run_id, 'executing');
  store.transaction((tx) => {
    runs.recordToolCall(tx, run.run_id, 'robot_follow', '执行 robot_follow', '{}', 'running', {
      robotTaskId: taskId,
    });
  });
  return run.run_id;
}

function stopEvents(runId) {
  return store.all(
    "SELECT * FROM events WHERE type = 'safety.stop_requested' AND run_id = ? ORDER BY seq",
    runId,
  );
}

console.log('— substrate：订阅白名单');
check('订阅包含 safety.stop_requested', NODE_EVENT_TYPES.includes('safety.stop_requested'));
{
  const contract = JSON.parse(
    fs.readFileSync(new URL('../../contracts/events.json', import.meta.url), 'utf8'),
  );
  const ev = contract.events.find((e) => e.type === 'safety.stop_requested');
  check(
    'bridge 的 cause 枚举与契约一致',
    JSON.stringify([...STOP_CAUSES].sort()) === JSON.stringify([...ev.payload.cause.enum].sort()),
    JSON.stringify(STOP_CAUSES),
  );
}

console.log('— 判据 5：板侧看门狗停止写 run 的 blocking_reason');
{
  const runId = makeExecutingRun('rt-watchdog');
  bridge.handle({
    type: 'safety.stop_requested',
    payload: {
      cause: 'watchdog_timeout',
      state: 'confirmed',
      detail: '板侧主动停机（watchdog）',
      task_id: 'rt-watchdog',
    },
  });

  const detail = runs.getRunDetail(runId);
  check('run 不是 succeeded', detail.run.status !== 'succeeded', detail.run.status);
  check('run 是 cancelled', detail.run.status === 'cancelled', detail.run.status);
  check('blocking_reason=watchdog_timeout', detail.run.blocking_reason === 'watchdog_timeout', detail.run.blocking_reason);
  const evs = stopEvents(runId);
  check('写了一条 safety.stop_requested 且关联 run', evs.length === 1, `实际 ${evs.length}`);
  const params = JSON.parse(evs[0]?.params_json ?? '{}');
  check('事件保留结构化 cause', params.cause === 'watchdog_timeout', JSON.stringify(params));
  check('事件保留 state', params.state === 'confirmed', JSON.stringify(params));

  const text = composeNarrationText(
    { status: 'cancelled', blocking_reason: 'watchdog_timeout', result_summary: null },
    [],
  );
  check('narration 能说出原因（不是泛化中断）', text.includes('看门狗'), text);
  check('原因标签可读', blockingReasonLabel('device_lost') === '设备掉线');
}

console.log('— 判据 5：九种 cause 在播报里都说出原因，不吞成泛化「任务中断了」');
for (const cause of STOP_CAUSES) {
  const label = blockingReasonLabel(cause);
  const text = composeNarrationText(
    { status: 'cancelled', blocking_reason: cause, result_summary: null },
    [],
  );
  check(`cause=${cause} 有可读标签`, label !== cause, label);
  check(`cause=${cause} 播报包含该原因`, text.includes(label), text);
}

console.log('— 语音停止不能取消停止指令自己的 run');
{
  const stopRun = runs.submitRun({ prompt: '停', route: 'fast' });
  runs.transition(stopRun.run_id, 'executing');
  bridge.handle({
    type: 'safety.stop_requested',
    payload: { cause: 'user_voice', state: 'confirmed', detail: '用户语音请求停止' },
  });
  const detail = runs.getRunDetail(stopRun.run_id);
  check('没有 task_id 时按 activeRun 猜是禁止的', detail.run.status === 'executing', detail.run.status);
  check('仍没有写 safety.stop_requested 到该 run', stopEvents(stopRun.run_id).length === 0);
}

console.log('— 已终结 run 不被事后改判');
{
  const runId = makeExecutingRun('rt-done');
  runs.transition(runId, 'succeeded', { reason: 'fast_rule' });
  bridge.handle({
    type: 'safety.stop_requested',
    payload: { cause: 'user_stop_api', state: 'confirmed', detail: '停止', task_id: 'rt-done' },
  });
  const detail = runs.getRunDetail(runId);
  check('已 succeeded 的 run 保持 succeeded', detail.run.status === 'succeeded', detail.run.status);
  check('事件仍按 task_id 关联到该 run', stopEvents(runId).length === 1);
}

console.log('— 非法 cause 不落库、不改 run');
{
  const runId = makeExecutingRun('rt-bad');
  bridge.handle({
    type: 'safety.stop_requested',
    payload: { cause: 'made_up', state: 'confirmed', detail: 'x', task_id: 'rt-bad' },
  });
  check('run 仍是 executing', runs.getRunDetail(runId).run.status === 'executing');
  check('没有写事件', stopEvents(runId).length === 0);
}

console.log('');
if (failed > 0) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');

