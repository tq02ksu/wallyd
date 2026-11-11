/**
 * GH-11 验收：语音确认通道（`waiting_confirmation` 的唯一批准入口）。
 *
 * 用真实 `createRuntime` + 真 SQLite + 回环 HTTP，robotd 用本地假 HTTP 服务替身。
 * robotd 事件通过 `runtime.robotdBridge.handle()` 注入，覆盖判据 1–10。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntime, defaultConfig, makeLogger } from '../../src/agentd/service.ts';
import { ensureApprovalSigningKey } from '../../src/agentd/approval-key.ts';
import { approvalSecretPath } from '../../src/agentd/paths.ts';
import { approvalArgsDigest } from '../../../contracts/tools/approval-digest.mjs';
import { classifyApprovalUtterance } from '../../src/agentd/approval-intent.ts';
import { composeNarrationText } from '../../src/agentd/run-narrator.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const root = path.join(REPO, 'work', 'agentd-test', `approval-settle-${process.pid}`);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
process.env.WALLY_APP_DATA_DIR = path.join(root, 'appdata');
ensureApprovalSigningKey();

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

async function waitFor(fn, { timeoutMs = 2500, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return fn();
}

// 本沙箱可能拒绝 AF_INET bind（EPERM）。HTTP 级验收在 CI 运行；这里如实跳过，
// 不把「环境不允许绑回环」伪装成代码通过。
async function canBindLoopback() {
  return await new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

if (!(await canBindLoopback())) {
  console.log('— 判定谓词（无需网络）');
  check('「好」不批准', classifyApprovalUtterance('好').intent === 'none');
  check('「确认」批准', classifyApprovalUtterance('确认').intent === 'approve');
  check('「确认不用」按 deny', classifyApprovalUtterance('确认不用').intent === 'deny');
  console.log('SKIP: 回环 bind 被环境拒绝（EPERM）；HTTP 级验收在 CI 运行');
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.WALLY_APP_DATA_DIR;
  process.exit(failed === 0 ? 0 : 1);
}

// ---------------------------------------------------------------- 假 robotd
const robotdCalls = [];
const fakeRobotd = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
    const call = {
      method: req.method,
      path: url.pathname,
      body,
      header: req.headers['x-wally-approval'] ?? null,
      res_task_id: null,
    };
    robotdCalls.push(call);
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'POST' && url.pathname === '/v1/robot/announce') {
      return json(200, {
        ok: true,
        task_id: `ann-${robotdCalls.length}`,
        status: 'accepted',
        approval_id: body.approval_id,
        kind: body.kind,
        text: '请确认：跟随我。参数：{"target_track_id":"abc"}。确认请说“确认”。',
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/robot/follow') {
      return json(200, { ok: true, task_id: 'robot-task-1', state: 'accepted' });
    }
    if (req.method === 'POST' && url.pathname === '/v1/robot/speak') {
      // GH-13：run 终态会给结论播报走这里，每次都要回一个可关联的 task_id。
      call.res_task_id = `speak-task-${robotdCalls.length}`;
      return json(200, { ok: true, task_id: call.res_task_id, status: 'accepted' });
    }
    return json(404, { ok: false, error: { code: 'E_NOT_FOUND', message: 'no route' } });
  });
});
fakeRobotd.on('upgrade', (_req, socket) => socket.destroy());
await new Promise((resolve) => fakeRobotd.listen(0, '127.0.0.1', resolve));
const robotdPort = fakeRobotd.address().port;

const runtime = await createRuntime(
  {
    ...defaultConfig(),
    httpPort: 0,
    dataDir: path.join(root, 'agentd'),
    staticDir: null,
    logLevel: 'error',
    robotdUrl: `http://127.0.0.1:${robotdPort}`,
  },
  { log: makeLogger('error') },
);
const base = `http://127.0.0.1:${runtime.port}`;
const CSRF = runtime.csrfToken;

async function api(method, route, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-agentd-csrf'] = CSRF;
  const res = await fetch(`${base}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json, headers: res.headers };
}

let eventSeq = 0;
function feed(type, payload, timestamp = new Date().toISOString()) {
  eventSeq += 1;
  runtime.robotdBridge.handle({
    version: 1,
    type,
    event_id: `evt-test-${eventSeq}`,
    seq: eventSeq,
    timestamp,
    payload,
  });
}

function approvalById(approvalId) {
  return runtime.runs.getApproval(approvalId);
}
function runRow(runId) {
  return runtime.store.one('SELECT * FROM runs WHERE run_id = ?', runId);
}
function countEvents(type, approvalId) {
  return runtime.store.one(
    'SELECT COUNT(*) AS n FROM events WHERE type = ? AND approval_id = ?',
    type,
    approvalId,
  ).n;
}
function lastEventParams(type, approvalId) {
  const row = runtime.store.one(
    'SELECT params_json FROM events WHERE type = ? AND approval_id = ? ORDER BY seq DESC LIMIT 1',
    type,
    approvalId,
  );
  return row ? JSON.parse(row.params_json) : null;
}

function countEventsByType(type) {
  return runtime.store.one('SELECT COUNT(*) AS n FROM events WHERE type = ?', type).n;
}

/** 某条 utterance 的 `observation.speech_ignored`（分发器写的，不是审批 settle 写的）。 */
function ignoredForUtterance(utteranceId) {
  return runtime.store.all(
    "SELECT * FROM events WHERE type = 'observation.speech_ignored' AND params_json LIKE ? ORDER BY seq DESC",
    `%${utteranceId}%`,
  );
}

