#!/usr/bin/env node
// 契约工具链生成器：openapi.yaml（+ events.json）是唯一来源。
// 生成：
//   generated/openapi.json       —— 给其它工具读的 JSON 视图
//   generated/mcp-tools.json     —— robot-mcp.ts 读取的 MCP 工具面
//   generated/robotd-types.ts    —— openapi-typescript 生成的 TS 类型
//   generated/robotd-events.json —— 事件登记表的校验+索引视图
// 生成物不要手改；改 openapi.yaml / events.json 后跑 `npm run contract:generate`。
//
// 降级行为（R03）：openapi-typescript 属 devDependency，目标机不一定装了 node_modules。
// 依赖缺失时**不静默跳过**，而是写出一个确定性说明文件（内容只依赖契约内容哈希），
// 保证「同一契约 → 同一生成物」，`npm run contract:check` 仍然可判定一致/不一致。
// 装了依赖时一律走权威路径，不写说明文件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const YAML = process.env.CONTRACT_OPENAPI_YAML ?? path.join(ROOT, 'openapi.yaml');
const EVENTS = process.env.CONTRACT_EVENTS_JSON ?? path.join(ROOT, 'events.json');
const OUT_DIR = process.env.CONTRACT_OUT_DIR ?? path.join(ROOT, 'generated');
const OPENAPI_JSON = path.join(OUT_DIR, 'openapi.json');
const MCP_TOOLS_JSON = path.join(OUT_DIR, 'mcp-tools.json');
const TYPES_TS = path.join(OUT_DIR, 'robotd-types.ts');
const EVENTS_OUT = path.join(OUT_DIR, 'robotd-events.json');
// 沙箱里 spawnSync 可能拿不到子进程的 stdout/stderr；测试用这个文件读诊断，
// 运行时照旧写到 stderr。
const DIAGNOSTICS = process.env.CONTRACT_DIAGNOSTICS_FILE ?? null;

function reportDiagnostics(lines) {
  if (!DIAGNOSTICS) return;
  fs.writeFileSync(DIAGNOSTICS, lines.map((line) => `${line}\n`).join(''));
}

const specText = fs.readFileSync(YAML, 'utf8');
const spec = parse(specText);
const eventsText = fs.readFileSync(EVENTS, 'utf8');
const events = JSON.parse(eventsText);

// ---------------------------------------------------------------- 事件登记表校验
// 这些检查是「契约门禁」的一部分：登记表与 OpenAPI 打架时必须让生成失败，而不是产出漂移。
const problems = [];

if (typeof events.version !== 'number') problems.push('events.json: 缺 version');
const wsEvent = spec.components?.schemas?.WsEvent;
if (!wsEvent) problems.push('openapi.yaml: 缺 components.schemas.WsEvent（事件封套）');
else if (events.envelope) {
  const want = [...(events.envelope.required ?? [])].sort().join(',');
  const have = [...(wsEvent.required ?? [])].sort().join(',');
  if (want !== have) problems.push(`events.json envelope.required 与 WsEvent.required 不一致：${want} vs ${have}`);
}

const seen = new Set();
const banned = new Set(events.envelope?.forbidden_payload_keys ?? []);
for (const ev of events.events ?? []) {
  if (!ev.type || typeof ev.type !== 'string') { problems.push('events.json: 有事件缺 type'); continue; }
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(ev.type)) problems.push(`events.json: 事件名不合规 ${ev.type}`);
  if (seen.has(ev.type)) problems.push(`events.json: 事件重复登记 ${ev.type}`);
  seen.add(ev.type);
  if (!ev.payload) { problems.push(`events.json: ${ev.type} 缺 payload 定义`); continue; }
  if (ev.payload.$ref) {
    if (!spec.components?.schemas?.[ev.payload.$ref]) {
      problems.push(`events.json: ${ev.type} 引用了不存在的 schema ${ev.payload.$ref}`);
    }
    continue;
  }
  for (const [field, def] of Object.entries(ev.payload)) {
    if (!def || typeof def !== 'object') { problems.push(`events.json: ${ev.type}.${field} 不是对象`); continue; }
    if (def.$ref && !spec.components?.schemas?.[def.$ref]) {
      problems.push(`events.json: ${ev.type}.${field} 引用了不存在的 schema ${def.$ref}`);
    }
    if (banned.has(field)) problems.push(`events.json: ${ev.type}.${field} 属于禁列字段（内部时间戳不得外泄）`);
  }
}

