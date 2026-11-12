#!/usr/bin/env node
// agentd 契约生成器（ADR-0007 的「独立契约 + 独立生成物」）。
//
// 与 robotd 的 contracts/tools/generate.mjs 刻意分开，理由不是「不想复用」而是职责不同：
//   - robotd 的生成物包含 **MCP 工具面**（能力 → 模型可调用的工具）。agentd 的端点
//     **一个都不能进工具面**：模型不该能读历史库、改模型配置或替你批准动作。
//   - agentd 的事件登记表带 **可读模板**，要生成「为什么这条事件可读」的索引。
//
// 产出到 agentd/contracts/generated/：
//   openapi.json        —— 给工具读的 JSON 视图
//   api-endpoints.json  —— 端点清单（供 UI 与冒烟脚本共享，避免两边各写一份路由）
//   events.json         —— 事件白名单 + 模板索引（运行时据此拒绝未登记类型）
//   agentd-types.ts     —— openapi-typescript 生成的 TS 类型（装了依赖时）
//
// 用法：npm run contract:agentd
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// agentd 的契约随 agentd 走：默认 <repo>/agentd/contracts/。
// 注意不是 contracts/agentd/（agentd 已独立成目录），写错会覆盖 robotd 的同名 events.json。
const CONTRACT_DIR = process.env.AGENTD_CONTRACT_DIR ?? path.resolve(HERE, '..', '..', 'agentd', 'contracts');
const OUT_DIR = process.env.AGENTD_OUT_DIR ?? path.join(CONTRACT_DIR, 'generated');
const SPEC_YAML = path.join(CONTRACT_DIR, 'openapi.yaml');
const EVENTS_JSON = path.join(CONTRACT_DIR, 'events.json');

const problems = [];

// ---------------------------------------------------------------- 读取
const specText = fs.readFileSync(SPEC_YAML, 'utf8');
const spec = parse(specText);
const eventsText = fs.readFileSync(EVENTS_JSON, 'utf8');
const events = JSON.parse(eventsText);

// ---------------------------------------------------------------- 契约形状校验
if (!spec.openapi) problems.push('openapi.yaml: 缺 openapi 版本');
if (!spec.info?.version) problems.push('openapi.yaml: 缺 info.version');
if (!Array.isArray(spec.servers) || spec.servers.length === 0) problems.push('openapi.yaml: 缺 servers');
for (const server of spec.servers ?? []) {
  if (!/127\.0\.0\.1|localhost|\[::1\]/.test(server.url)) {
    problems.push(`openapi.yaml: servers 必须是回环地址，实际 ${server.url}`);
  }
  if (server.url.includes('0.0.0.0')) problems.push('openapi.yaml: 不得出现 0.0.0.0');
}

// 端点清单：operationId 必须唯一；每个写操作都应声明可能返回的错误响应
const endpoints = [];
const seenOps = new Set();
const resolved = [];
for (const [route, item] of Object.entries(spec.paths ?? {})) {
  for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
    const op = item[method];
    if (!op) continue;
    if (!op.operationId) problems.push(`openapi.yaml: ${method.toUpperCase()} ${route} 缺 operationId`);
    if (seenOps.has(op.operationId)) problems.push(`openapi.yaml: operationId 重复 ${op.operationId}`);
    seenOps.add(op.operationId);
    resolved.push([method.toUpperCase(), route]);
    endpoints.push({
      method: method.toUpperCase(),
      path: route,
      operationId: op.operationId,
      tags: op.tags ?? [],
      summary: op.summary ?? '',
      websocket: op['x-websocket'] === true,
      mutating: method !== 'get',
    });
  }
}

// 硬约束 1：面板面不得出现「看起来是模型工具」的命名，也不该有 tools/call 之类的桥
for (const ep of endpoints) {
  if (/^mcp|^tool_|_tool$/.test(ep.operationId)) {
    problems.push(`openapi.yaml: ${ep.operationId} 看起来像模型工具；面板面不得投影为工具`);
  }
}

