#!/usr/bin/env node
// 校验「唯一契约」没有被绕过：
//   openapi.yaml + events.json 生成的 openapi.json / mcp-tools.json / robotd-types.ts / robotd-events.json
//   与仓库里的 generated/ 内容完全一致；并做一组不与生成物比较的**语义断言**。
// 用法：npm run contract:check
//
// 语义断言（防的是「生成一致但契约本身错了」）：
//   1. 公开操作里不得出现 debug/串口/硬件原语标签；estop 不得出现在 v1 公开面
//   2. 事件登记表不得登记 board.* 原始串口行
//   3. 状态快照必须带 event_seq；Task.state 必须含 accepted
//   4. servers 不得写 0.0.0.0（robotd 只绑回环）
//   5. 审批属性必须显式：物理动作要 true，stop 必须 false
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// agentd 响应体里「由实现自己构造」的类型必须从生成物派生，不许手抄。
// 放在模块顶层：3.5 段要查它们，末尾的成功信息也要报数量。
// 只列这三个——其余服务端内部行（*Row / *Options）不对应任何 schema，硬绑是噪声。
const AGENTD_TYPE_AUTHORS = [
  { file: 'overview.ts', name: 'HarnessInfo', schema: 'HarnessStatus' },
  { file: 'overview.ts', name: 'Issue', schema: 'Issue' },
  { file: 'events.ts', name: 'EventView', schema: 'EventView' },
];

// ---------------------------------------------------------------- 1. 生成物一致性
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-contracts-check-'));
const gen = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'generate.mjs')], {
  env: {
    ...process.env,
    CONTRACT_OPENAPI_YAML: path.join(ROOT, 'openapi.yaml'),
    CONTRACT_EVENTS_JSON: path.join(ROOT, 'events.json'),
    CONTRACT_OUT_DIR: TMP,
  },
  encoding: 'utf8',
});

if (gen.status !== 0) {
  console.error(gen.stderr || gen.stdout);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}

const files = ['openapi.json', 'mcp-tools.json', 'robotd-types.ts', 'robotd-events.json'];
let failed = false;
for (const file of files) {
  const want = fs.readFileSync(path.join(TMP, file), 'utf8');
  const target = path.join(ROOT, 'generated', file);
  if (!fs.existsSync(target)) {
    console.error(`FAIL generated/${file} 不存在；先跑 npm run contract:generate`);
    failed = true;
    continue;
  }
  const have = fs.readFileSync(target, 'utf8');
  if (want !== have) {
    console.error(`FAIL generated/${file} 与 openapi.yaml/events.json 生成结果不一致；先跑 npm run contract:generate`);
    failed = true;
  }
}

fs.rmSync(TMP, { recursive: true, force: true });

// ---------------------------------------------------------------- 2. 语义断言
const spec = parse(fs.readFileSync(path.join(ROOT, 'openapi.yaml'), 'utf8'));
const events = JSON.parse(fs.readFileSync(path.join(ROOT, 'events.json'), 'utf8'));
const semantic = [];

// 2.1 公开面不许有硬件原语 / estop
const BANNED_OPS = /estop|gpio|pin_|pwm|serial|ena_|motor_|drive_|raw_/i;
for (const [route, item] of Object.entries(spec.paths ?? {})) {
  for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
    const op = item[method];
    if (!op) continue;
    if ((op.tags ?? []).includes('debug')) continue;
    const id = op.operationId ?? '';
    if (BANNED_OPS.test(id)) semantic.push(`公开操作 ${id}（${method.toUpperCase()} ${route}）命中硬件原语/estop 黑名单`);
    if (route.includes('0.0.0.0')) semantic.push(`路由 ${route} 出现了 0.0.0.0`);
  }
}

// 2.2 事件登记表不许登记 board.* 原始串口行
for (const ev of events.events ?? []) {
  if (/^board\./.test(ev.type)) semantic.push(`events.json 登记了原始串口行事件 ${ev.type}（应留在 debug 旁路）`);
}

