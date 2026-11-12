/**
 * 说话人 ↔ track 绑定与 follow 接缝（GH-68 验收判据 1–6）。
 *
 * 全离线：注入合成 `person.*` 事件驱动，不接摄像头、不做检测/跟踪。
 * 时钟由构造参数注入，TTL 与 5Hz 降频都不靠 sleep。
 *
 * 反向判据（每条都实测过「删掉判断就红」）：
 *   - 判据 2：不处理 person.lost / 不校验 track 存活 → 失效 track 会被当成 200；
 *   - 判据 3：把门限设成 0（等价于删掉判断）→ 低置信度绑定会直接下发 robot_follow；
 *   - 判据 4：没有「≥2 条活 track 必须澄清」的分支 → 会按唯一候选自动绑定。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/agentd/store.ts';
import { EventLog, loadRegistry } from '../../src/agentd/events.ts';
import { RunService } from '../../src/agentd/runs.ts';
import { RobotdEventBridge } from '../../src/agentd/robotd-event-bridge.ts';
import { NODE_EVENT_TYPES } from '../../src/agentd/robotd-events.ts';
import {
  FollowTargetRegistry,
  UNIDENTIFIED_SPEAKER,
} from '../../src/agentd/person-bindings.ts';
import { submitRunRequest } from '../../src/agentd/run-request.ts';
import { toApiError } from '../../src/agentd/http.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(HERE, '..', '..', '..', 'work', 'agentd-test', 'follow-binding');
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

// 可注入时钟：事件降频与 TTL 共用同一个毫秒时钟域。
let fakeNow = 2_000_000;
const clock = () => fakeNow;

const store = new Store(path.join(root, 'agentd.sqlite'), { log: () => {} });
const registry = loadRegistry();
const events = new EventLog(store, registry, 'boot-follow-binding', { now: clock });
const svc = new RunService({ store, events, log: () => {} });

const TTL_MS = 60_000;
const MIN_CONFIDENCE = 0.5;
function makeTargets(opts = {}) {
  return new FollowTargetRegistry({
    store,
    now: clock,
    ttlMs: TTL_MS,
    minConfidence: MIN_CONFIDENCE,
    singleTrackConfidence: 0.6,
    ...opts,
  });
}
const targets = makeTargets();
const bridge = new RobotdEventBridge({ events, store, targets });

let seq = 0;
function inject(type, payload) {
  seq += 1;
  bridge.handle({
    version: 1,
    type,
    event_id: `evt-person-${seq}`,
    seq,
    timestamp: new Date(fakeNow).toISOString(),
    payload,
  });
}
const bbox = (x = 0.25) => ({ x, y: 0.1, width: 0.2, height: 0.3 });
const appeared = (trackId) =>
  inject('person.appeared', {
    track_id: trackId,
    bbox: bbox(),
    first_seen_at: new Date(fakeNow).toISOString(),
  });
const lost = (trackId) =>
  inject('person.lost', { track_id: trackId, last_seen_at: new Date(fakeNow).toISOString() });
const rowsOfType = (type) => store.all('SELECT * FROM events WHERE type = ? ORDER BY seq', type);
const bindingRows = () => store.all('SELECT * FROM person_bindings ORDER BY speaker_id');
const runCount = () => store.one('SELECT COUNT(*) AS n FROM runs').n;

const executed = [];
const harnessExecuted = [];
function deps(extra = {}) {
  return {
    runs: svc,
    availableCapabilities: () => new Set(['robot_stop', 'robot_follow']),
    followTargets: targets,
    executeFast: (runId, capability, args) => executed.push({ runId, capability, args }),
    executeHarness: (runId, context) => harnessExecuted.push({ runId, context }),
    ...extra,
  };
}
function apiError(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return toApiError(e);
  }
}
function clarifyEvents() {
  return events.query({ limit: 200 }).events.filter((e) => e.type === 'route.clarify');
}

// ---------------------------------------------------------------- 判据 1：桥接生效
console.log('— 判据 1：person.appeared 落库 + person.moved 超 5Hz 被丢弃');
for (const type of ['person.appeared', 'person.moved', 'person.lost']) {
  check(`订阅列表包含 ${type}`, NODE_EVENT_TYPES.includes(type));
}
appeared('track_1');
const appearedRow = rowsOfType('person.appeared').at(-1);
check('person.appeared 已桥接落库', Boolean(appearedRow), String(appearedRow?.seq));
check('来源标成 robotd', appearedRow?.source === 'robotd', appearedRow?.source);
console.log(
  `       event 原文: ${JSON.stringify({
    event_id: appearedRow?.event_id,
    type: appearedRow?.type,
    severity: appearedRow?.severity,
    occurred_at: appearedRow?.occurred_at,
    source: appearedRow?.source,
    payload: JSON.parse(appearedRow?.params_json ?? '{}'),
  })}`,
);

const moveBefore = rowsOfType('person.moved').length;
for (let i = 0; i < 7; i += 1) {
  inject('person.moved', { track_id: 't-burst', bbox: bbox(0.5) });
}
const moveRows = rowsOfType('person.moved').slice(moveBefore);
const burstRows = moveRows.filter((r) => JSON.parse(r.params_json).track_id === 't-burst');
check('同一秒 7 条 person.moved 只入库 5 条', burstRows.length === 5, String(burstRows.length));
check('被 EventLog 丢弃 2 条', 7 - burstRows.length === 2, `${7 - burstRows.length}`);
lost('track_1');

// ---------------------------------------------------------------- 判据 2：person.lost 让绑定失效
console.log('— 判据 2：person.lost → 绑定删除 → follow 失效 track 返回 400/E_VALIDATION');
appeared('track_9');
targets.bind({ speaker_id: 'spk-lost', track_id: 'track_9', confidence: 0.9, source: 'visual_anchor' });
check('绑定 track_9 已落库', bindingRows().some((r) => r.track_id === 'track_9'));
lost('track_9');
check('person.lost 后绑定立即删除（无悬空引用）', !bindingRows().some((r) => r.track_id === 'track_9'), JSON.stringify(bindingRows()));
const runsBeforeLost = runCount();
const lostError = apiError(() =>
  submitRunRequest(deps(), { prompt: '跟着我 track:track_9', speaker_id: 'spk-lost' }),
);
check('失效 track 的 follow → E_VALIDATION（不是 200/500）', lostError?.code === 'E_VALIDATION', JSON.stringify(lostError));
check('失效 track 的 HTTP 状态是 400', lostError?.status === 400, String(lostError?.status));
check('错误信息说明目标已离开画面', Boolean(lostError?.message.includes('离开画面')), lostError?.message);
check('失效 track 不创建 run', runCount() === runsBeforeLost, `${runsBeforeLost} → ${runCount()}`);

// 反向：如果 person.lost 没有让 track 失效，同一条请求会直接 200/fast。
const withoutLost = makeTargets();
withoutLost.trackAppeared('track_9', new Date(fakeNow).toISOString());
const reverseLostExec = [];
const reverseLost = submitRunRequest(
  deps({
    followTargets: withoutLost,
    executeFast: (runId, capability, args) => reverseLostExec.push({ runId, capability, args }),
  }),
  { prompt: '跟着我 track:track_9', speaker_id: 'spk-lost' },
);
check('反向：不处理 lost 时同一请求会 fast（证明失效判断生效）', reverseLost.route === 'fast', JSON.stringify(reverseLost));
check('反向：不处理 lost 时真的下发 robot_follow', reverseLostExec.at(-1)?.capability === 'robot_follow', JSON.stringify(reverseLostExec.at(-1)));
if (reverseLost.run_id) svc.cancelRun(reverseLost.run_id, '测试收尾');

// ---------------------------------------------------------------- 判据 3：低置信度必须澄清
console.log('— 判据 3：低置信度绑定 → route.clarify，且没有 robot_follow');
appeared('track_9b');
targets.bind({ speaker_id: 'spk-low', track_id: 'track_9b', confidence: 0.2, source: 'visual_anchor' });
const clarifyBefore = clarifyEvents().length;
const execBeforeLow = executed.length;
const low = submitRunRequest(deps(), { prompt: '跟着我', speaker_id: 'spk-low' });
const lowClarify = clarifyEvents().slice(0, clarifyEvents().length - clarifyBefore);
check('低置信度返回 route=clarified', low.route === 'clarified', JSON.stringify(low));
check('没有创建 run', low.run_id === undefined, String(low.run_id));
check('没有下发 robot_follow', executed.length === execBeforeLow, JSON.stringify(executed.slice(execBeforeLow)));
check('写了 route.clarify', lowClarify.length === 1, String(lowClarify.length));
check('澄清原因是 precondition', lowClarify[0]?.data?.reason === 'precondition', JSON.stringify(lowClarify[0]?.data));
check(
  '澄清事件带门限解释',
  typeof lowClarify[0]?.summary === 'string' && lowClarify[0].summary.includes('置信度'),
  JSON.stringify(lowClarify[0]?.summary),
);
console.log(`       事件顺序: ${JSON.stringify(lowClarify.map((e) => e.type + '#' + e.cursor))}（此前无 robot_follow 调用）`);

// 反向判据：门限设为 0 = 删掉判断，同一条 0.2 绑定会直接下发。
const zeroGate = makeTargets({ minConfidence: 0 });
// 活 track 是 registry 的内存状态；同一条 track 要在这个实例里也登记为活着。
zeroGate.trackAppeared('track_9b', new Date(fakeNow).toISOString());
const reverseExec = [];
const reverse = submitRunRequest(
  deps({ followTargets: zeroGate, executeFast: (runId, capability, args) => reverseExec.push({ runId, capability, args }) }),
  { prompt: '跟着我', speaker_id: 'spk-low' },
);
check('反向：去掉门限后同一条绑定直接命中 fast', reverse.route === 'fast', JSON.stringify(reverse));
check('反向：确实下发了 robot_follow', reverseExec.at(-1)?.capability === 'robot_follow', JSON.stringify(reverseExec.at(-1)));
if (reverse.run_id) svc.cancelRun(reverse.run_id, '测试收尾');

// ---------------------------------------------------------------- 判据 4：多人必须澄清
console.log('— 判据 4：≥2 条活 track → 澄清（两条候选），不自动绑定');
lost('track_9b');
appeared('track_a');
// 先给这个说话人一条有效绑定，再让第二个人进入画面：多人时必须仍然澄清，
// 不能拿旧绑定直接下发（旧绑定可能是单人时刻自动建立的）。
targets.bind({ speaker_id: 'spk-multi', track_id: 'track_a', confidence: 0.9, source: 'visual_anchor' });
appeared('track_b');
const clarifyBeforeMulti = clarifyEvents().length;
const execBeforeMulti = executed.length;
const multi = submitRunRequest(deps(), { prompt: '跟着我', speaker_id: 'spk-multi' });
const multiClarify = clarifyEvents().slice(0, clarifyEvents().length - clarifyBeforeMulti);
check('多人时 route=clarified', multi.route === 'clarified', JSON.stringify(multi));
check('多人时没有 robot_follow 调用', executed.length === execBeforeMulti, JSON.stringify(executed.slice(execBeforeMulti)));
check('澄清候选正好两条', multiClarify[0]?.data?.candidates?.length === 2, JSON.stringify(multiClarify[0]?.data));
check(
  '候选是两条活 track',
  JSON.stringify(multiClarify[0]?.data?.candidates) === JSON.stringify(['目标 track_a', '目标 track_b']),
  JSON.stringify(multiClarify[0]?.data?.candidates),
);
const multiBinding = bindingRows().find((r) => r.speaker_id === 'spk-multi');
check('旧绑定没有被改写或新增', multiBinding?.track_id === 'track_a' && multiBinding?.confidence === 0.9, JSON.stringify(multiBinding));
console.log(`       clarify 原文: ${JSON.stringify(multiClarify[0]?.data)}`);

// 反向：把「多条活 track 必须澄清」换成「按第一条绑定」，同一场景会直接下发。
const permissiveLookup = {
  resolveFollowTarget: () => ({
    status: 'bound',
    binding: {
      speaker_id: 'spk-multi',
      track_id: 'track_a',
      confidence: 1,
      source: 'visual_anchor',
      bound_at: fakeNow,
      expires_at: fakeNow + TTL_MS,
    },
    auto_bound: true,
  }),
  isTrackLive: () => true,
  bindExplicit: (speakerId, trackId) => ({
    speaker_id: speakerId ?? UNIDENTIFIED_SPEAKER,
    track_id: trackId,
    confidence: 1,
    source: 'explicit',
    bound_at: fakeNow,
    expires_at: fakeNow + TTL_MS,
  }),
};
const reverseMultiExec = [];
const reverseMulti = submitRunRequest(
  deps({
    followTargets: permissiveLookup,
    executeFast: (runId, capability, args) => reverseMultiExec.push({ runId, capability, args }),
  }),
  { prompt: '跟着我', speaker_id: 'spk-multi' },
);
check('反向：删掉多人判断后同一场景会 fast', reverseMulti.route === 'fast', JSON.stringify(reverseMulti));
check('反向：删掉多人判断后会下发 robot_follow', reverseMultiExec.at(-1)?.capability === 'robot_follow', JSON.stringify(reverseMultiExec.at(-1)));
if (reverseMulti.run_id) svc.cancelRun(reverseMulti.run_id, '测试收尾');

// ---------------------------------------------------------------- 判据 5：单人可直接绑定
console.log('— 判据 5：只有 1 条活 track → 直接绑定，source/confidence 落库');
lost('track_9b');
lost('track_a');
lost('track_b');
appeared('track_solo');
const execBeforeSolo = executed.length;
const solo = submitRunRequest(deps(), { prompt: '跟着我', speaker_id: 'spk-single' });
check('单人时直接命中 fast', solo.route === 'fast' && typeof solo.run_id === 'string', JSON.stringify(solo));
check('下发了 robot_follow', executed.at(-1)?.capability === 'robot_follow', JSON.stringify(executed.at(-1)));
check('目标就是唯一活 track', executed.at(-1)?.args?.target_track_id === 'track_solo', JSON.stringify(executed.at(-1)?.args));
const soloBinding = bindingRows().find((r) => r.speaker_id === 'spk-single');
check('绑定表出现一条记录', Boolean(soloBinding), JSON.stringify(bindingRows()));
check('source 是 visual_anchor（不是新的「唯一推断」来源）', soloBinding?.source === 'visual_anchor', soloBinding?.source);
check('confidence 有值', typeof soloBinding?.confidence === 'number' && soloBinding.confidence > 0, String(soloBinding?.confidence));
console.log(`       绑定记录: ${JSON.stringify(soloBinding)}`);
if (solo.run_id) svc.cancelRun(solo.run_id, '测试收尾');

// 新 speaker 不能沿用别人的绑定：spk-single 已绑 track_solo，再加入一条活 track，
// spk-other 说「跟着我」时必须按多人澄清，而不是拿 spk-single 的目标。
appeared('track_second');
const otherSpeaker = submitRunRequest(deps(), { prompt: '跟着我', speaker_id: 'spk-other' });
check('新 speaker 不沿用别人的绑定（多人 → 澄清）', otherSpeaker.route === 'clarified', JSON.stringify(otherSpeaker));
check('新 speaker 没有被写成别人的目标', !bindingRows().some((r) => r.speaker_id === 'spk-other'), JSON.stringify(bindingRows()));
lost('track_second');

// ---------------------------------------------------------------- 判据 6：TTL 到期
console.log('— 判据 6：推进时钟超过 TTL → 绑定失效（不需要 person.lost）');
fakeNow += TTL_MS + 1;
check('TTL 到期后 bindingFor 返回 null', targets.bindingFor('spk-single') === null, JSON.stringify(targets.bindingFor('spk-single')));
check('TTL 到期后库里也不再保留该绑定', !bindingRows().some((r) => r.speaker_id === 'spk-single'), JSON.stringify(bindingRows()));

// 匿名键不会跨到有名说话人。
check('匿名键是固定哨兵值', UNIDENTIFIED_SPEAKER === '@unidentified');

store.close();
console.log('');
if (failed > 0) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');