// 硬约束 2：审批只有 GET（正常界面没有批准写入口）
for (const ep of endpoints) {
  if (ep.path.startsWith('/api/approvals') && ep.mutating) {
    problems.push(`openapi.yaml: ${ep.method} ${ep.path} 是审批写入口，正常界面不允许有`);
  }
}

// ---------------------------------------------------------------- 事件登记表校验
if (typeof events.version !== 'number') problems.push('events.json: 缺 version');
const banned = new Set(events.envelope?.forbidden_payload_keys ?? []);
const seenTypes = new Set();
for (const ev of events.events ?? []) {
  if (!ev.type) {
    problems.push('events.json: 有事件缺 type');
    continue;
  }
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(ev.type)) {
    problems.push(`events.json: 事件名不合规 ${ev.type}`);
  }
  if (seenTypes.has(ev.type)) problems.push(`events.json: 事件重复登记 ${ev.type}`);
  seenTypes.add(ev.type);

  // 每条事件必须有确定性中文模板：这是「模型离线也能读懂历史」的实现前提。
  for (const field of ['title', 'summary']) {
    if (!ev[field] || typeof ev[field] !== 'string') {
      problems.push(`events.json: ${ev.type} 缺 ${field} 模板`);
    }
  }
  if (!['info', 'warning', 'error'].includes(ev.severity)) {
    problems.push(`events.json: ${ev.type} severity 不合法：${ev.severity}`);
  }
  if (!ev.payload) {
    problems.push(`events.json: ${ev.type} 缺 payload 定义`);
    continue;
  }
  for (const [field, def] of Object.entries(ev.payload)) {
    if (!def || typeof def !== 'object') {
      problems.push(`events.json: ${ev.type}.${field} 不是对象`);
      continue;
    }
    if (banned.has(field)) {
      problems.push(`events.json: ${ev.type}.${field} 属于禁列字段（思维链/凭证不得入库）`);
    }
  }

  // 频率上限必须是机器可读且完整的声明：max_hz 管住条数，key_field 指明按什么分组，
  // note 说明为什么降频。只写一句注释不算契约——运行时读的是生成物里的 rate_limit。
  if (ev.rate_limit !== undefined) {
    const rl = ev.rate_limit;
    if (!rl || typeof rl !== 'object' || Array.isArray(rl)) {
      problems.push(`events.json: ${ev.type}.rate_limit 必须是对象`);
    } else {
      if (!Number.isFinite(rl.max_hz) || rl.max_hz <= 0) {
        problems.push(`events.json: ${ev.type}.rate_limit.max_hz 必须是正数`);
      }
      if (!Number.isInteger(rl.window_ms) || rl.window_ms <= 0) {
        problems.push(`events.json: ${ev.type}.rate_limit.window_ms 必须是正整数`);
      }
      if (typeof rl.key_field !== 'string' || !rl.key_field || !(rl.key_field in ev.payload)) {
        problems.push(`events.json: ${ev.type}.rate_limit.key_field 必须指向 payload 里的字段`);
      }
      if (rl.excess !== 'drop') {
        problems.push(`events.json: ${ev.type}.rate_limit.excess 目前只允许 drop`);
      }
      if (typeof rl.note !== 'string' || !rl.note.trim()) {
        problems.push(`events.json: ${ev.type}.rate_limit.note 必须说明为什么降频`);
      }
    }
  }

  // 模板占位符必须能在 payload 里找到来源（或属于公认的上下文键）
  const contextKeys = new Set([
    'run_id', 'session_id', 'approval_id', 'event_id', 'cursor',
    'route_label', 'outcome_label', 'state_label', 'decision_label', 'action_label',
  ]);
  const placeholders = [...`${ev.title} ${ev.summary} ${ev.impact ?? ''} ${ev.advice ?? ''}`
    .matchAll(/\{([a-z0-9_]+)\}/g)].map((m) => m[1]);
  for (const ph of new Set(placeholders)) {
    if (!(ph in ev.payload) && !contextKeys.has(ph)) {
      problems.push(`events.json: ${ev.type} 模板占位符 {${ph}} 没有对应的 payload 字段或上下文键`);
    }
  }
}