// 2.3 状态快照必须有 event_seq；Task.state 必须含 accepted
const stateReq = spec.components?.schemas?.RobotState?.required ?? [];
if (!stateReq.includes('event_seq')) semantic.push('RobotState.required 缺 event_seq（WS 游标无法建立）');
const taskStates = spec.components?.schemas?.TaskState?.enum ?? [];
for (const s of ['accepted', 'running', 'completed', 'failed', 'cancelled']) {
  if (!taskStates.includes(s)) semantic.push(`TaskState.enum 缺 ${s}`);
}

// 2.4 servers 只绑回环
for (const s of spec.servers ?? []) {
  if (/0\.0\.0\.0/.test(s.url ?? '')) semantic.push(`servers.url 含 0.0.0.0：${s.url}`);
}

// 2.4b OpenAPI 3.0 的 $ref sibling 限制
// 实测（2026-10-23）：给 `$ref` 加 `nullable` 会让 openapi-backend 判文档无效，
// 之后**所有路由都变成 404**——服务看起来在跑，接口却全不可用。这类错误必须在这里拦住。
function walkRefs(node, path) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkRefs(v, `${path}[${i}]`));
    return;
  }
  if (typeof node.$ref === 'string') {
    const extra = Object.keys(node).filter((k) => k !== '$ref' && k !== 'description' && k !== 'summary' && !k.startsWith('x-'));
    if (extra.length) {
      semantic.push(`${path} 在 $ref 旁边放了 ${extra.join(', ')}；OpenAPI 3.0 会忽略它们（应内联或用 allOf）`);
    }
  }
  for (const [k, v] of Object.entries(node)) walkRefs(v, `${path}/${k}`);
}
walkRefs(spec, '#');

// 2.4c 用真正的 openapi-backend 校验文档本身
if (!failed) {
  try {
    const { OpenAPIBackend } = await import('openapi-backend');
    const api = new OpenAPIBackend({ definition: spec, validate: true });
    await api.init();
  } catch (e) {
    semantic.push(`openapi-backend 校验文档失败：${e?.message ?? e}`);
  }
}

// 2.5 审批属性必须显式（物理动作不许靠 Agent 自觉）
const APPROVAL_REQUIRED = ['robot_follow', 'robot_speak', 'robot_calibration_set'];
for (const [, item] of Object.entries(spec.paths ?? {})) {
  for (const method of ['post', 'put']) {
    const op = item[method];
    if (!op) continue;
    if (APPROVAL_REQUIRED.includes(op.operationId) && op['x-requires-approval'] !== true) {
      semantic.push(`${op.operationId} 缺少 x-requires-approval: true`);
    }
    if (op.operationId === 'robot_stop' && op['x-requires-approval'] === true) {
      semantic.push('robot_stop 不应要求审批（安全旁路必须无审批可达）');
    }
  }
}

// 2.6 系统播报是审批链路的组成部分，不是 Agent 能力：
//     - 必须在契约里（不能靠「谁知道内部方法」区分）；
//     - 必须明确免审批；
//     - 必须被排除出 MCP 工具面，且工具面总数保持 14。
{
  const announce = spec.paths?.['/v1/robot/announce']?.post;
  if (!announce) {
    semantic.push('缺少 POST /v1/robot/announce（审批复述的系统播报路径）');
  } else {
    if (announce.operationId !== 'robot_announce') {
      semantic.push(`/v1/robot/announce 的 operationId 必须是 robot_announce，实际 ${announce.operationId}`);
    }
    if (announce['x-requires-approval'] === true) {
      semantic.push('robot_announce 不得要求审批：它就是审批复述路径，要求审批会递归');
    }
    if (announce['x-mcp-exclude'] !== true) {
      semantic.push('robot_announce 必须标 x-mcp-exclude: true（系统路径不是 Agent 工具）');
    }
  }
  const mcpPath = path.join(ROOT, 'generated', 'mcp-tools.json');
  if (fs.existsSync(mcpPath)) {
    const names = JSON.parse(fs.readFileSync(mcpPath, 'utf8')).map((t) => t.name);
    if (names.includes('robot_announce')) semantic.push('robot_announce 出现在 mcp-tools.json；系统路径不得成为 Agent 工具');
    if (names.length !== 14) semantic.push(`MCP 工具面应为 14 项，实际 ${names.length}`);
    const speak = JSON.parse(fs.readFileSync(mcpPath, 'utf8')).find((t) => t.name === 'robot_speak');
    if (!speak || speak.requiresApproval !== true) {
      semantic.push('robot_speak 仍必须是唯一带 requiresApproval 的发声工具');
    }
  }
}

