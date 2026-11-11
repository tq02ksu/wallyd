/**
 * 契约一致性测试（agentd 版）。
 *
 * 与 robotd 的 `tests/contract/test_contract_parity.py` 同一个思路：
 *   - `npm run contract:check` 保证「生成物 == 契约」；
 *   - 本文件保证「实现 == 契约」。
 * 两者缺一，契约就会漂移——最典型的形态是「代码里加了端点、契约没加」，
 * 或者「契约写了、代码没实现」，而 contract:check 对这两种都看不见。
 *
 * 读的是生成物（已由 check.mjs 证明与源一致），所以这里不需要解析 YAML。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GEN = path.resolve(HERE, '..', '..', 'contracts', 'generated');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

function load(name) {
  const file = path.join(GEN, name);
  if (!fs.existsSync(file)) {
    throw new Error(`缺生成物 ${file}；先跑 npm run contract:all`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const endpoints = load('api-endpoints.json');

// ---------------------------------------------------------------- 1. 端点数与唯一性
console.log('— 端点清单');
const epKey = (e) => `${e.method} ${e.path}`;
const epKeys = endpoints.endpoints.map(epKey);
check('端点数量符合契约', epKeys.length === 20, `实际 ${epKeys.length}`);
check('端点无重复', new Set(epKeys).size === epKeys.length);
check('每个端点都有 operationId', endpoints.endpoints.every((e) => typeof e.operationId === 'string' && e.operationId));

// ---------------------------------------------------------------- 2. 实现 == 契约
// 这是本文件的核心：把「运行时真正注册的路由」和契约逐条比对。
console.log('— 实现注册的路由 == 契约声明的路由');
const { createRuntime, defaultConfig, makeLogger } = await import('../../src/agentd/service.ts');

const root = new URL('../../../work/agentd-test/contract-runtime', import.meta.url).pathname;
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

const runtime = await createRuntime(
  { ...defaultConfig(), httpPort: 0, dataDir: root, staticDir: null, logLevel: 'error', robotdUrl: 'http://127.0.0.1:1' },
  { log: makeLogger('error') },
);

try {
  // 契约里的端点分两类，必须分别核对：
  //   - 普通端点：必须真的注册进路由表；
  //   - WS 升级端点（契约标 x-websocket）：走 server.on('upgrade')，不在路由表里，
  //     所以核对它的路径是否被 upgrade handler 接受。两类都要查，不能因为「反正不在路由表」
  //     就把它从契约里删掉——那等于承认实现少了一部分接口。
  const regularEpKeys = endpoints.endpoints.filter((e) => !e.websocket).map(epKey);
  const wsEndpoints = endpoints.endpoints.filter((e) => e.websocket);

  const implRoutes = runtime.router.listRoutes().map((r) => `${r.method} ${r.template}`);

  const missingInImpl = regularEpKeys.filter((k) => !implRoutes.includes(k));
  const extraInImpl = implRoutes.filter((k) => !regularEpKeys.includes(k));

  check('契约里的普通端点都实现了', missingInImpl.length === 0, `缺：${missingInImpl.join(', ')}`);
  check('实现里没有契约外的普通端点', extraInImpl.length === 0, `多：${extraInImpl.join(', ')}`);

  // WS 端点走 server.on('upgrade')，不在路由表里。所以核对的是升级白名单 WS_PATHS，
  // 而不是把它从契约里删掉——删掉等于承认实现少了一部分接口。
  const { WS_PATHS } = await import('../../src/agentd/ws.ts');
  const wsContractPaths = wsEndpoints.map((e) => e.path).sort();
  const wsImplPaths = [...WS_PATHS].sort();
  check(
    'WS 白名单 == 契约里的 WS 端点',
    JSON.stringify(wsContractPaths) === JSON.stringify(wsImplPaths),
    `契约 ${wsContractPaths.join(',')} / 实现 ${wsImplPaths.join(',')}`,
  );

  // ------------------------------------------------------------ 3. 审批写入口禁令
  // ADR 与设计文档的硬约束：正常界面没有批准入口。
  // 契约里只要出现「批准」类写操作就算违规——不靠人工 review 保证。
  console.log('— 审批写入口禁令');
  const approvalWrites = endpoints.endpoints.filter(
    (e) => e.mutating && /approv/i.test(e.path) && !/^GET$/i.test(e.method),
  );
  check('契约里没有审批写入口', approvalWrites.length === 0, approvalWrites.map(epKey).join(', '));
  const approvalGet = endpoints.endpoints.filter((e) => /approv/i.test(e.path));
  check('审批只有只读端点', approvalGet.every((e) => e.method === 'GET'), approvalGet.map(epKey).join(', '));

  // ------------------------------------------------------------ 4. 只允许回环
  console.log('— 访问边界');
  const spec = load('openapi.json');
  const servers = spec.servers ?? [];
  check('servers 存在', servers.length > 0);
  check(
    'servers 全部是回环地址',
    servers.every((s) => /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?/.test(s.url)),
    servers.map((s) => s.url).join(', '),
  );

  // ------------------------------------------------------------ 5. 端点不得进 robotd 工具面
  console.log('— 两套生成物互不串门');
  const robotdTools = path.resolve(HERE, '..', '..', '..', 'contracts', 'generated', 'mcp-tools.json');
  if (fs.existsSync(robotdTools)) {
    const tools = JSON.parse(fs.readFileSync(robotdTools, 'utf8'));
    const toolNames = JSON.stringify(tools);
    const leaked = endpoints.endpoints.filter((e) => toolNames.includes(e.operationId));
    check('agentd 端点未出现在 robotd 工具面', leaked.length === 0, leaked.map((e) => e.operationId).join(', '));
  } else {
    check('robotd 生成物存在（用于串门检查）', false, `缺 ${robotdTools}`);
  }

  // ------------------------------------------------------------ 6. 事件登记表完整性
  console.log('— 事件登记表');
  const events = load('events.json');
  // templates 是数组（每条带 type 字段），不是以 type 为键的对象。
  const tpl = new Map(events.templates.map((t) => [t.type, t]));
  const types = events.templates.map((t) => t.type);
  check('登记的事件类型有 40 种', types.length === 40, `实际 ${types.length}`);
  // R14 的语音事件必须登记：缺任何一条，robotd 的语音事件到了 agentd 会被
  // `isRegistered` 拒写（实测踩过——事件被静默丢掉，页面上什么都没有）。
  const speechRequired = [
    'speech.utterance_heard',
    'speech.no_speech',
    'speech.audio_unavailable',
    'speech.audio_recovered',
    'speech.spoken',
    'speech.speak_cancelled',
    'speech.speak_failed',
  ];
  const speechMissing = speechRequired.filter((t) => !tpl.has(t));
  check('R14 语音事件全部已登记', speechMissing.length === 0, speechMissing.join(', '));
  // GH-12 的会话回合事件必须登记：未登记就写不进去，上下文续接在时间线上会毫无痕迹。
  check('conversation.turn_joined 已登记', tpl.has('conversation.turn_joined'));
  check('conversation.turn_reset 已登记', tpl.has('conversation.turn_reset'));
  const joinedFields = tpl.get('conversation.turn_joined')?.payload_fields ?? [];
  check(
    'turn_joined 只带 turn_id/index（不含对话正文）',
    joinedFields.length === 2 && joinedFields.includes('turn_id') && joinedFields.includes('index'),
    joinedFields.join(','),
  );
  const resetFields = tpl.get('conversation.turn_reset')?.payload_fields ?? [];
  check(
    'turn_reset 只带 reason',
    resetFields.length === 1 && resetFields.includes('reason'),
    resetFields.join(','),
  );
  check('每条模板都有 title', events.templates.every((t) => t.title));
  check('每条模板都有 summary', events.templates.every((t) => t.summary));

  // 恢复标志必须显式声明。`daemon.recovered` 名字里有 recovered，
  // 语义却是「上次没跑完」的告警——按名字猜会把它错标成「已恢复」。
  check('daemon.recovered 不是恢复事件', tpl.get('daemon.recovered')?.is_recovery === false);
  check('dependency.recovered 是恢复事件', tpl.get('dependency.recovered')?.is_recovery === true);
  check('store.recovered 是恢复事件', tpl.get('store.recovered')?.is_recovery === true);

  // 终结状态只有 `run.finished` 一条，五种结果靠 outcome 参数区分。
  // 注意 `run.cancelled` 是**取消这个动作**（用户点了取消），不是终态事件：
  // 终态仍然由随后的 run.finished(outcome=cancelled) 表达。两者不是一回事。
  const terminalByName = types.filter((t) => /^run\.(succeeded|failed|interrupted|outcome_unknown)$/.test(t));
  check('不存在按结果拆分的终态事件类型', terminalByName.length === 0, terminalByName.join(', '));
  check('run.finished 已登记', tpl.has('run.finished'));

  const finished = tpl.get('run.finished');
  // outcome_label 在 title 里（「任务{outcome_label}」），summary 是 {detail}。
  check('run.finished 用 outcome_label 表达结果', finished.title.includes('{outcome_label}'));
  check('run.finished 必填 outcome 字段', finished.required_fields.includes('outcome'));

  // GH-57：停止原因必须是结构化必填枚举，判据不得退化成中文 detail。
  const stopReq = tpl.get('safety.stop_requested');
  check('safety.stop_requested 已登记', Boolean(stopReq));
  check('safety.stop_requested 必填 cause', stopReq?.required_fields.includes('cause') === true);
  const aEventsSource = JSON.parse(
    fs.readFileSync(path.resolve(HERE, '..', '..', 'contracts', 'events.json'), 'utf8'),
  );
  const stopSource = aEventsSource.events.find((e) => e.type === 'safety.stop_requested');
  const requiredCauses = [
    'user_voice',
    'user_stop_api',
    'obstacle',
    'watchdog_timeout',
    'param_out_of_range',
    'observation_stale',
    'device_lost',
    'bridge_exit',
    'internal_error',
  ];
  check(
    'cause 枚举覆盖九种停止来源',
    requiredCauses.every((c) => stopSource?.payload?.cause?.enum?.includes(c)),
    JSON.stringify(stopSource?.payload?.cause?.enum),
  );
} finally {
  await runtime.close();
}

console.log('');
if (failed > 0) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');