// ---------------------------------------------------------------- 写生成物
fs.mkdirSync(OUT_DIR, { recursive: true });

const eventIndex = {
  version: events.version,
  source: 'agentd/contracts/events.json',
  envelope: events.envelope,
  retention: events.retention,
  severity_labels: events.severity_labels,
  // 运行时白名单：未登记的类型不得写进稳定接口
  registered_types: [...seenTypes].sort(),
  categories: [...new Set((events.events ?? []).map((e) => e.category))].sort(),
  // 可读模板索引：运行时用 payload 填充，不调用模型
  templates: (events.events ?? []).map((e) => ({
    type: e.type,
    category: e.category,
    severity: e.severity,
    title: e.title,
    summary: e.summary,
    impact: e.impact ?? null,
    advice: e.advice ?? null,
    // 「这是一条恢复事件」必须由登记表显式声明，不能按类型名猜：
    // daemon.recovered 名字里有 recovered，但语义是「启动时发现上次没跑完」，不是恢复。
    is_recovery: e.is_recovery ?? e.type.endsWith('.recovered'),
    payload_fields: Object.keys(e.payload ?? {}),
    required_fields: Object.entries(e.payload ?? {})
      .filter(([, d]) => d?.required)
      .map(([k]) => k),
    // 字段级契约与频率上限一并进生成物：运行时只读生成物，不回头解析契约源。
    payload_spec: e.payload ?? null,
    rate_limit: e.rate_limit ?? null,
  })),
  reserved_unimplemented: events.reserved_unimplemented ?? [],
};

if (problems.length) {
  console.error('contract:agentd 校验失败');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

fs.writeFileSync(path.join(OUT_DIR, 'openapi.json'), JSON.stringify(spec, null, 2) + '\n');
fs.writeFileSync(
  path.join(OUT_DIR, 'api-endpoints.json'),
  JSON.stringify(
    {
      $comment: '由 contracts/tools/generate-agentd.mjs 生成；UI 与冒烟脚本共用，避免各写一份路由。',
      contract_version: spec.info.version,
      endpoints,
    },
    null,
    2,
  ) + '\n',
);
fs.writeFileSync(path.join(OUT_DIR, 'events.json'), JSON.stringify(eventIndex, null, 2) + '\n');

const contractHash = crypto
  .createHash('sha256')
  .update(specText)
  .update('\n--events--\n')
  .update(eventsText)
  .digest('hex')
  .slice(0, 16);

const TYPES_TS = path.join(OUT_DIR, 'agentd-types.ts');
let typesMode = 'authoritative';
try {
  const mod = await import('openapi-typescript');
  const ast = await mod.default(JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'openapi.json'), 'utf8')), {
    defaultNonNullable: false,
  });
  fs.writeFileSync(TYPES_TS, mod.astToString(ast));
} catch (e) {
  typesMode = 'degraded';
  const reason =
    e?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find package/.test(String(e?.message))
      ? 'openapi-typescript 未安装（缺少 node_modules）'
      : `openapi-typescript 生成失败：${e?.message ?? e}`;
  fs.writeFileSync(
    TYPES_TS,
    [
      '// 本文件由 contracts/tools/generate-agentd.mjs 生成，请勿手改。',
      '//',
      '// 状态：降级（未生成 TS 类型）',
      `// 原因：${reason}`,
      '// 恢复：cd <repository-root> && npm ci && npm run contract:agentd',
      '',
      'export const CONTRACT_DEGRADED = true;',
      `export const CONTRACT_HASH = ${JSON.stringify(contractHash)};`,
      '',
    ].join('\n'),
  );
}

console.log(
  `generated agentd contract: ${endpoints.length} endpoints, ${seenTypes.size} event types, ` +
    `${Object.keys(spec.components?.schemas ?? {}).length} schemas, types(${typesMode}) -> ${path.relative(process.cwd(), OUT_DIR)}`,
);
