/**
 * 快速路由规则表 ↔ 能力契约的漂移断言（GH-8）。
 *
 * 为什么需要它：`FastRule.capability` 是对端公开**工具名**（`contracts/generated/mcp-tools.json`
 * 的 `name`）的硬编码。规则表和契约各自演进时，漂移只会在运行时 `resolve()` 才暴露
 * （「对端没有提供能力」，且是用户已经说出指令、run 已经建立之后）。
 * 这里把漂移提前到 CI：规则里的能力名和参数槽名必须都能在生成物里找到。
 *
 * 读生成物而不是 YAML：`npm run contract:check` 已证明生成物 == 契约源，
 * 本文件证明「规则表 == 生成物」，两者合起来才是完整链路。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FAST_RULES,
  MAX_FOLLOW_SPEED_MPS,
  MIN_FOLLOW_SPEED_MPS,
  DEFAULT_FOLLOW_SPEED_MPS,
  DEFAULT_MOVE_SPEED_MM_S,
  MIN_MOVE_MM,
  MAX_MOVE_MM,
  ruleTag,
} from '../../src/agentd/router.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.resolve(HERE, '..', '..', '..', 'contracts', 'generated', 'mcp-tools.json');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

if (!fs.existsSync(TOOLS)) {
  throw new Error(`缺生成物 ${TOOLS}；先跑 npm run contract:all`);
}
const tools = JSON.parse(fs.readFileSync(TOOLS, 'utf8'));
const byName = new Map(tools.map((t) => [t.name, t]));

console.log('— 规则表基本形状');
check('规则表非空', Array.isArray(FAST_RULES) && FAST_RULES.length > 0, String(FAST_RULES.length));
check(
  '规则 id 唯一且是 snake_case',
  new Set(FAST_RULES.map((r) => r.id)).size === FAST_RULES.length &&
    FAST_RULES.every((r) => /^[a-z][a-z0-9_]*$/.test(r.id)),
  FAST_RULES.map((r) => r.id).join(','),
);
check(
  '版本是正整数',
  FAST_RULES.every((r) => Number.isInteger(r.version) && r.version >= 1),
  FAST_RULES.map((r) => `${r.id}@${r.version}`).join(','),
);
check(
  '每条规则都有表达与说明',
  FAST_RULES.every((r) => Array.isArray(r.patterns) && r.patterns.length > 0 && r.patterns.every((p) => p instanceof RegExp) && r.summary.length > 0),
);
check(
  'ruleTag 与 id@version 一致',
  FAST_RULES.every((r) => ruleTag(r) === `${r.id}@${r.version}`),
);
check(
  '规则不携带审批字段（审批只从能力契约取）',
  FAST_RULES.every((r) => !Object.keys(r).some((k) => /approv/i.test(k))),
);

console.log('— 能力名必须出现在 mcp-tools.json（漂移即红）');
{
  const names = new Set(byName.keys());
  const missing = FAST_RULES.filter((r) => !names.has(r.capability)).map((r) => `${r.id} → ${r.capability}`);
  check('0 条能力名不在 mcp-tools.json 里', missing.length === 0, missing.join('; '));
  check(
    '规则用到的运动能力都已发布（robot_stop / robot_move / robot_follow）',
    names.has('robot_stop') && names.has('robot_move') && names.has('robot_follow'),
    [...names].join(','),
  );
}

console.log('— 参数槽必须是目标能力真实接受的参数');
{
  const problems = [];
  for (const rule of FAST_RULES) {
    const tool = byName.get(rule.capability);
    if (!tool) continue; // 上一节已报
    const props = new Set(Object.keys(tool.inputSchema?.properties ?? {}));
    for (const slot of rule.slots ?? []) {
      if (!props.has(slot.name)) problems.push(`${rule.id} → ${rule.capability}.${slot.name}`);
      // 槽靠捕获组取值：没有捕获组就永远抽不到参数（静默缺失比报错更糟）
      if (!(slot.pattern instanceof RegExp) || !slot.pattern.source.includes('(')) {
        problems.push(`${rule.id} → ${slot.name} 缺少捕获组`);
      }
    }
  }
  check('槽名都在能力的 inputSchema.properties 里', problems.length === 0, problems.join('; '));
}

console.log('— GH-12：slow_down 只映射已发布能力与真实参数');
{
  const slow = FAST_RULES.find((r) => r.id === 'slow_down');
  check('存在 slow_down', Boolean(slow));
  check('slow_down 映射 robot_follow', slow?.capability === 'robot_follow', slow?.capability);
  check(
    'slow_down 只在上一轮是 robot_follow 时参与匹配',
    slow?.requiresPreviousCapability === 'robot_follow',
    String(slow?.requiresPreviousCapability),
  );
  check('slow_down 从上下文派生参数', typeof slow?.contextArgs === 'function');
  const follow = byName.get('robot_follow');
  const props = new Set(Object.keys(follow?.inputSchema?.properties ?? {}));
  const derived = slow?.contextArgs?.({
    available: null,
    previous: { capability: 'robot_follow', args: { target_track_id: 'abc' } },
  });
  check(
    '派生参数都在 robot_follow 的 inputSchema 里',
    Object.keys(derived ?? {}).length > 0 && Object.keys(derived ?? {}).every((k) => props.has(k)),
    JSON.stringify(derived),
  );
  // 路由里的速度常量必须与契约默认值/边界一致，避免第二份真值悄悄漂移。
  const speed = follow?.inputSchema?.properties?.max_speed_mps ?? {};
  check('默认跟随速度与契约一致', DEFAULT_FOLLOW_SPEED_MPS === speed.default, `${DEFAULT_FOLLOW_SPEED_MPS} vs ${speed.default}`);
  check('速度下限与契约一致', MIN_FOLLOW_SPEED_MPS === speed.minimum, `${MIN_FOLLOW_SPEED_MPS} vs ${speed.minimum}`);
  check('速度上限与契约一致', MAX_FOLLOW_SPEED_MPS === speed.maximum, `${MAX_FOLLOW_SPEED_MPS} vs ${speed.maximum}`);
}

console.log('— GH-74：move_forward 只映射已发布的 robot_move，参数与安全边界同源');
{
  const move = FAST_RULES.find((r) => r.id === 'move_forward');
  check('存在 move_forward', Boolean(move));
  check('move_forward 映射 robot_move', move?.capability === 'robot_move', move?.capability);
  const tool = byName.get('robot_move');
  const props = new Set(Object.keys(tool?.inputSchema?.properties ?? {}));
  const derived = { ...(move?.contextArgs?.({ available: null }) ?? {}), distance_mm: 300 };
  check(
    '派生参数都在 robot_move 的 inputSchema 里',
    Object.keys(derived).every((k) => props.has(k)),
    JSON.stringify(derived),
  );
  const distance = tool?.inputSchema?.properties?.distance_mm ?? {};
  const speed = tool?.inputSchema?.properties?.speed_mm_s ?? {};
  check('距离下限与契约一致', MIN_MOVE_MM === distance.minimum, `${MIN_MOVE_MM} vs ${distance.minimum}`);
  check('距离上限与契约一致', MAX_MOVE_MM === distance.maximum, `${MAX_MOVE_MM} vs ${distance.maximum}`);
  check(
    '默认速度与契约一致',
    DEFAULT_MOVE_SPEED_MM_S === speed.default,
    `${DEFAULT_MOVE_SPEED_MM_S} vs ${speed.default}`,
  );
  check('robot_move 需要审批（物理动作）', 'approvalParams' in (tool ?? {}));
}

console.log('— 安全底线：受保护的停止规则仍在，且映射无审批的 robot_stop');
{
  const stop = FAST_RULES.find((r) => r.id === 'stop_robot');
  check('存在 stop_robot', Boolean(stop));
  check('stop_robot 受保护', stop?.protected === true);
  check('stop_robot 映射 robot_stop', stop?.capability === 'robot_stop', stop?.capability);
  // 与 service.ts 的判定同源：字段存在即需审批。
  const needsApproval = (tool) => tool != null && 'approvalParams' in tool;
  check('robot_stop 不需要审批（与契约一致）', !needsApproval(byName.get('robot_stop')));
}

console.log('');
if (failed > 0) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');