// ---------------------------------------------------------------- 3. agentd 契约（ADR-0007 双契约门禁）
// agentd 的契约与生成物独立维护。这里只做「生成物一致 + 三条硬约束」，
// 不复用 robotd 的断言：两边的安全模型不同（agentd 没有模型工具面，反而有审批写入口禁令）。
// agentd 已独立成目录：契约在 <repo>/agentd/contracts/，不在 contracts/agentd/。
// ROOT 是 contracts/，所以只需向上一级到仓库根。
// 若这里指错，existsSync 判假会让整段 agentd 门禁**静默跳过**——门禁看起来通过，实际没跑。
const AGENTD_DIR = path.join(ROOT, '..', 'agentd', 'contracts');
if (!fs.existsSync(path.join(AGENTD_DIR, 'openapi.yaml'))) {
  semantic.push(`找不到 agentd 契约 ${AGENTD_DIR}/openapi.yaml；agentd 门禁不能跳过`);
}
const AGENTD_GEN = path.join(AGENTD_DIR, 'generated');
if (fs.existsSync(path.join(AGENTD_DIR, 'openapi.yaml'))) {
  const AGENTD_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agentd-contract-check-'));
  const agentdGen = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'generate-agentd.mjs')], {
    env: { ...process.env, AGENTD_OUT_DIR: AGENTD_TMP },
    encoding: 'utf8',
  });
  if (agentdGen.status !== 0) {
    console.error(agentdGen.stderr || agentdGen.stdout);
    semantic.push('agentd 契约生成失败（见上方输出）');
  } else {
    for (const file of ['openapi.json', 'api-endpoints.json', 'events.json', 'agentd-types.ts']) {
      const want = fs.readFileSync(path.join(AGENTD_TMP, file), 'utf8');
      const target = path.join(AGENTD_GEN, file);
      if (!fs.existsSync(target)) {
        semantic.push(`agentd/generated/${file} 不存在；先跑 npm run contract:agentd`);
      } else if (fs.readFileSync(target, 'utf8') !== want) {
        semantic.push(`agentd/generated/${file} 与手工编辑的契约不一致；先跑 npm run contract:agentd`);
      }
    }
  }
  fs.rmSync(AGENTD_TMP, { recursive: true, force: true });

  const aSpec = parse(fs.readFileSync(path.join(AGENTD_DIR, 'openapi.yaml'), 'utf8'));
  const aEvents = JSON.parse(fs.readFileSync(path.join(AGENTD_DIR, 'events.json'), 'utf8'));

  // 3.1 面板面不得出现审批写入口：正常界面没有「批准」按钮
  for (const [route, item] of Object.entries(aSpec.paths ?? {})) {
    const isApproval = route.startsWith('/api/approvals');
    for (const method of ['post', 'put', 'delete', 'patch']) {
      if (isApproval && item[method]) {
        semantic.push(`agentd 契约里 ${method.toUpperCase()} ${route} 是审批写入口；正常界面不允许批准`);
      }
    }
  }

  // 3.2 agentd 端点不得进入 robotd 的 MCP 工具面（两套生成物互不串门）
  const mcpTools = JSON.parse(fs.readFileSync(path.join(ROOT, 'generated', 'mcp-tools.json'), 'utf8'));
  const mcpNames = new Set(mcpTools.map((t) => t.name));
  for (const item of Object.values(aSpec.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'delete']) {
      const op = item[method];
      if (op?.operationId && mcpNames.has(op.operationId)) {
        semantic.push(`agentd 端点 ${op.operationId} 出现在 robotd 工具面里；面板面不得投影为模型工具`);
      }
    }
  }

  // 3.3 agentd 事件必须全部带确定性可读模板（模型离线也能读懂历史）
  for (const ev of aEvents.events ?? []) {
    if (!ev.title || !ev.summary) semantic.push(`agentd events.json: ${ev.type} 缺可读模板（title/summary）`);
    if (!['info', 'warning', 'error'].includes(ev.severity)) {
      semantic.push(`agentd events.json: ${ev.type} severity 不合法`);
    }
  }

  // 3.4 只绑回环
  for (const s of aSpec.servers ?? []) {
    if (!/127\.0\.0\.1|localhost|\[::1\]/.test(s.url ?? '')) {
      semantic.push(`agentd servers.url 必须回环：${s.url}`);
    }
  }

  // 3.5 实现类型必须跟生成物绑定（第三道门禁：tsc）
  //
  // 上方 3.1 只证明「生成物 == 契约」，证明不了「实现 == 契约」：
  // 实现里的类型若是一份手抄的镜像，契约加了字段它不会红。
  // 所以响应体里由实现构造的类型必须从 `components['schemas'][...]` 派生，由 tsc 来守。
  // 这里只负责确认这些绑定关系还活着——被删掉退回手写接口时给出明确提示，
  // 而不是等某天字段静默漂移。
  //
  // 注意：这里**不跑 tsc**。tsc 慢，且需要 agentd/node_modules；它由
  // `npm --prefix agentd test`（typecheck 是第一步）负责。契约门禁只验绑定存在。
  //
  // AUTHORS 覆盖的是「实现自己构造、直接进入响应体」的那几个。其余服务端内部行
  // （*Row、*Options 等）不进来——它们不对应任何 schema，硬绑反而是噪声。
  for (const a of AGENTD_TYPE_AUTHORS) {
    const srcPath = path.join(ROOT, '..', 'agentd', 'src', 'agentd', a.file);
    if (!fs.existsSync(srcPath)) {
      semantic.push(`找不到 ${srcPath}；agentd 类型绑定门禁不能跳过`);
      continue;
    }
    const src = fs.readFileSync(srcPath, 'utf8');
    // 允许 `Required<...>` / `Nullable<...>` 包裹，但名字与 schema 名必须对上
    const decl = new RegExp(
      `export type ${a.name}\\s*=\\s*[^;=]*components\\['schemas'\\]\\['${a.schema}'\\]`,
    );
    if (!decl.test(src)) {
      semantic.push(
        `agentd ${a.file} 的 ${a.name} 不再从 components['schemas']['${a.schema}'] 派生；` +
          '契约门禁失去第二道守卫（实现 == 契约），请恢复派生或改由 tsc 门禁覆盖',
      );
    }
  }

  // 派生必须靠 import 撑住，否则 `components` 是 any，正则能过而 tsc 白检
  const overviewPath = path.join(ROOT, '..', 'agentd', 'src', 'agentd', 'overview.ts');
  if (fs.existsSync(overviewPath)) {
    const overviewSrc = fs.readFileSync(overviewPath, 'utf8');
    if (!/from '\.\.\/\.\.\/contracts\/generated\/agentd-types\.ts'/.test(overviewSrc)) {
      semantic.push('agentd overview.ts 没有从 contracts/generated/agentd-types.ts 导入 components；绑定会退化成手抄');
    }
  }
}

for (const msg of semantic) console.error(`FAIL ${msg}`);
if (semantic.length) failed = true;

if (failed) process.exit(1);
console.log(
  `OK contract toolchain 校验通过（robotd ${files.length} 个生成物 + agentd 生成物 + 双契约语义断言 + agentd 类型派生链 ${AGENTD_TYPE_AUTHORS.length} 项）`,
);
