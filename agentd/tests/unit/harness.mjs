/**
 * Harness 执行器单元测试（GH-10）。
 *
 * 用**假 Harness 客户端**跑真实的 Store / EventLog / RunService：覆盖 thread 复用、
 * resume 失败重建、工具调用落库、事件过滤、取消与超时。
 * 不 spawn codex 二进制，也不需要网络/凭证——真二进制的取证见 `npm run test:codex`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Store, nowIso } from '../../src/agentd/store.ts';
import { EventLog, loadRegistry } from '../../src/agentd/events.ts';
import { RunService, isTerminal } from '../../src/agentd/runs.ts';
import { ModelService } from '../../src/agentd/models.ts';
import {
  HarnessExecutor,
  JsonlHarnessSink,
  buildCodexEnv,
  computeHarnessStatus,
  parseHarnessVersion,
  probeHarnessVersion,
} from '../../src/agentd/harness.ts';

const root = new URL('../../../work/agentd-test/harness-runtime', import.meta.url).pathname;
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
const events = new EventLog(store, loadRegistry(), 'boot-harness');
const logLines = [];
const log = (msg, extra) => logLines.push({ msg, extra });
const svc = new RunService({ store, events, log, onCancel: (id) => executor?.abort(id) });

let executor = null;
let globalThreadSeq = 0;
let globalCallSeq = 0;

// ---------------------------------------------------------------- 假二进制与客户端
const fakeBinary = path.join(root, 'fake-codex');
fs.writeFileSync(fakeBinary, '#!/bin/sh\necho "codex-cli 9.9.9-test"\n', 'utf8');
fs.chmodSync(fakeBinary, 0o755);
const codexHome = path.join(root, 'codex-home');
const harnessDataDir = path.join(root, 'harness');

/** 造一个假客户端；turnFactory 每次 runStreamed 被调用一次。 */
function createFakeClient(turnFactory) {
  const calls = { starts: 0, resumes: [], turns: [] };
  const makeThread = (threadId, resumedFrom = null) => {
    const thread = {
      _id: threadId,
      get id() {
        return this._id;
      },
      async runStreamed(input, opts = {}) {
        const turn = {
          threadId: thread._id,
          resumedFrom,
          input,
          signal: opts.signal,
          index: calls.turns.length,
        };
        calls.turns.push(turn);
        const setThreadId = (id) => {
          thread._id = id;
          turn.threadId = id;
        };
        return { events: turnFactory({ ...turn, setThreadId }) };
      },
    };
    return thread;
  };
  const client = {
    startThread() {
      calls.starts += 1;
      return makeThread(null);
    },
    resumeThread(id) {
      calls.resumes.push(id);
      return makeThread(id, id);
    },
  };
  calls.nextId = () => `thread-${(globalThreadSeq += 1)}`;
  return { client, calls };
}

async function* textTurn({ threadId, setThreadId, nextId, text = '已完成' }) {
  const id = threadId ?? nextId();
  setThreadId(id);
  yield { type: 'thread.started', thread_id: id };
  yield { type: 'turn.started' };
  yield { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text } };
  yield { type: 'turn.completed', usage: {} };
}

async function* toolTurn({ threadId, setThreadId, nextId }) {
  const id = threadId ?? nextId();
  const callId = `call-${(globalCallSeq += 1)}`;
  setThreadId(id);
  yield { type: 'thread.started', thread_id: id };
  yield { type: 'turn.started' };
  yield { type: 'item.updated', item: { id: 'r1', type: 'reasoning', text: '思考中' } };
  yield {
    type: 'item.completed',
    item: {
      id: callId,
      type: 'mcp_tool_call',
      server: 'robotd',
      tool: 'robot_move',
      arguments: { distance_m: 0.3 },
      status: 'completed',
      result: { structured_content: { task_id: 'task-1' } },
    },
  };
  yield { type: 'item.completed', item: { id: 'msg-2', type: 'agent_message', text: '往前一点，然后跟着你。' } };
  yield { type: 'turn.completed', usage: {} };
}