if (problems.length) {
  console.error('contract: event registry 校验失败');
  for (const p of problems) console.error(`  - ${p}`);
  reportDiagnostics(['FAIL contract: event registry 校验失败', ...problems.map((p) => `FAIL ${p}`)]);
  process.exit(1);
}

// ---------------------------------------------------------------- OpenAPI → MCP 工具面
const toolProblems = [];
const warnings = [];

/**
 * 解析 `x-requires-approval`。
 *
 * 唯一允许的新形态是对象 `{ params: [...] }`。旧布尔 `true` 仍然接受（视同
 * `{ params: [] }`），但会报 warning 要求迁移；本轮仓内三个端点必须全部是对象。
 * 返回 `null` 表示该操作不需要审批（生成物里就不出现 `approvalParams`）。
 */
function parseApproval(op) {
  const raw = op['x-requires-approval'];
  const id = op.operationId ?? '(无 operationId)';
  if (raw === undefined || raw === false) return null;
  if (raw === true) {
    warnings.push(
      `${id} 仍在使用 x-requires-approval: true；请迁移到 \`{ params: [...] }\`（本轮视同 params: []）`,
    );
    return { params: [] };
  }
  if (typeof raw !== 'object' || Array.isArray(raw) || raw === null) {
    toolProblems.push(`${id} 的 x-requires-approval 必须是对象 { params: [...] }，实际 ${JSON.stringify(raw)}`);
    return { params: [] };
  }
  const extra = Object.keys(raw).filter((key) => key !== 'params');
  if (extra.length) {
    toolProblems.push(`${id} 的 x-requires-approval 含未知键 ${extra.join(', ')}（只允许 params）`);
  }
  const params = raw.params;
  if (!Array.isArray(params) || params.some((p) => typeof p !== 'string' || !p)) {
    toolProblems.push(`${id} 的 x-requires-approval.params 必须是字符串数组（元素非空）`);
    return { params: [] };
  }
  if (new Set(params).size !== params.length) {
    toolProblems.push(`${id} 的 x-requires-approval.params 含重复字段`);
  }
  return { params: [...params] };
}