function speakCalls() {
  return robotdCalls.filter((c) => c.path === '/v1/robot/speak');
}

function decodeCredential(header) {
  const [payloadSeg] = String(header ?? '').split('.');
  if (!payloadSeg) return null;
  try {
    return JSON.parse(Buffer.from(payloadSeg, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * 每个验收段开跑前必须没有活动 run。
 *
 * 活动上限是 1，忙时不排队；上一段若留下一个非终态 run（例如播报未完成时说了句
 * 「确认」，分发器会如实把它当成新指令提交），下一段会拿到 E_BUSY 而不是被测行为。
 * 之前靠人肉记着每段收尾，漏一处就变成 `runId === undefined` 进 SQL 的 TypeError。
 */
async function ensureIdle() {
  const active = runtime.runs.activeRun();
  if (!active) return;
  runtime.runs.cancelRun(active.run_id, 'cleanup');
  const done = await waitFor(
    () => {
      const row = runRow(active.run_id);
      return row && row.status === 'cancelled' ? row : null;
    },
    { timeoutMs: 2000 },
  );
  if (!done) {
    console.log(
      'FAIL 前置清理：活动 run 没有进入 cancelled（后续验收会被 E_BUSY 污染）',
      active.run_id,
      runRow(active.run_id)?.status,
    );
    process.exit(1);
  }
}

async function submitFastRun(prompt) {
  await ensureIdle();
  const res = await api('POST', '/api/run', { prompt });
  check(`提交快速指令：${prompt}`, res.status === 200 && typeof res.json.run_id === 'string', JSON.stringify(res.json));
  // 只有真正走到快速路由才会过审批门；落成 harness 就没有审批，后面的断言会全线失真。
  // 之前用过「过来 target:abc」，它对规则来说是**不可路由**的表达（槽位只认
  // target_track_id / track / 目标），于是 run 落成 harness、整份验收静默失效。
  check('走的是快速路由（否则不会有审批门）', res.json.route === 'fast', JSON.stringify(res.json));
  const runId = res.json.run_id;
  if (typeof runId !== 'string' || !runId) {
    // 明确失败退出，不要让它进到 SQL 里变成一个看不出原因的 TypeError。
    console.log('FAIL 提交没有返回 run_id，后续断言无法进行', JSON.stringify(res.json));
    process.exit(1);
  }
  const approval = await waitFor(() =>
    runtime.store.one('SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at DESC LIMIT 1', runId),
  );
  check('审批已持久化', Boolean(approval), JSON.stringify(approval));
  if (!approval) {
    // 没有审批就没有后续验收：明确失败并退出，不要留一个 TypeError 栈把失败原因埋掉。
    console.log('FAIL 没有产生审批，后续裁决断言无法进行');
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(1);
  }
  await waitFor(() => {
    const a = approvalById(approval.approval_id);
    return a && a.approval_id === approval.approval_id && a.status === 'announced' ? a : null;
  });
  return { runId, approval: approvalById(approval.approval_id) };
}

function openWindow(approvalId) {
  const approval = approvalById(approvalId);
  feed('speech.tts_finished', {
    response_id: `tts-${approval.approval_id}`,
    approval_id: approval.approval_id,
    kind: 'approval_repeat',
    task_id: `ann-${approval.approval_id}`,
    chunks: 2,
    played: 2,
  });
  return waitFor(() => {
    const row = runRow(approval.run_id);
    return row && row.status === 'waiting_confirmation' ? approvalById(approval.approval_id) : null;
  });
}

function utterance(approvalId, utteranceId, text, { startedAt, erle } = {}) {
  const a = approvalById(approvalId);
  const opens = a?.window_opens_at ? Date.parse(a.window_opens_at) : Date.now();
  const ts = startedAt ?? new Date(opens + 1000).toISOString();
  feed('speech.started', { utterance_id: utteranceId, aec_erle_db: erle }, ts);
  feed('speech.final', { utterance_id: utteranceId, text, stop_reason: 'endpoint' });
}

// ---------------------------------------------------------------- 判定谓词
console.log('— 判定谓词：泛化肯定不批准、否定优先');
{
  check('「好」不批准', classifyApprovalUtterance('好').intent === 'none');
  check('「好的」不批准', classifyApprovalUtterance('好的').intent === 'none');
  check('「可以」不批准', classifyApprovalUtterance('可以').intent === 'none');
  check('「确认」批准', classifyApprovalUtterance('确认').intent === 'approve');
  check('「确认向前移动三十厘米」批准', classifyApprovalUtterance('确认向前移动三十厘米').intent === 'approve');
  check('「确认不用」按 deny', classifyApprovalUtterance('确认不用').intent === 'deny');
  check('「不用」按 deny', classifyApprovalUtterance('不用').intent === 'deny');
  check('「取消」按 deny', classifyApprovalUtterance('取消').intent === 'deny');
  check('「算了」按 deny', classifyApprovalUtterance('算了').intent === 'deny');
  check('「确认吗」不批准', classifyApprovalUtterance('确认吗').intent === 'none');
}

// ---------------------------------------------------------------- 判据 1 / 5 / 10
console.log('— 判据 1/5/10：确认 → executing → succeeded；复述不走 robot_speak');
{
  const { runId, approval } = await submitFastRun('过来 track:abc');
  check('审批 capability 是 robot_follow', approval.capability === 'robot_follow', approval.capability);
  check('播报走系统 announce，且没有 text 字段', robotdCalls.some((c) => c.path === '/v1/robot/announce' && !('text' in c.body)));

  const opened = await openWindow(approval.approval_id);
  check('播完后进入 waiting_confirmation', Boolean(opened));
  // 复述阶段（announce）不能触发结论播报：run 还没到终态，没东西可播。
  check('复述阶段没有结论播报', speakCalls().length === 0, JSON.stringify(speakCalls()));

  const before = robotdCalls.filter((c) => c.path === '/v1/robot/follow').length;
  utterance(approval.approval_id, 'utt-approve-1', '确认');
  await waitFor(() => {
    const r = runRow(runId);
    return r && r.status === 'succeeded' ? r : null;
  });
  const run = runRow(runId);
  check('确认后 run succeeded', run.status === 'succeeded', run.status);
  const approved = approvalById(approval.approval_id);
  check('审批状态 approved/voice', approved.status === 'approved' && approved.decided_by === 'voice');

  const followCalls = robotdCalls.filter((c) => c.path === '/v1/robot/follow');
  check('robotd 收到且只收到一次 follow', followCalls.length === before + 1, String(followCalls.length));
  const header = followCalls.at(-1)?.header;
  check('follow 带 X-Wally-Approval', typeof header === 'string' && header.includes('.'), String(header));

  // 凭据内容与契约摘要一致，且 HMAC 用共享秘密签在 payload 段上。
  const [payloadSeg, sig] = String(header).split('.');
  const payload = JSON.parse(Buffer.from(payloadSeg, 'base64url').toString('utf8'));
  check('凭据 capability 对齐', payload.capability === 'robot_follow');
  check('凭据 args_digest 走契约规范化', payload.args_digest === approvalArgsDigest({ target_track_id: 'abc' }, ['target_track_id', 'target']));
  const secret = Buffer.from(fs.readFileSync(approvalSecretPath(), 'utf8').trim(), 'hex');
  const expectedSig = crypto.createHmac('sha256', secret).update(payloadSeg, 'ascii').digest('base64url');
  check('凭据 HMAC 可验', sig === expectedSig);

  const detail = await api('GET', `/api/runs/${runId}`);
  const call = detail.json.tool_calls.at(-1);
  check('tool_calls.requires_approval=true', call?.requires_approval === true, JSON.stringify(call));
  check('tool_calls 关联 approval_id', call?.approval_id === approval.approval_id, JSON.stringify(call));

  // GH-13 判据 1：run 终态 → 桥收到 speak → speech.tts_finished → 事件库 speech.spoken。
  // 播报异步执行（不阻塞状态推进），所以要等它落到假 robotd 上。
  const speaks = await waitFor(() => (speakCalls().length > 0 ? speakCalls() : null));
  // 失败信息要能直接指向三种原因之一：没收到 speak / 收到了多次 / 凭据不对。
  const speakCountProblem =
    speaks === undefined
      ? '没有收到 speak 请求（run 终态未触发播报，或等待超时）'
      : speaks.length === 0
        ? '没有收到 speak 请求'
        : speaks.length > 1
          ? `收到了 ${speaks.length} 次 speak（应恰好 1 次）`
          : null;
  check('run 终态触发且只触发一次结论播报', speakCountProblem === null, speakCountProblem ?? '');
  const speak = speaks?.[0];
  check(
    'speak 带 X-Wally-Approval',
    typeof speak?.header === 'string' && speak.header.includes('.'),
    speak ? `speak 请求的凭据头不合法：${JSON.stringify(speak.header)}` : '没有收到 speak 请求',
  );
  const speakCredential = decodeCredential(speak?.header);
  check(
    '凭据 capability = robot_speak',
    speakCredential?.capability === 'robot_speak',
    speak ? `凭据 capability=${JSON.stringify(speakCredential?.capability)}（应为 robot_speak）` : '没有收到 speak 请求',
  );
  const expectedNarration = composeNarrationText(run, detail.json.steps ?? []);
  check(
    '播报正文来自执行事实（result_summary / step note / 兜底）',
    typeof speak?.body?.text === 'string' && speak.body.text === expectedNarration,
    `${JSON.stringify(speak?.body?.text)} != ${JSON.stringify(expectedNarration)}`,
  );
  check('播报正文非空', typeof speak?.body?.text === 'string' && speak.body.text.trim().length > 0);

  feed('speech.tts_started', { response_id: 'tts-narr-1', task_id: speak?.res_task_id });
  feed('speech.tts_finished', {
    response_id: 'tts-narr-1',
    task_id: speak?.res_task_id,
    chunks: 2,
    played: 2,
  });
  const afterSpoken = await waitFor(() => (runRow(runId).narration === 'spoken' ? runRow(runId) : null));
  check('播完后 narration=spoken', afterSpoken?.narration === 'spoken', afterSpoken?.narration);
  check('播报不改 run 状态', afterSpoken?.status === 'succeeded', afterSpoken?.status);
  const spokenEvent = runtime.store.one(
    "SELECT * FROM events WHERE type = 'speech.spoken' AND run_id = ?",
    runId,
  );
  check('事件库出现 speech.spoken 且关联 run', Boolean(spokenEvent), JSON.stringify(spokenEvent));
  const spokenParams = spokenEvent ? JSON.parse(spokenEvent.params_json) : null;
  check(
    'speech.spoken 带 chunks/played',
    spokenParams?.chunks === 2 && spokenParams?.played === 2,
    JSON.stringify(spokenParams),
  );
}

// ---------------------------------------------------------------- 判据 2（结论播报被打断）
console.log('— 判据 2：结论播报中 barge-in → run 仍 succeeded，narration=interrupted');
{
  const { runId, approval } = await submitFastRun('过来 track:abc');
  await openWindow(approval.approval_id);
  const speakBefore = speakCalls().length;
  utterance(approval.approval_id, 'utt-approve-bargein', '确认');
  await waitFor(() => (runRow(runId).status === 'succeeded' ? true : null));
  const speaks = await waitFor(() => (speakCalls().length > speakBefore ? speakCalls() : null));
  const speak = speaks?.at(-1);
  check(
    '被打断的是本次 run 的结论播报',
    Boolean(speak?.res_task_id),
    speak ? `speak 没有可关联的 task_id：${JSON.stringify(speak)}` : '没有收到本次 run 的 speak 请求',
  );

  // V03 的打断：话没说完，不是任务没做成。
  feed('speech.tts_cancelled', {
    response_id: 'tts-narr-bargein',
    task_id: speak?.res_task_id,
    reason: 'barge_in',
    played: 1,
  });
  const interrupted = await waitFor(() => (runRow(runId).narration === 'interrupted' ? runRow(runId) : null));
  check('narration = interrupted', interrupted?.narration === 'interrupted', interrupted?.narration);
  check('被 barge-in 的 run 仍是 succeeded', interrupted?.status === 'succeeded', interrupted?.status);
  const cancelEvent = runtime.store.one(
    "SELECT * FROM events WHERE type = 'speech.speak_cancelled' AND run_id = ?",
    runId,
  );
  check('事件库出现 speech.speak_cancelled 且关联 run', Boolean(cancelEvent), JSON.stringify(cancelEvent));
  const cancelParams = cancelEvent ? JSON.parse(cancelEvent.params_json) : null;
  check('打断原因 = barge_in', cancelParams?.reason === 'barge_in', JSON.stringify(cancelParams));
  check('没有把「没播完」记成播报失败', countEventsByType('speech.speak_failed') === 0);
}

// ---------------------------------------------------------------- 判据 2
console.log('— 判据 2：说「不用」→ cancelled(denied)，robotd 没收到动作');
{
  const { runId, approval } = await submitFastRun('过来 track:abc');
  await openWindow(approval.approval_id);
  const before = robotdCalls.filter((c) => c.path === '/v1/robot/follow').length;
  utterance(approval.approval_id, 'utt-deny-1', '不用');
  await waitFor(() => (runRow(runId).status === 'cancelled' ? true : null));
  const run = runRow(runId);
  check('deny 后 run cancelled', run.status === 'cancelled', run.status);
  check('blocking_reason = denied', run.blocking_reason === 'denied', run.blocking_reason);
  const denied = approvalById(approval.approval_id);
  check('审批状态 denied/voice', denied.status === 'denied' && denied.decided_by === 'voice');
  check('robotd 没有收到 follow', robotdCalls.filter((c) => c.path === '/v1/robot/follow').length === before);
}

// ---------------------------------------------------------------- 判据 5
console.log('— 判据 5：说「确认不用」按 deny');
{
  const { runId, approval } = await submitFastRun('过来 track:abc');
  await openWindow(approval.approval_id);
  utterance(approval.approval_id, 'utt-deny-2', '确认不用');
  await waitFor(() => (runRow(runId).status === 'cancelled' ? true : null));
  check('「确认不用」→ cancelled', runRow(runId).status === 'cancelled');
  check('「确认不用」→ denied', approvalById(approval.approval_id).status === 'denied');
}

// ---------------------------------------------------------------- 判据 7
console.log('— 判据 7：窗口开启前就开始说 → before_window');
{
  const { runId, approval } = await submitFastRun('过来 track:abc');
  await openWindow(approval.approval_id);
  const opens = approvalById(approval.approval_id).window_opens_at;
  utterance(approval.approval_id, 'utt-early', '确认', { startedAt: new Date(Date.parse(opens) - 1000).toISOString() });
  const ignored = lastEventParams('approval.ignored', approval.approval_id);
  check('记 approval.ignored', Boolean(ignored));
  check('reason = before_window', ignored?.reason === 'before_window', JSON.stringify(ignored));
  check('run 仍 waiting_confirmation', runRow(runId).status === 'waiting_confirmation', runRow(runId).status);
  runtime.runs.cancelRun(runId, 'cleanup');
}

// ---------------------------------------------------------------- 判据 8
console.log('— 判据 8：TTS 回声 → echo');
{
  const { runId, approval } = await submitFastRun('过来 track:abc');
  await openWindow(approval.approval_id);
  const ignoredBefore = countEvents('approval.ignored', approval.approval_id);
  const dispatchBefore = countEventsByType('observation.speech_ignored');
  // 回声证据挂在 `speech.started` 上（契约 events.json：speech.started.aec_erle_db，
  // GH-11 设计 §规则 6）。`speech.final` 的 payload 里没有这个字段——它只带文本。
  utterance(approval.approval_id, 'utt-echo', '确认', { erle: 1.0 });

  // 分发器在 take 审批之前就把回声拦下：写 `observation.speech_ignored {reason:"echo"}`，
  // 不会走到 settle，所以 `approval.ignored` 一条都不该多。
  const dispatched = await waitFor(() =>
    countEventsByType('observation.speech_ignored') > dispatchBefore ? ignoredForUtterance('utt-echo') : null,
  );
  check('分发器记了 observation.speech_ignored', dispatched?.length === 1, String(dispatched?.length));
  const ignoredParams = dispatched?.[0] ? JSON.parse(dispatched[0].params_json) : null;
  check('reason = echo', ignoredParams?.reason === 'echo', JSON.stringify(ignoredParams));
  check(
    '回声没有进审批 settle',
    countEvents('approval.ignored', approval.approval_id) === ignoredBefore,
    String(countEvents('approval.ignored', approval.approval_id) - ignoredBefore),
  );
  check('回声不让 run 推进', runRow(runId).status === 'waiting_confirmation', runRow(runId).status);
  check('回声不改变审批状态', approvalById(approval.approval_id).status === 'waiting', approvalById(approval.approval_id).status);
  runtime.runs.cancelRun(runId, 'cleanup');
  await waitFor(() => (runRow(runId).status === 'cancelled' ? true : null));
}

// ---------------------------------------------------------------- 判据 9
console.log('— 判据 9：播报未完成（played=0）不开窗，也不做 settle 判定');
{
  const { runId, approval } = await submitFastRun('过来 track:abc');
  feed('speech.tts_finished', {
    response_id: `tts-zero-${approval.approval_id}`,
    approval_id: approval.approval_id,
    kind: 'approval_repeat',
    played: 0,
  });
  await waitFor(() => (runRow(runId).status === 'failed' ? true : null));
  check('played=0 → run failed', runRow(runId).status === 'failed', runRow(runId).status);
  check('没有开窗事件', countEvents('run.waiting_confirmation', approval.approval_id) === 0);
  const ignoredBefore = countEvents('approval.ignored', approval.approval_id);
  utterance(approval.approval_id, 'utt-too-early', '确认');
  check('播报未完成时 confirm 不产生裁决', countEvents('approval.ignored', approval.approval_id) === ignoredBefore);
  check('run 没有被改回', runRow(runId).status === 'failed');
}

// ---------------------------------------------------------------- 判据 3 / 4
console.log('— 判据 3/4：窗口过期 → timeout → cancelled；迟到的确认被 ignored(expired)');
{
  const { runId, approval } = await submitFastRun('过来 track:abc');
  const opened = runtime.runs.openConfirmationWindow(approval.approval_id, 20);
  check('直接开一个 20ms 窗口', opened.opened === true, JSON.stringify(opened));
  await waitFor(() => (runRow(runId).status === 'cancelled' ? true : null), { timeoutMs: 1500 });
  check('超时后 run cancelled', runRow(runId).status === 'cancelled', runRow(runId).status);
  check('blocking_reason = expired', runRow(runId).blocking_reason === 'expired', runRow(runId).blocking_reason);
  check('审批 status = timeout', approvalById(approval.approval_id).status === 'timeout', approvalById(approval.approval_id).status);
  check('写 approval.expired', countEvents('approval.expired', approval.approval_id) === 1);

  utterance(approval.approval_id, 'utt-late', '确认');
  const ignored = lastEventParams('approval.ignored', approval.approval_id);
  check('迟到的确认记 ignored', Boolean(ignored));
  check('reason = expired', ignored?.reason === 'expired', JSON.stringify(ignored));
  check('迟到的确认不改状态', runRow(runId).status === 'cancelled' && approvalById(approval.approval_id).status === 'timeout');
}

// ---------------------------------------------------------------- 判据 6
console.log('— 判据 6：/api/approvals 只读，manual_approve_enabled=false');
{
  const pre = await api('OPTIONS', '/api/approvals');
  const allow = pre.headers.get('allow') ?? '';
  check('OPTIONS 返回允许方法', pre.status === 204, String(pre.status));
  check('Allow 里没有 POST', !allow.toUpperCase().split(',').map((s) => s.trim()).includes('POST'), allow);
  const list = await api('GET', '/api/approvals');
  check('列表 manual_approve_enabled=false', list.json.manual_approve_enabled === false, JSON.stringify(list.json.manual_approve_enabled));
  const health = await api('GET', '/healthz');
  check('healthz 显示 allow_manual_approve=false', health.json.test_mode?.allow_manual_approve === false);
}

// ---------------------------------------------------------------- 判据 1 补充：speech.partial 不参与
console.log('— 只用 final：speech.partial 不参与批准');
{
  const { runId, approval } = await submitFastRun('过来 track:abc');
  await openWindow(approval.approval_id);
  const ignoredBefore = countEvents('approval.ignored', approval.approval_id);
  feed('speech.partial', { utterance_id: 'utt-partial', revision: 1, text: '确认' });
  check('partial 不改变 run', runRow(runId).status === 'waiting_confirmation');
  check('partial 不产生 ignored / 裁决', countEvents('approval.ignored', approval.approval_id) === ignoredBefore);
  runtime.runs.cancelRun(runId, 'cleanup');
}

// ---------------------------------------------------------------- GH-53：再说一遍
console.log('— GH-53：再说一遍重播、不重置窗口；第 4 次未执行收尾');
{
  const { runId, approval } = await submitFastRun('过来 track:abc');
  const firstAnnounce = robotdCalls.find(
    (c) => c.path === '/v1/robot/announce' && c.body.approval_id === approval.approval_id,
  );
  check(
    '首播的 args_summary 走词表（不是 JSON 片段）',
    firstAnnounce?.body.args_summary === '目标：abc',
    JSON.stringify(firstAnnounce?.body.args_summary),
  );
  const opened = await openWindow(approval.approval_id);
  const openedAt = opened.window_opens_at;
  const closesAt = opened.window_closes_at;
  const announceBefore = robotdCalls.filter((c) => c.path === '/v1/robot/announce').length;
  const resolvedBefore = countEvents('approval.resolved', approval.approval_id);

  utterance(approval.approval_id, 'utt-repeat-1', '再说一遍');
  const repeated = await waitFor(
    () => (robotdCalls.filter((c) => c.path === '/v1/robot/announce').length > announceBefore ? true : null),
    { timeoutMs: 2000 },
  );
  check('「再说一遍」触发第二次系统播报', Boolean(repeated));
  const latestAnnounce = robotdCalls.filter((c) => c.path === '/v1/robot/announce').at(-1);
  check('重播仍走 approval_repeat', latestAnnounce?.body.kind === 'approval_repeat', JSON.stringify(latestAnnounce?.body));
  check('重播没有 text 字段', latestAnnounce && !('text' in latestAnnounce.body));
  const afterRepeat = approvalById(approval.approval_id);
  check('审批仍 waiting', afterRepeat.status === 'waiting', afterRepeat.status);
  check('window_opened_at 不变', afterRepeat.window_opens_at === openedAt, `${afterRepeat.window_opens_at} vs ${openedAt}`);
  check('window_closes_at 不变', afterRepeat.window_closes_at === closesAt);
  check('没有新增 approval.resolved', countEvents('approval.resolved', approval.approval_id) === resolvedBefore);
  check('写 approval.repeat_requested', countEvents('approval.repeat_requested', approval.approval_id) === 1);

  utterance(approval.approval_id, 'utt-repeat-2', '没听清');
  utterance(approval.approval_id, 'utt-repeat-3', '什么');
  check('第 3 次后仍 waiting', approvalById(approval.approval_id).status === 'waiting');
  utterance(approval.approval_id, 'utt-repeat-4', '没听清');
  const denied = await waitFor(() => (approvalById(approval.approval_id).status === 'denied' ? true : null));
  check('第 4 次按不执行收尾', Boolean(denied));
  const resolved = lastEventParams('approval.resolved', approval.approval_id);
  check('resolved=denied 且 reason=repeat_limit', resolved?.status === 'denied' && resolved?.reason === 'repeat_limit', JSON.stringify(resolved));
  check('run 未执行（cancelled）', runRow(runId).status === 'cancelled', runRow(runId).status);
  const unheard = await waitFor(() =>
    robotdCalls.find((c) => c.path === '/v1/robot/announce' && c.body.kind === 'approval_unheard') ?? null,
  );
  check('播报固定收尾句（approval_unheard）', Boolean(unheard), JSON.stringify(robotdCalls.at(-1)?.body));
}

// ---------------------------------------------------------------- 清理
await runtime.close();
runtime.runs.dispose();
await new Promise((resolve) => fakeRobotd.close(resolve));
fs.rmSync(root, { recursive: true, force: true });
delete process.env.WALLY_APP_DATA_DIR;

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