async function* waitingTurn({ threadId, setThreadId, nextId, signal }) {
  const id = threadId ?? nextId();
  setThreadId(id);
  yield { type: 'thread.started', thread_id: id };
  await new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

async function* failingTurn({ threadId, setThreadId, nextId, message = 'model exploded' }) {
  const id = threadId ?? nextId();
  setThreadId(id);
  yield { type: 'thread.started', thread_id: id };
  yield { type: 'turn.failed', error: { message } };
}

function makeExecutor({ client, credentials = () => ({ apiKey: 'sk-test' }), timeoutMs = 5000, binary = fakeBinary } = {}) {
  const sinkEvents = [];
  const sink = {
    write(runId, event) {
      sinkEvents.push({ runId, event });
      jsonlSink.write(runId, event);
    },
  };
  const jsonlSink = new JsonlHarnessSink(harnessDataDir);
  executor = new HarnessExecutor({
    runs: svc,
    store,
    events,
    log,
    config: {
      binary,
      codexHome,
      workingDirectory: path.join(root, 'workspace'),
      timeoutMs,
    },
    clientFactory: async () => client,
    sink,
    credentials,
  });
  return { executor, sinkEvents };
}

function submit(sessionId, prompt) {
  return svc.submitRun({ prompt, session_id: sessionId, route: 'harness' });
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

function runEvents(runId) {
  return events.query({ runId, limit: 200 }).events;
}

// ---------------------------------------------------------------- 纯函数
console.log('— 隔离环境与状态判定');
{
  const env = buildCodexEnv(
    { PATH: '/usr/bin', HOME: '/Users/x', AWS_SECRET_ACCESS_KEY: 'nope', OPENAI_BASE_URL: 'http://host' },
    '/sandbox/codex-home',
    'sk-test',
  );
  check('env 带 CODEX_HOME', env.CODEX_HOME === '/sandbox/codex-home', JSON.stringify(env));
  check('env 带 CODEX_API_KEY', env.CODEX_API_KEY === 'sk-test');
  check('env 不继承其他变量', !('AWS_SECRET_ACCESS_KEY' in env) && !('OPENAI_BASE_URL' in env), JSON.stringify(env));
  check('env 保留 PATH/HOME', env.PATH === '/usr/bin' && env.HOME === '/Users/x');

  check('版本解析取第一行', parseHarnessVersion('\n codex-cli 0.164.0 \n') === 'codex-cli 0.164.0');
  check('probeHarnessVersion 读假二进制', probeHarnessVersion(fakeBinary, { codexHome }) === 'codex-cli 9.9.9-test');
  check('probeHarnessVersion 坏路径返回 null', probeHarnessVersion(path.join(root, 'missing'), { codexHome }) === null);

  const ready = computeHarnessStatus({
    binary: fakeBinary,
    exists: true,
    version: 'codex-cli 9.9.9',
    active: 0,
    approvalMode: 'voice',
    codexHome: '/sandbox',
  });
  check('配置齐全 → ready', ready.state === 'ready' && ready.version === 'codex-cli 9.9.9', JSON.stringify(ready));
  check(
    '有活动 run → running',
    computeHarnessStatus({
      binary: fakeBinary,
      exists: true,
      version: 'codex-cli 9.9.9',
      active: 1,
      approvalMode: 'voice',
      codexHome: '/sandbox',
    }).state === 'running',
  );
  const notConfigured = computeHarnessStatus({ binary: null, exists: false, version: null, active: 0, approvalMode: 'voice', codexHome: '/sandbox' });
  check('未配置 → not_configured', notConfigured.state === 'not_configured');
  const badPath = computeHarnessStatus({ binary: '/nope', exists: false, version: null, active: 0, approvalMode: 'voice', codexHome: '/sandbox' });
  check('路径不存在 → error + last_error', badPath.state === 'error' && Boolean(badPath.last_error), JSON.stringify(badPath));
}

// ---------------------------------------------------------------- 未配置
console.log('— 未配置凭证/二进制：不崩，failed harness_unconfigured');
{
  const session = svc.createSession('未配置');
  const r1 = submit(session.session_id, '带我去客厅');
  const { executor: ex1 } = makeExecutor({ client: createFakeClient(textTurn).client, credentials: () => ({ apiKey: null }) });
  const outcome1 = await ex1.run(r1.run_id);
  const d1 = svc.getRunDetail(r1.run_id);
  check('无 key 结局 failed', outcome1 === 'failed' && d1.run.status === 'failed', d1.run.status);
  check('原因 harness_unconfigured', d1.result.reason === 'harness_unconfigured', JSON.stringify(d1.result));
  check('说明缺 key', String(d1.run.blocking_reason).includes('harness_unconfigured'));
  check('没有任何 step 被假装执行', d1.steps.length === 0, JSON.stringify(d1.steps));

  const r2 = submit(session.session_id, '再来一次');
  const { executor: ex2 } = makeExecutor({ client: createFakeClient(textTurn).client, binary: null });
  await ex2.run(r2.run_id);
  check('无二进制同样 harness_unconfigured', svc.getRunDetail(r2.run_id).result.reason === 'harness_unconfigured');
}

// ---------------------------------------------------------------- 成功 + thread 复用
console.log('— 多步指令：planning → executing → succeeded，步骤/工具可读');
const sessionA = svc.createSession('会话 A');
let fakeA;
{
  fakeA = createFakeClient((ctx) => toolTurn({ ...ctx, nextId: fakeA.calls.nextId }));
  const { executor: ex } = makeExecutor({ client: fakeA.client });
  const run1 = submit(sessionA.session_id, '往前一点，然后跟着我');
  const outcome = await ex.run(run1.run_id);
  const detail = svc.getRunDetail(run1.run_id);
  check('执行成功', outcome === 'succeeded' && detail.run.status === 'succeeded', detail.run.status);

  const chronological = runEvents(run1.run_id).slice().reverse();
  const types = chronological.map((e) => e.type);
  const phaseTitles = chronological.filter((e) => e.type === 'run.step_changed').map((e) => e.title);
  check(
    '事件顺序有 planning → executing → succeeded',
    types.at(-1) === 'run.finished' && phaseTitles.some((t) => t.includes('规划')) && phaseTitles.some((t) => t.includes('执行')),
    types.join(','),
  );
  check('有规划与执行阶段', phaseTitles.some((t) => t.includes('规划')) && phaseTitles.some((t) => t.includes('执行')), phaseTitles.join('|'));
  check('run_steps 有可读记录', detail.steps.length >= 2 && detail.steps.some((s) => s.title.includes('robot_move')), JSON.stringify(detail.steps));
  check('tool_calls 有可读记录', detail.tool_calls.length === 1 && detail.tool_calls[0].capability === 'robot_move', JSON.stringify(detail.tool_calls));
  check('工具调用参数落库', detail.tool_calls[0].args_summary.includes('0.3'), detail.tool_calls[0].args_summary);
  check('最终结论摘要', detail.result.summary === '往前一点，然后跟着你。', detail.result.summary);

  // 事件过滤
  const banned = runEvents(run1.run_id).filter(
    (e) => e.type.startsWith('item.') || e.type.startsWith('harness.') || e.type.includes('reasoning'),
  );
  check('item.* / harness.* 不进 EventLog', banned.length === 0, banned.map((e) => e.type).join(','));
  const jsonl = fs.readFileSync(path.join(harnessDataDir, `${run1.run_id}.jsonl`), 'utf8');
  check('原始事件落 jsonl', jsonl.includes('item.completed') && jsonl.includes('reasoning'), jsonl.slice(0, 120));

  // 同一个 session 的第二句
  const run2 = submit(sessionA.session_id, '再往前一点');
  await ex.run(run2.run_id);
  check('第二个 run_id 不同', run1.run_id !== run2.run_id);
  check('第二个 run 复用 thread', fakeA.calls.resumes.at(-1) === svc.getSessionThreadId(sessionA.session_id), JSON.stringify(fakeA.calls.resumes));
  check('thread_id 已写入 sessions 表', typeof svc.getSessionThreadId(sessionA.session_id) === 'string');
  const d2 = svc.getRunDetail(run2.run_id);
  check('两次 harness 都成功', d2.run.status === 'succeeded', JSON.stringify(d2));
}

console.log('— 换 session：thread 必须不同');
{
  const sessionB = svc.createSession('会话 B');
  const fakeB = createFakeClient((ctx) => toolTurn({ ...ctx, nextId: fakeB.calls.nextId }));
  const { executor: ex } = makeExecutor({ client: fakeB.client });
  const run3 = submit(sessionB.session_id, '去门口');
  await ex.run(run3.run_id);
  const aThread = svc.getSessionThreadId(sessionA.session_id);
  check('新会话没有 resume 旧 thread', fakeB.calls.resumes.length === 0, JSON.stringify(fakeB.calls.resumes));
  check('新会话 thread 与 A 不同', svc.getSessionThreadId(sessionB.session_id) !== aThread,
    `${aThread} vs ${svc.getSessionThreadId(sessionB.session_id)}`);
}

// ---------------------------------------------------------------- resume 失败重建
console.log('— resume 失败：新建 thread 并明确记 harness.thread_rebuilt');
{
  const session = svc.createSession('历史丢了');
  svc.setSessionThreadId(session.session_id, 'gone-thread');
  const calls = { attempt: 0 };
  const client = {
    startThread() {
      calls.attempt += 1;
      const id = `rebuilt-${calls.attempt}`;
      return {
        get id() {
          return id;
        },
        async runStreamed() {
          return { events: textTurn({ setThreadId: () => {}, nextId: () => id }) };
        },
      };
    },
    resumeThread(id) {
      calls.attempt += 1;
      let first = true;
      return {
        get id() {
          return id;
        },
        async runStreamed() {
          return {
            events: (async function* () {
              if (first) {
                first = false;
                throw new Error(`no rollout found for thread id ${id}`);
              }
              yield { type: 'turn.completed', usage: {} };
            })(),
          };
        },
      };
    },
  };
  const { executor: ex } = makeExecutor({ client });
  const run = submit(session.session_id, '继续上次的任务');
  const outcome = await ex.run(run.run_id);
  check('重建后执行成功', outcome === 'succeeded', outcome);
  check('先 resume 失败再 startThread', calls.attempt === 2, String(calls.attempt));
  check('session 换成了新 thread', svc.getSessionThreadId(session.session_id) === 'rebuilt-2', svc.getSessionThreadId(session.session_id));
  const rebuildEvent = runEvents(run.run_id).find((e) => e.data?.note === 'harness.thread_rebuilt');
  check('事件里明确记 thread_rebuilt', Boolean(rebuildEvent) && rebuildEvent.title.includes('重建 Harness 线程'), JSON.stringify(rebuildEvent));
  const jsonl = fs.readFileSync(path.join(harnessDataDir, `${run.run_id}.jsonl`), 'utf8');
  check('jsonl 也有 thread_rebuilt', jsonl.includes('harness.thread_rebuilt'));
  check('日志有 thread_rebuilt', logLines.some((l) => l.msg === 'harness.thread_rebuilt'));
}

// ---------------------------------------------------------------- turn 失败
console.log('— thread 抛错：failed，run_steps 能看到失败阶段');
{
  const session = svc.createSession('失败会话');
  const fake = createFakeClient((ctx) => failingTurn({ ...ctx, nextId: fake.calls.nextId }));
  const { executor: ex } = makeExecutor({ client: fake.client });
  const run = submit(session.session_id, '让它失败');
  const outcome = await ex.run(run.run_id);
  const detail = svc.getRunDetail(run.run_id);
  check('结局 failed', outcome === 'failed' && detail.run.status === 'failed', detail.run.status);
  check('原因 harness_error', detail.result.reason === 'harness_error', JSON.stringify(detail.result));
  check('失败阶段写在 steps.note', detail.steps.some((s) => s.state === 'failed' && String(s.note).includes('model exploded')), JSON.stringify(detail.steps));
}

// ---------------------------------------------------------------- 取消
console.log('— 取消执行中的 run：< 1s 停止，终态 cancelled 不是 failed');
{
  const session = svc.createSession('取消会话');
  const fake = createFakeClient((ctx) => waitingTurn({ ...ctx, nextId: fake.calls.nextId }));
  const { executor: ex } = makeExecutor({ client: fake.client });
  const run = submit(session.session_id, '一直等着');
  const running = ex.run(run.run_id);
  const started = await waitFor(() => ex.activeCount() === 1);
  check('执行器已登记活动 run', started);
  const t0 = Date.now();
  const cancelled = svc.cancelRun(run.run_id, '用户取消');
  const outcome = await Promise.race([
    running,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000)),
  ]);
  const elapsed = Date.now() - t0;
  const detail = svc.getRunDetail(run.run_id);
  check('取消在 1s 内结束执行体', outcome === 'cancelled', String(outcome));
  check('耗时 < 1000ms', elapsed < 1000, `${elapsed}ms`);
  check('终态 cancelled', cancelled.changed && detail.run.status === 'cancelled', detail.run.status);
  check('outcome 是 cancelled 不是 failed', detail.result.outcome === 'cancelled', JSON.stringify(detail.result));
  check('执行器已释放活动 run', ex.activeCount() === 0, String(ex.activeCount()));
}