function lookupRef(ref) {
  const parts = ref.replace(/^#\//, '').split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  return parts.reduce((node, key) => node?.[key], spec);
}

function deref(node, seenRefs = new Set()) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((v) => deref(v, seenRefs));
  if (node.$ref) {
    if (seenRefs.has(node.$ref)) return {};
    seenRefs.add(node.$ref);
    return deref(lookupRef(node.$ref), seenRefs);
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = deref(v, seenRefs);
  return out;
}

function buildInputSchema(op) {
  const schema = { type: 'object', properties: {}, required: [], additionalProperties: false };
  for (const param of op.parameters ?? []) {
    if (param.in === 'path' && param.schema) {
      schema.properties[param.name] = deref(param.schema);
      schema.required.push(param.name);
    }
  }
  const body = op.requestBody?.content?.['application/json']?.schema;
  if (body) {
    const resolved = deref(body);
    if (resolved.type === 'object') {
      Object.assign(schema.properties, resolved.properties ?? {});
      for (const key of resolved.required ?? []) {
        if (!schema.required.includes(key)) schema.required.push(key);
      }
    } else {
      schema.properties.body = resolved;
    }
  }
  return schema;
}

const tools = [];
for (const [route, item] of Object.entries(spec.paths ?? {})) {
  for (const method of ['get', 'post', 'delete', 'put', 'patch']) {
    const op = item[method];
    if (!op) continue;
    // 系统路径（审批复述等）不是 Agent 可调用的能力：显式排除，而不是靠调用方自觉。
    if ((op.tags ?? []).includes('debug') || op['x-websocket'] || op['x-mcp-exclude'] === true) continue;
    const name = op.operationId ?? `${method}_${route.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
    const inputSchema = buildInputSchema(op);
    const approval = parseApproval(op);
    if (approval) {
      for (const param of approval.params) {
        if (!(param in (inputSchema.properties ?? {}))) {
          toolProblems.push(
            `${name} 的 approvalParams 字段 ${param} 不在该端点的 requestBody schema 里`,
          );
        }
      }
    }
    const tool = {
      name,
      description: [op.summary, op.description].filter(Boolean).join('\n'),
      inputSchema,
      operation: {
        method: method.toUpperCase(),
        path: route,
        pathParams: (op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name),
      },
    };
    // 只输出对象形态：approvalParams 存在即需审批；[] 表示需审批但不绑参数。
    // 不再输出 requiresApproval 布尔——一个字段说完整的事。
    if (approval) tool.approvalParams = approval.params;
    tools.push(tool);
  }
}

for (const warning of warnings) console.warn(`WARN contract: ${warning}`);

if (toolProblems.length) {
  console.error('contract: 审批参数声明校验失败');
  for (const problem of toolProblems) console.error(`  - ${problem}`);
  reportDiagnostics([
    ...warnings.map((w) => `WARN contract: ${w}`),
    'FAIL contract: 审批参数声明校验失败',
    ...toolProblems.map((p) => `FAIL ${p}`),
  ]);
  process.exit(1);
}
reportDiagnostics(warnings.map((w) => `WARN contract: ${w}`));

// ---------------------------------------------------------------- 事件登记表 → 索引视图
const eventIndex = {
  version: events.version,
  source: 'contracts/events.json',
  envelope: events.envelope,
  filter_semantics: events.filter_semantics,
  retention: events.retention,
  // 订阅白名单：每个类别的 prefix.* + 通配，供 WS hello 的 supported_event_types 使用
  supported_event_types: [
    ...new Set((events.events ?? []).map((e) => `${e.type.split('.')[0]}.*`)),
    '*',
  ].sort(),
  events: (events.events ?? []).map((e) => {
    const ref = e.payload?.$ref;
    const target = ref ? spec.components?.schemas?.[ref] : null;
    return {
      type: e.type,
      category: e.category,
      payload_ref: ref ?? null,
      payload_fields: target
        ? Object.keys(target.properties ?? {})
        : Object.keys(e.payload ?? {}),
      required_fields: target
        ? (target.required ?? [])
        : Object.entries(e.payload ?? {}).filter(([, d]) => d?.required).map(([k]) => k),
    };
  }),
  reserved_unimplemented: events.reserved_unimplemented ?? [],
  excluded_from_public: events.excluded_from_public ?? [],
};

// ---------------------------------------------------------------- 写文件
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OPENAPI_JSON, JSON.stringify(spec, null, 2) + '\n');
fs.writeFileSync(MCP_TOOLS_JSON, JSON.stringify(tools, null, 2) + '\n');
fs.writeFileSync(EVENTS_OUT, JSON.stringify(eventIndex, null, 2) + '\n');

const contractHash = crypto
  .createHash('sha256')
  .update(specText)
  .update('\n--events--\n')
  .update(eventsText)
  .digest('hex')
  .slice(0, 16);

let typesMode = 'authoritative';
try {
  const mod = await import('openapi-typescript');
  const openapiTS = mod.default;
  const { astToString } = mod;
  const ast = await openapiTS(JSON.parse(fs.readFileSync(OPENAPI_JSON, 'utf8')), {
    defaultNonNullable: false,
  });
  fs.writeFileSync(TYPES_TS, astToString(ast));
} catch (e) {
  // 降级：不产出半成品 TS，只写确定性说明，让 check 仍能判定一致。
  typesMode = 'degraded';
  const reason = (e?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find package/.test(String(e?.message)))
    ? 'openapi-typescript 未安装（缺少 node_modules）'
    : `openapi-typescript 生成失败：${e?.message ?? e}`;
  const body = [
    '// 本文件由 contracts/tools/generate.mjs 生成，请勿手改。',
    '//',
    '// 状态：降级（未生成 TS 类型）',
    `// 原因：${reason}`,
    '//',
    '// 恢复权威生成物：',
    '//   cd <repository-root> && npm ci && npm run contract:generate',
    '//',
    '// 降级期间契约仍由 openapi.json / mcp-tools.json / robotd-events.json 表达，',
    '// Python 实现以这些 JSON 为依据；TS 类型只服务于迁移期的旧 POC。',
    '',
    'export const CONTRACT_DEGRADED = true;',
    `export const CONTRACT_HASH = ${JSON.stringify(contractHash)};`,
    `export const CONTRACT_REASON = ${JSON.stringify(reason)};`,
    '',
  ].join('\n');
  fs.writeFileSync(TYPES_TS, body);
}

console.log(
  `generated ${tools.length} MCP tools + ${eventIndex.events.length} events`
  + ` + types(${typesMode}) -> ${path.relative(ROOT, OUT_DIR)}`,
);
