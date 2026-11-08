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
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, nowIso } from '../../src/agentd/store.ts';
import { EventLog, loadRegistry } from '../../src/agentd/events.ts';
import { RunService } from '../../src/agentd/runs.ts';
import { RobotdEventBridge } from '../../src/agentd/robotd-event-bridge.ts';
import { createRuntime, defaultConfig } from '../../src/agentd/service.ts';
import { ensureApprovalSigningKey } from '../../src/agentd/approval-key.ts';

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

console.log('— ERLE 门限：播报已结束但 ERLE < 6 dB 仍是回声（判据 8 的同一条路径）');
{
  const submitted = [];
  const svc = makeService((input) => {
    submitted.push(input);
    return { run_id: 'run-erle' };
  });
  const bridge = new RobotdEventBridge({
    events,
    store,
    hooks: { onUtteranceHeard: (input) => svc.dispatchUtterance(input) },
  });
  // 没有活动播报（during_tts=false），只有 `speech.started.aec_erle_db` 这个事实：
  // 麦克风几乎还是喇叭的声音，所以这一轮是自听。
  bridge.handle({ type: 'speech.started', payload: { utterance_id: 'u-erle-low', aec_erle_db: 1 } });
  bridge.handle({
    type: 'speech.final',
    payload: { utterance_id: 'u-erle-low', text: '确认', stop_reason: 'endpoint' },
  });
  check('低 ERLE 的 final 没有提交', submitted.length === 0, JSON.stringify(submitted));
  const low = ignoredEvents('u-erle-low');
  check('写了一条 speech_ignored', low.length === 1, String(low.length));
  check(
    '忽略原因是 echo',
    low[0] ? JSON.parse(low[0].params_json).reason === 'echo' : false,
    low[0]?.params_json,
  );

  // 反向：ERLE 足够高（AEC 压住了回声）时，同一句话必须照常提交。
  bridge.handle({ type: 'speech.started', payload: { utterance_id: 'u-erle-high', aec_erle_db: 30 } });
  bridge.handle({
    type: 'speech.final',
    payload: { utterance_id: 'u-erle-high', text: '往前走一步', stop_reason: 'endpoint' },
  });
  check('高 ERLE 的 final 被提交', submitted.length === 1, JSON.stringify(submitted));
  check('提交的是原话', submitted[0]?.text === '往前走一步', JSON.stringify(submitted[0]));
}

console.log('— 窗口过期后：迟到的「确认」记账为 expired，「停」与普通指令照常提交');
{
  // 放在最后：这一段的 timeout 审批会留在库里成为「最近一次审批」，会影响后续用例。
  const submitted = [];
  const svc = makeService((input) => {
    submitted.push(input);
    return { run_id: 'run-after-timeout' };
  });
  const run = svc.submitRun({ prompt: '跟着我', route: 'fast' });
  const approval = svc.createApproval({
    runId: run.run_id,
    capability: 'robot_follow',
    actionLabel: '向前跟随',
    argsSummary: '目标：我',
  });
  svc.markApprovalAnnounced(approval.approval_id, '请确认：向前跟随。确认请说“确认”。');
  svc.openConfirmationWindow(approval.approval_id, 30_000);
  svc.expireApproval(approval.approval_id);
  check('审批已是 timeout', svc.getApproval(approval.approval_id)?.status === 'timeout');

  const late = svc.dispatchUtterance({
    utterance_id: 'u-late-confirm',
    text: '确认',
    echo: false,
    started_at: new Date(Date.now() + 10).toISOString(),
  });
  check('迟到的确认走审批分支', late.action === 'approval', late.action);
  check('结算原因是 expired', late.approval?.reason === 'expired', JSON.stringify(late.approval));
  check('没有把「确认」当成新指令提交', submitted.length === 0, JSON.stringify(submitted));
  const ignored = store.all(
    "SELECT * FROM events WHERE type = 'approval.ignored' AND approval_id = ?",
    approval.approval_id,
  );
  check('留下 approval.ignored', ignored.length === 1, String(ignored.length));
  check(
    '忽略原因是 expired',
    ignored[0] ? JSON.parse(ignored[0].params_json).reason === 'expired' : false,
    ignored[0]?.params_json,
  );

  // 反向：死掉的窗口不能把「停」或普通指令也吞掉。
  const stop = svc.dispatchUtterance({ utterance_id: 'u-stop-after-timeout', text: '停', echo: false });
  check('过期后的「停」照常提交', stop.action === 'submitted', stop.action);
  const normal = svc.dispatchUtterance({ utterance_id: 'u-after-timeout', text: '往前走一步', echo: false });
  check('过期后的普通指令照常提交', normal.action === 'submitted', normal.action);
  check('提交的是原话', submitted.map((s) => s.text).join('|') === '停|往前走一步', JSON.stringify(submitted));
  svc.cancelRun(run.run_id, '清理');
}