// ---------------------------------------------------------------- 超时
console.log('— 超时：abort 后 failed harness_timeout');
{
  const session = svc.createSession('超时会话');
  const fake = createFakeClient((ctx) => waitingTurn({ ...ctx, nextId: fake.calls.nextId }));
  const { executor: ex } = makeExecutor({ client: fake.client, timeoutMs: 80 });
  const run = submit(session.session_id, '超时任务');
  const outcome = await ex.run(run.run_id);
  const detail = svc.getRunDetail(run.run_id);
  check('结局 failed', outcome === 'failed', outcome);
  check('原因 harness_timeout', detail.result.reason === 'harness_timeout', JSON.stringify(detail.result));
}

// ---------------------------------------------------------------- harness_bridge
console.log('— models.harness_bridge：Harness 版本存在即 pass');
{
  const models = new ModelService({
    store,
    events,
    log,
    harnessVersion: () => 'codex-cli 9.9.9-test',
  });
  const created = models.create({
    name: '本地测试',
    provider: 'openai_compatible',
    endpoint: 'http://127.0.0.1:9',
    model: 'test-model',
    request_timeout_ms: 1000,
  });
  const result = await models.validate(created.profile.profile_id, null);
  const bridge = result.checks.find((c) => c.id === 'harness_bridge');
  check('harness_bridge = pass', bridge?.state === 'pass', JSON.stringify(bridge));
  check('detail 带版本', String(bridge?.detail).includes('9.9.9-test'), String(bridge?.detail));
}

