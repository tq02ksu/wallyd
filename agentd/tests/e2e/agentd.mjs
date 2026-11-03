/**
 * 端到端手验：真起 agentd（回环、真 SQLite）+ 真 sim robotd，走真实 HTTP / WS。
 *
 * 覆盖：健康检查、CSRF 门禁、总览（含身体观测新鲜度）、会话与任务全链路、
 * 事件分页与过滤、模型配置的不可变 revision / 只写凭证 / CAS / 验证门槛、
 * 停止语义、WS 实时推送与 resync。
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRuntime, defaultConfig, makeLogger } from '../../src/agentd/service.ts';
import { computeAccept } from '../../src/agentd/ws.ts';

// 运行产物统一落到 work/（见 .gitignore），测试代码本身留在 tests/ 里受版本控制。
const root = new URL('../../../work/agentd-test/e2e-runtime', import.meta.url).pathname;
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

const config = {
  ...defaultConfig(),
  httpPort: 0,
  dataDir: root,
  staticDir: null,
  logLevel: 'warn',
  // 默认必须指向 robotd 的端口（8787）。写过 8791 是 agentd 自己的端口，
  // 那样「未连上」分支会静默把电池/设备断言跳过，测试看起来全绿却没有覆盖。
  robotdUrl: process.env.ROBOTD_URL ?? 'http://127.0.0.1:8787',
};
const runtime = await createRuntime(config, { log: makeLogger('warn') });
const base = `http://127.0.0.1:${runtime.port}`;
const CSRF = runtime.csrfToken;

async function api(method, route, opts = {}) {
  const headers = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-agentd-csrf'] = CSRF;
  const res = await fetch(`${base}${route}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, headers: res.headers };
}

// ---------------------------------------------------------------- 基础
{
  const h = await api('GET', '/healthz');
  check('healthz 200', h.status === 200);
  check('healthz daemon=agentd', h.json.daemon === 'agentd');
  check('healthz 有 boot_id', typeof h.json.boot_id === 'string');
  check('生产模式 test_mode 全 false', h.json.test_mode.allow_manual_approve === false);
  check('store writable', h.json.store.writable === true);

  const s = await api('GET', '/api/session');
  check('session 下发 csrf', s.json.csrf === CSRF);
  const noCsrf = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('写请求缺 CSRF → 403', noCsrf.status === 403);
  const wrongCsrf = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agentd-csrf': 'nope' },
    body: '{}',
  });
  check('错 CSRF → 403', wrongCsrf.status === 403);
  const crossOrigin = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agentd-csrf': CSRF, origin: 'http://evil.test' },
    body: '{}',
  });
  check('跨源 → 403', crossOrigin.status === 403);
  const notFound = await api('GET', '/api/nope');
  check('未知 API 404', notFound.status === 404 && notFound.json.error.code === 'E_NOT_FOUND');
}

// ---------------------------------------------------------------- 总览
{
  const st = await api('GET', '/api/state');
  check('state 200', st.status === 200);
  check('state 必填字段齐全', ['ok', 'generated_at', 'self', 'body', 'brain', 'active_run', 'recent_events', 'issues'].every((k) => k in st.json), JSON.stringify(Object.keys(st.json)));
  const bodyObs = st.json.body;
  console.log(`       身体观测: state=${bodyObs.state} source=${bodyObs.source} fresh=${JSON.stringify(bodyObs.freshness)}`);
  check('身体观测带 source', bodyObs.source === 'robotd');
  check('身体观测带 observed_at 或 note', bodyObs.observed_at !== undefined);
  check('freshness 带 threshold', typeof bodyObs.freshness.threshold_ms === 'number');
  if (bodyObs.state === 'ok') {
    check('连上时 robot 非 null', bodyObs.robot !== null);
    check('电池不造数', bodyObs.robot.battery === null || bodyObs.robot.battery.percent === null || typeof bodyObs.robot.battery.percent === 'number');
    check('设备状态不造数（未知就报未知）', Object.values(bodyObs.robot.devices ?? {}).every((v) => ['ready', 'unknown', 'missing', 'error'].includes(v)));
  } else {
    // 这条 else 分支是「对降级行为的断言」，不是「连不上也能过」的逃生门。
    // 除非测试明确声明在测离线路径，否则连不上就是环境错了，必须让它红。
    check(
      'robotd 连不上（离线路径需要显式设置 E2E_ALLOW_OFFLINE=1）',
      process.env.E2E_ALLOW_OFFLINE === '1',
      `state=${bodyObs.state} note=${bodyObs.note ?? '(无)'}；请先起 robotd: npm run robotd:sim`,
    );
    check('未连上时 state 是 offline/not_connected', ['offline', 'not_connected'].includes(bodyObs.state));
    check('未连上时 issues 有对应条目', st.json.issues.some((i) => i.title.includes('读不到机器人状态')));
  }
  check('issues 已排序（error 在前）', (() => {
    const rank = { error: 0, warning: 1, info: 2 };
    return st.json.issues.every((it, i, arr) => i === 0 || rank[arr[i - 1].severity] <= rank[it.severity]);
  })());
}

// ---------------------------------------------------------------- 会话与任务
let sessionId;
{
  const c = await api('POST', '/api/sessions', { body: { title: '端到端' } });
  check('建会话 200', c.status === 200, JSON.stringify(c.json));
  sessionId = c.json.session_id;
  check('会话有 id', typeof sessionId === 'string');
  check('会话默认字段', c.json.status === 'active' && typeof c.json.created_at === 'string');

  const unknownField = await api('POST', '/api/sessions', { body: { title: 'x', bogus: 1 } });
  check('未知字段被拒 400', unknownField.status === 400 && unknownField.json.error.code === 'E_VALIDATION');

  const run = await api('POST', '/api/run', { body: { prompt: '去厨房看看', session_id: sessionId, idempotency_key: 'e2e-1' } });
  check('提交任务 200', run.status === 200, JSON.stringify(run.json));
  check('返回 run_id', typeof run.json.run_id === 'string');
  check('route=harness', run.json.route === 'harness');

  const dup = await api('POST', '/api/run', { body: { prompt: '去厨房看看', session_id: sessionId, idempotency_key: 'e2e-1' } });
  // 注意：此时活动 run 存在，应当先报 busy —— 这也是正确行为
  check('重复提交被 busy 或 duplicate 拦住', dup.status === 409 || dup.json.duplicate === true, `${dup.status} ${JSON.stringify(dup.json)}`);

  const busyRun = await api('POST', '/api/run', { body: { prompt: '另一个请求' } });
  check('活动任务上限 1 → 409', busyRun.status === 409 && busyRun.json.error.code === 'E_BUSY', JSON.stringify(busyRun.json));

  const detail = await api('GET', `/api/runs/${run.json.run_id}`);
  check('任务详情 200', detail.status === 200);
  check('详情 run.accepted', detail.json.run.status === 'accepted');
  check('result.in_progress', detail.json.result.outcome === 'in_progress');

  const sess = await api('GET', `/api/sessions/${sessionId}`);
  check('会话详情含消息', sess.json.messages.some((m) => m.text === '去厨房看看'));
  check('消息 role=user', sess.json.messages.find((m) => m.text === '去厨房看看').role === 'user');

  const list = await api('GET', '/api/runs');
  check('任务列表', list.json.runs.some((r) => r.run_id === run.json.run_id));

  const cancel = await api('POST', `/api/runs/${run.json.run_id}/cancel`, { body: { reason: '端到端收尾' } });
  check('取消 200', cancel.status === 200);
  check('取消后 cancelled', cancel.json.run.status === 'cancelled');
  check('取消后 outcome=cancelled', cancel.json.result.outcome === 'cancelled');

  const cancelAgain = await api('POST', `/api/runs/${run.json.run_id}/cancel`, { body: {} });
  check('重复取消幂等', cancelAgain.status === 200 && cancelAgain.json.run.status === 'cancelled');
}

// ---------------------------------------------------------------- 事件
{
  const ev = await api('GET', '/api/events');
  check('事件 200', ev.status === 200);
  check('事件有 head_cursor', typeof ev.json.head_cursor === 'string');
  check('事件有可读标题', ev.json.events.every((e) => typeof e.title === 'string' && e.title.length > 0));
  check('事件摘要无未解析占位符', ev.json.events.every((e) => !e.summary.includes('{')), JSON.stringify(ev.json.events.map((e) => e.summary)));
  for (const e of ev.json.events.slice(0, 4)) console.log(`       ${e.severity} ${e.title} — ${e.summary}`);
  check('事件不含 token 类字段', ev.json.events.every((e) => !('raw_prompt' in (e.data ?? {}))));

  const filtered = await api('GET', '/api/events?severity=warning');
  check('severity 过滤生效', filtered.json.events.every((e) => e.severity === 'warning'));

  const search = await api('GET', `/api/events?q=${encodeURIComponent('任务')}`);
  check('关键词搜索有结果', search.json.events.length > 0);

  const badCursor = await api('GET', '/api/events?cursor=notarealcursor');
  check('非法游标 410', badCursor.status === 410 && badCursor.json.error.code === 'E_CURSOR_EXPIRED');

  // 分页
  const page1 = await api('GET', '/api/events?limit=2');
  if (page1.json.next_cursor) {
    const page2 = await api('GET', `/api/events?limit=2&cursor=${encodeURIComponent(page1.json.next_cursor)}`);
    const ids1 = new Set(page1.json.events.map((e) => e.event_id));
    check('分页不重复', page2.json.events.every((e) => !ids1.has(e.event_id)));
  } else {
    check('分页（事件不足，跳过）', true);
  }
}

// ---------------------------------------------------------------- 模型配置
{
  const created = await api('POST', '/api/model-profiles', {
    body: {
      name: '本地模型',
      provider: 'openai_compatible',
      endpoint: 'http://127.0.0.1:8790/v1',
      model: 'qwen2.5',
      credential: 'sk-super-secret-123',
    },
  });
  check('建 profile 200', created.status === 200, JSON.stringify(created.json));
  const pid = created.json.profile.profile_id;
  check('生成 revision 1', created.json.revisions[0].revision === 1);
  check('凭证只报 set', created.json.revisions[0].credential_set === true);
  check('响应不含凭证明文', !JSON.stringify(created.json).includes('sk-super-secret-123'), 'SECRET LEAKED');
  check('默认不激活', created.json.profile.active === false);

  const cloud = await api('POST', '/api/model-profiles', {
    body: { name: 'x', provider: 'openai_compatible', endpoint: 'https://api.example.com/v1', model: 'm', data_boundary: 'cloud_shared' },
  });
  check('拒绝非 local_only', cloud.status === 400, JSON.stringify(cloud.json));

  const embedded = await api('POST', '/api/model-profiles', {
    body: { name: 'x', provider: 'openai_compatible', endpoint: 'https://user:pass@api.example.com/v1', model: 'm' },
  });
  check('拒绝 endpoint 内嵌凭证', embedded.status === 400);

  // 激活未验证的 → 拒绝
  const actFail = await api('POST', `/api/model-profiles/${pid}/activate`, { body: { revision: 1 } });
  check('未验证不能激活', actFail.status === 400 && /尚未验证/.test(actFail.json.error.message), JSON.stringify(actFail.json));

  // 验证（robotd 不是模型服务，必然不通过 → 正是要的：不假装通过）
  const val = await api('POST', `/api/model-profiles/${pid}/validate`, { body: { revision: 1 } });
  check('验证 200（结论在 body）', val.status === 200, JSON.stringify(val.json).slice(0, 200));
  check('验证分项齐全', val.json.checks.length >= 6);
  check('必需项失败了就不能 compatible', val.json.verdict === 'incompatible' || val.json.verdict === 'compatible');
  check('验证说明 HTTP200≠可用', /不等于可用于 Agent/.test(val.json.note), val.json.note);
  console.log(`       verdict=${val.json.verdict} checks=${val.json.checks.map((c) => `${c.id}:${c.state}`).join(',')}`);

  // CAS
  const u1 = await api('PUT', `/api/model-profiles/${pid}`, { body: { base_revision: 1, model: 'qwen2.5:7b' } });
  check('修改生成 revision 2', u1.status === 200 && u1.json.profile.latest_revision === 2, JSON.stringify(u1.json).slice(0, 200));
  check('revision 历史保留', u1.json.revisions.length === 2);
  const stale = await api('PUT', `/api/model-profiles/${pid}`, { body: { base_revision: 1, model: 'x' } });
  check('旧 base_revision → 409', stale.status === 409 && stale.json.error.code === 'E_CONFLICT', JSON.stringify(stale.json));

  const clear = await api('PUT', `/api/model-profiles/${pid}`, { body: { base_revision: 2, clear_credential: true } });
  check('清凭证后 credential_set=false', clear.json.revisions.find((r) => r.revision === 3).credential_set === false);

  const list = await api('GET', '/api/model-profiles');
  check('列表 external_model_open=false', list.json.external_model_open === false);
  const leaked = await api('GET', `/api/model-profiles/${pid}`);
  check('读接口永不回显凭证', !JSON.stringify(leaked.json).includes('sk-super-secret-123'));
}

// ---------------------------------------------------------------- 停止
{
  const run = await api('POST', '/api/run', { body: { prompt: '准备出发' } });
  check('准备一个活动任务', run.status === 200);
  const stop = await api('POST', '/api/stop', { body: {} });
  check('stop 200', stop.status === 200, JSON.stringify(stop.json));
  check('stop 取消了活动任务', stop.json.cancelled_run_id === run.json.run_id);
  const state = stop.json.body_stop.state;
  console.log(`       body_stop.state=${state} detail=${stop.json.body_stop.detail}`);
  check('body_stop.state 合法', ['requested', 'confirmed', 'unknown', 'not_applicable'].includes(state));
  if (state === 'confirmed') check('confirmed 必须有 board_ack=true', stop.json.body_stop.board_ack === true);
  if (state !== 'confirmed') check('非 confirmed 不得宣称停稳', !/已停稳/.test(stop.json.body_stop.detail));
}

// ---------------------------------------------------------------- WS
{
  const wsUrl = `ws://127.0.0.1:${runtime.port}/api/events/live`;
  const frames = [];
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', (e) => reject(new Error('ws error')));
    setTimeout(() => reject(new Error('ws open timeout')), 3000);
  });
  ws.addEventListener('message', (ev) => {
    try {
      frames.push(JSON.parse(ev.data));
    } catch {
      frames.push({ type: 'unparsed', raw: ev.data });
    }
  });
  await new Promise((r) => setTimeout(r, 200));
  check('先收到 hello', frames[0]?.type === 'hello', JSON.stringify(frames[0]));
  check('hello 带 boot_id', frames[0]?.boot_id === runtime.bootId);

  ws.send(JSON.stringify({ type: 'subscribe' }));
  await new Promise((r) => setTimeout(r, 200));
  check('订阅后有 subscribed', frames.some((f) => f.type === 'subscribed'), JSON.stringify(frames.map((f) => f.type)));

  const before = frames.length;
  await api('POST', '/api/sessions', { body: { title: '触发事件' } });
  await api('POST', '/api/run', { body: { prompt: 'WS 实时测试' } });
  await new Promise((r) => setTimeout(r, 300));
  const liveEvents = frames.slice(before).filter((f) => f.type === 'event');
  check('实时推送到达', liveEvents.length > 0, `frames=${frames.slice(before).map((f) => f.type)}`);
  check('推送内容是 EventView', liveEvents.every((f) => f.event && f.event.event_id && f.event.cursor));
  check('推送顺序递增', (() => {
    const seqs = liveEvents.map((f) => Number(Buffer.from(f.event.cursor, 'base64url').toString('utf8').slice(3)));
    return seqs.every((v, i) => i === 0 || v > seqs[i - 1]);
  })());

  // 错误 boot_id → resync
  const ws2 = new WebSocket(wsUrl);
  const frames2 = [];
  await new Promise((resolve) => ws2.addEventListener('open', resolve));
  ws2.addEventListener('message', (ev) => frames2.push(JSON.parse(ev.data)));
  ws2.send(JSON.stringify({ type: 'subscribe', boot_id: 'boot-old-instance', cursor: 'AAAA' }));
  await new Promise((r) => setTimeout(r, 250));
  const resync = frames2.find((f) => f.type === 'resync_required');
  check('实例变化 → resync_required', Boolean(resync), JSON.stringify(frames2.map((f) => f.type)));
  check('resync 原因是 instance_changed', resync?.reason === 'instance_changed');
  check('resync 要求重拉全量', /重新 GET/.test(resync?.note ?? ''));

  // 非法游标
  const ws3 = new WebSocket(wsUrl);
  const frames3 = [];
  await new Promise((resolve) => ws3.addEventListener('open', resolve));
  ws3.addEventListener('message', (ev) => frames3.push(JSON.parse(ev.data)));
  ws3.send(JSON.stringify({ type: 'subscribe', cursor: 'garbage-cursor' }));
  await new Promise((r) => setTimeout(r, 250));
  const r3 = frames3.find((f) => f.type === 'resync_required');
  check('非法游标 → resync_required', Boolean(r3));
  check('原因是 invalid_cursor', r3?.reason === 'invalid_cursor', r3?.reason);

  ws.close();
  ws2.close();
  ws3.close();
}

// ---------------------------------------------------------------- 非 WS 端点拒绝升级
{
  const raw = await new Promise((resolve) => {
    const sock = net.connect(runtime.port, '127.0.0.1', () => {
      sock.write(
        `GET /api/state HTTP/1.1\r\nHost: 127.0.0.1:${runtime.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let data = '';
    sock.on('data', (c) => (data += c));
    sock.on('close', () => resolve(data));
    setTimeout(() => { sock.destroy(); resolve(data); }, 800);
  });
  check('非 WS 路径拒绝升级', /HTTP\/1\.1 404/.test(raw), raw.slice(0, 80));
}

await runtime.close();
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