// ---------------------------------------------------------------------------
// 判据 1–5：语音 final 走与 POST /api/run 完全相同的路径（真实装配层）。
//
// 这里不再用桩替代 submitUtterance：真 SQLite + 真 RunService + 真路由 + 真审批门，
// robotd 用本地假 HTTP 服务替身。回环 bind 被沙箱拒绝时，用仓库既有的内存传输
// （agentd/tests/manual/in-memory-http.mjs）复核同一份用例；真实 HTTP 传输由 CI 覆盖。
// ---------------------------------------------------------------------------
const acceptanceRoot = new URL('../../../work/agentd-utterance-acceptance', import.meta.url).pathname;
const here = path.dirname(fileURLToPath(import.meta.url));

async function canBindLoopback() {
  return await new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function waitFor(fn, { timeoutMs = 6000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return fn();
}

async function runAcceptance() {
  console.log('\n— 判据 1–5：语音 final 与 POST /api/run 同一条路径');

  if (!(await canBindLoopback())) {
    console.log('  NOTE 回环 bind 被环境拒绝（EPERM）；改用内存传输复核同一份用例（真实 HTTP 由 CI 覆盖）');
    await import('../manual/in-memory-http.mjs');
  }

  fs.rmSync(acceptanceRoot, { recursive: true, force: true });
  fs.mkdirSync(acceptanceRoot, { recursive: true });
  process.env.WALLY_APP_DATA_DIR = path.join(acceptanceRoot, 'appdata');
  ensureApprovalSigningKey();

  const robotdCalls = [];
  const fakeRobotd = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      const call = {
        method: req.method,
        path: url.pathname,
        body,
        approvalHeader: req.headers['x-wally-approval'] ?? null,
      };
      robotdCalls.push(call);
      const json = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET' && url.pathname === '/v1/health') {
        return json(200, { ok: true, instance_id: 'fake-robotd', version: 'test' });
      }
      if (req.method === 'POST' && url.pathname === '/v1/robot/announce') {
        return json(200, {
          ok: true,
          task_id: `ann-${robotdCalls.length}`,
          status: 'accepted',
          approval_id: body.approval_id,
          kind: body.kind,
          text: '请确认：走到我这儿来。确认请说“确认”。',
        });
      }
      if (req.method === 'POST' && url.pathname === '/v1/robot/stop') {
        return json(200, { ok: true, task_id: 'task-stop', state: 'accepted', board_ack: true });
      }
      if (req.method === 'POST' && url.pathname === '/v1/robot/follow') {
        return json(200, { ok: true, task_id: 'task-follow', state: 'accepted' });
      }
      if (req.method === 'POST' && url.pathname === '/v1/robot/speak') {
        return json(200, { ok: true, task_id: `speak-${robotdCalls.length}`, status: 'accepted' });
      }
      return json(404, { ok: false, error: { code: 'E_NOT_FOUND', message: 'no route' } });
    });
  });
  fakeRobotd.on('upgrade', (_req, socket) => socket.destroy());
  await new Promise((resolve) => fakeRobotd.listen(0, '127.0.0.1', resolve));
  const robotdPort = fakeRobotd.address().port;

  const logs = [];
  const runtime = await createRuntime(
    {
      ...defaultConfig(),
      httpPort: 0,
      dataDir: path.join(acceptanceRoot, 'agentd'),
      staticDir: null,
      logLevel: 'error',
      robotdUrl: `http://127.0.0.1:${robotdPort}`,
    },
    { log: (msg, extra) => logs.push({ msg, extra }) },
  );

  let evtSeq = 0;
  function feed(type, payload, timestamp = new Date().toISOString()) {
    evtSeq += 1;
    runtime.robotdBridge.handle({
      version: 1,
      type,
      event_id: `evt-acc-${evtSeq}`,
      seq: evtSeq,
      timestamp,
      payload,
    });
  }
  const runCount = () => runtime.store.one('SELECT COUNT(*) AS n FROM runs').n;
  const runRow = (id) => (id ? runtime.store.one('SELECT * FROM runs WHERE run_id = ?', id) : null);
  const callsTo = (p) => robotdCalls.filter((c) => c.path === p);
  const eventsFor = (utteranceId) => runtime.store.all(
    "SELECT type, params_json, source FROM events WHERE params_json LIKE ? ORDER BY seq",
    `%${utteranceId}%`,
  );

  try {
    // ------------------------------------------------ 判据 1：停止 → 真 run + 真 stop
    feed('speech.started', { utterance_id: 'utt-stop', aec_erle_db: 30 });
    feed('speech.final', { utterance_id: 'utt-stop', text: '停止', stop_reason: 'endpoint' });

    const stopRun = await waitFor(() => runtime.store.one(
      'SELECT * FROM runs WHERE idempotency_key = ?',
      'asr:utt-stop',
    ));
    check('判据 1：建了且只建了一条 asr run', Boolean(stopRun) && runCount() === 1, String(runCount()));
    check('判据 1：source=asr', stopRun?.source === 'asr', stopRun?.source);
    check('判据 1：route=fast', stopRun?.route === 'fast', stopRun?.route);
    check('判据 1：fast_rule=stop_robot@1', stopRun?.fast_rule === 'stop_robot@1', stopRun?.fast_rule);
    check('判据 1：幂等键 asr:<utterance_id>', stopRun?.idempotency_key === 'asr:utt-stop', stopRun?.idempotency_key);
    const stopCall = await waitFor(() => (callsTo('/v1/robot/stop').length > 0 ? callsTo('/v1/robot/stop')[0] : null));
    check('判据 1：robotd 真的收到 POST /v1/robot/stop', Boolean(stopCall), JSON.stringify(robotdCalls.map((c) => c.path)));
    check('判据 1：stop 请求是 POST（不是只记了状态）', stopCall?.method === 'POST', JSON.stringify(stopCall));
    const succeeded = await waitFor(() => (runRow(stopRun?.run_id)?.status === 'succeeded' ? true : null));
    check('判据 1：run 走到 succeeded', succeeded === true, runRow(stopRun?.run_id)?.status);
    check('判据 1：事件库有 speech.utterance_heard', eventsFor('utt-stop').some((e) => e.type === 'speech.utterance_heard'));

    // ------------------------------------------------ 判据 2：同一 final 重放
    const runsBeforeReplay = runCount();
    const stopsBeforeReplay = callsTo('/v1/robot/stop').length;
    feed('speech.final', { utterance_id: 'utt-stop', text: '停止', stop_reason: 'endpoint' });
    await new Promise((r) => setTimeout(r, 60));
    check('判据 2：重放不新增 run', runCount() === runsBeforeReplay, `${runsBeforeReplay} → ${runCount()}`);
    check('判据 2：重放不重复执行 stop', callsTo('/v1/robot/stop').length === stopsBeforeReplay, String(callsTo('/v1/robot/stop').length));

    // ------------------------------------------------ 判据 3：no_speech
    const runsBeforeNoSpeech = runCount();
    feed('speech.final', { utterance_id: 'utt-no-speech', text: '', no_speech: true, stop_reason: 'silence' });
    await new Promise((r) => setTimeout(r, 40));
    check('判据 3：no_speech 不建 run', runCount() === runsBeforeNoSpeech, `${runsBeforeNoSpeech} → ${runCount()}`);
    const noSpeechEvents = eventsFor('utt-no-speech');
    check(
      '判据 3：事件库里只有 speech.no_speech',
      noSpeechEvents.length === 1 && noSpeechEvents[0].type === 'speech.no_speech',
      JSON.stringify(noSpeechEvents),
    );
    check('判据 3：没有 observation.speech_ignored', !noSpeechEvents.some((e) => e.type === 'observation.speech_ignored'));

    // ------------------------------------------------ 判据 4：忙 → 记账，不建 run
    const active = runtime.runs.submitRun({ prompt: '正在执行的任务', route: 'harness' });
    runtime.runs.transition(active.run_id, 'executing');
    const runsBeforeBusy = runCount();
    feed('speech.final', { utterance_id: 'utt-busy', text: '往前走一步', stop_reason: 'endpoint' });
    await new Promise((r) => setTimeout(r, 40));
    check('判据 4：忙时不新建 run', runCount() === runsBeforeBusy, `${runsBeforeBusy} → ${runCount()}`);
    const busyEvents = eventsFor('utt-busy');
    const busyObs = busyEvents.find((e) => e.type === 'observation.speech_ignored');
    check('判据 4：写了 observation.speech_ignored', Boolean(busyObs), JSON.stringify(busyEvents));
    check(
      '判据 4：忽略原因 reason=busy',
      busyObs ? JSON.parse(busyObs.params_json).reason === 'busy' : false,
      busyObs?.params_json,
    );
    check('判据 4：没有变成 asr run', !runtime.store.one(
      "SELECT run_id FROM runs WHERE idempotency_key = 'asr:utt-busy'",
    ));
    runtime.runs.cancelRun(active.run_id, '清理');

    // ------------------------------------------------ 判据 5：审批层 + 执行层
    const followBefore = callsTo('/v1/robot/follow').length;
    const speakBefore = callsTo('/v1/robot/speak').length;
    feed('speech.started', { utterance_id: 'utt-follow', aec_erle_db: 30 });
    feed('speech.final', { utterance_id: 'utt-follow', text: '过来 track:abc', stop_reason: 'endpoint' });

    const approval = await waitFor(() => runtime.store.one(
      'SELECT * FROM approvals ORDER BY rowid DESC LIMIT 1',
    ));
    check('判据 5：能力契约要求审批 → 建了审批', Boolean(approval), JSON.stringify(approval));
    check('判据 5：审批绑定 robot_follow', approval?.capability === 'robot_follow', approval?.capability);
    const announced = await waitFor(() => runtime.store.one(
      "SELECT * FROM approvals WHERE approval_id = ? AND status = 'announced'",
      approval?.approval_id ?? '\u0000none',
    ));
    check('判据 5：复述已受理（status=announced）', Boolean(announced), approval?.status);

    // 复述播完才开窗（GH-11 的因果顺序）。
    feed('speech.tts_started', {
      response_id: 'tts-approval',
      approval_id: approval?.approval_id,
      kind: 'approval_repeat',
    });
    feed('speech.tts_finished', {
      response_id: 'tts-approval',
      approval_id: approval?.approval_id,
      kind: 'approval_repeat',
      chunks: 1,
      played: 1,
    });
    const waiting = await waitFor(() => {
      const row = runRow(approval?.run_id);
      const appr = runtime.store.one(
        'SELECT * FROM approvals WHERE approval_id = ?',
        approval?.approval_id ?? '\u0000none',
      );
      return row?.status === 'waiting_confirmation' && appr?.status === 'waiting' ? { row, appr } : null;
    });
    check('判据 5：审批层 run=waiting_confirmation', waiting?.row.status === 'waiting_confirmation', waiting?.row.status);
    check('判据 5：审批层 approvals.status=waiting', waiting?.appr.status === 'waiting', waiting?.appr.status);
    check('判据 5：执行层 robot_follow 计数为 0', callsTo('/v1/robot/follow').length === followBefore, String(callsTo('/v1/robot/follow').length));
    check('判据 5：执行层没有结论播报', callsTo('/v1/robot/speak').length === speakBefore, String(callsTo('/v1/robot/speak').length));

    // 「确认」之后才执行：不确认 = 永远不执行，两者在测试上必须分得开。
    const windowOpensAt = Date.parse(waiting?.appr.window_opens_at ?? '0');
    const confirmAt = new Date(windowOpensAt + 10).toISOString();
    feed('speech.started', { utterance_id: 'utt-confirm' }, confirmAt);
    feed('speech.final', { utterance_id: 'utt-confirm', text: '确认', stop_reason: 'endpoint' }, confirmAt);
    const followCall = await waitFor(() => {
      const calls = callsTo('/v1/robot/follow');
      return calls.length > followBefore ? calls.at(-1) : null;
    });
    check('判据 5：确认后才执行 robot_follow', Boolean(followCall), String(callsTo('/v1/robot/follow').length));
    check('判据 5：执行带一次性审批凭据', typeof followCall?.approvalHeader === 'string' && followCall.approvalHeader.includes('.'), String(followCall?.approvalHeader));
    check('判据 5：参数来自那句话（target_track_id=abc）', followCall?.body?.target_track_id === 'abc', JSON.stringify(followCall?.body));
    const followedRun = await waitFor(() => (runRow(approval?.run_id)?.status === 'succeeded' ? true : null));
    check('判据 5：确认后 run 走到 succeeded', followedRun === true, runRow(approval?.run_id)?.status);

    // ------------------------------------------------ 中断的 final 不算一句话
    const runsBeforeInterrupted = runCount();
    feed('speech.started', { utterance_id: 'utt-barge', aec_erle_db: 30 });
    feed('speech.final', { utterance_id: 'utt-barge', text: '往前', stop_reason: 'barge_in' });
    await new Promise((r) => setTimeout(r, 40));
    check('中断 final 不建 run', runCount() === runsBeforeInterrupted, `${runsBeforeInterrupted} → ${runCount()}`);
    const interruptedEvents = eventsFor('utt-barge');
    check(
      '中断 final 只落 speech.no_speech',
      interruptedEvents.length === 1 && interruptedEvents[0].type === 'speech.no_speech',
      JSON.stringify(interruptedEvents),
    );
    check('中断 final 没有被当成指令提交', !runtime.store.one(
      "SELECT run_id FROM runs WHERE idempotency_key = 'asr:utt-barge'",
    ));

    // ------------------------------------------------ GH-12 判据 6：显式结束不建 run
    const runsBeforeEnd = runCount();
    const joinedBeforeEnd = runtime.store.one(
      "SELECT COUNT(*) AS n FROM events WHERE type = 'conversation.turn_joined'",
    ).n;
    feed('speech.final', { utterance_id: 'utt-conversation-end', text: '算了', stop_reason: 'endpoint' });
    await new Promise((r) => setTimeout(r, 40));
    check('判据 6：说「算了」不建 run', runCount() === runsBeforeEnd, `${runsBeforeEnd} → ${runCount()}`);
    check('判据 6：没有 asr run', !runtime.store.one(
      "SELECT run_id FROM runs WHERE idempotency_key = 'asr:utt-conversation-end'",
    ));
    const endReset = runtime.store.one(
      "SELECT * FROM events WHERE type = 'conversation.turn_reset' ORDER BY seq DESC LIMIT 1",
    );
    check(
      '判据 6：写 turn_reset{user_ended}',
      endReset ? JSON.parse(endReset.params_json).reason === 'user_ended' : false,
      endReset?.params_json,
    );
    check(
      '判据 6：conversation.* 里没有「算了」原文',
      runtime.store.one(
        "SELECT COUNT(*) AS n FROM events WHERE type LIKE 'conversation.%' AND params_json LIKE '%算了%'",
      ).n === 0,
    );

    // 结束之后下一句重新从第 1 句起：不该出现新的 turn_joined。
    feed('speech.final', { utterance_id: 'utt-after-end', text: '慢一点', stop_reason: 'endpoint' });
    const afterEndRun = await waitFor(() => runtime.store.one(
      'SELECT * FROM runs WHERE idempotency_key = ?',
      'asr:utt-after-end',
    ));
    const joinedAfterEnd = runtime.store.one(
      "SELECT COUNT(*) AS n FROM events WHERE type = 'conversation.turn_joined'",
    ).n;
    check('判据 6：结束后的下一句照常建 run', Boolean(afterEndRun), String(runCount()));
    check('判据 6：结束后的下一句走 harness', afterEndRun?.route === 'harness', afterEndRun?.route);
    check('判据 6：下一句不续旧回合（无新 turn_joined）', joinedAfterEnd === joinedBeforeEnd, `${joinedBeforeEnd} → ${joinedAfterEnd}`);

    // ------------------------------------------------ speech.ignored 全链：robotd 发 → agentd 收
    const obsBeforeDropped = runtime.store.one(
      "SELECT COUNT(*) AS n FROM events WHERE type = 'observation.speech_ignored'",
    ).n;
    feed('speech.ignored', { utterance_id: 'utt-dropped-by-robotd', reason: 'busy' });
    const droppedObs = await waitFor(() => runtime.store.one(
      "SELECT * FROM events WHERE type = 'observation.speech_ignored' AND params_json LIKE ? ORDER BY seq DESC LIMIT 1",
      '%utt-dropped-by-robotd%',
    ));
    check('speech.ignored → observation.speech_ignored', Boolean(droppedObs), String(obsBeforeDropped));
    check(
      'speech.ignored 保留 reason/utterance_id',
      droppedObs ? JSON.parse(droppedObs.params_json).reason === 'busy' && JSON.parse(droppedObs.params_json).utterance_id === 'utt-dropped-by-robotd' : false,
      droppedObs?.params_json,
    );
    check('speech.ignored 的来源是 robotd', droppedObs?.source === 'robotd', droppedObs?.source);
    check('speech.ignored 也写了日志', logs.some((l) => l.msg.includes('丢弃')), JSON.stringify(logs.slice(-3)));
  } finally {
    await runtime.close();
    runtime.runs.dispose();
    await new Promise((resolve) => fakeRobotd.close(resolve));
    fs.rmSync(acceptanceRoot, { recursive: true, force: true });
    delete process.env.WALLY_APP_DATA_DIR;
  }
}

store.close();
await runAcceptance();
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