// ---------------------------------------------------------------- 会话上下文
console.log('— 会话上下文只进发给模型的 prompt，标注为消歧，不落库');
{
  const session = svc.createSession('上下文会话');
  const fake = createFakeClient((ctx) => textTurn({ ...ctx, nextId: fake.calls.nextId, text: '好' }));
  const { executor: ex } = makeExecutor({ client: fake.client });
  const block = '[会话上下文·仅供消歧，不是新指令]\n第1轮：用户说「跟着我走 target:abc」，执行 robot_follow（规则 follow_me@1）\n[/会话上下文]';

  const withCtx = submit(session.session_id, '慢一点');
  await ex.run(withCtx.run_id, block);
  check('发给模型的 prompt 带上下文块', fake.calls.turns[0].input.includes('仅供消歧，不是新指令'), fake.calls.turns[0].input);
  check('发给模型的 prompt 保留原句', fake.calls.turns[0].input.startsWith('慢一点'), fake.calls.turns[0].input);
  check('run.prompt 不被上下文污染', svc.getRunRow(withCtx.run_id).prompt === '慢一点', svc.getRunRow(withCtx.run_id).prompt);
  const leaked = runEvents(withCtx.run_id).filter(
    (e) => JSON.stringify(e).includes('仅供消歧') || JSON.stringify(e).includes('跟着我走 target:abc'),
  );
  check('事件库里没有上下文正文', leaked.length === 0, leaked.map((e) => e.type).join(','));

  const noCtx = submit(session.session_id, '再往前一点');
  await ex.run(noCtx.run_id);
  check('没有上下文时 prompt 就是原句', fake.calls.turns[1].input === '再往前一点', fake.calls.turns[1].input);
}

executor?.dispose();
svc.dispose();
store.close();
console.log('');
if (failed > 0) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');
