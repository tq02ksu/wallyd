// GH-85 契约实例测试：submitTask(move_distance) / ActionEpisode / TaskResult /
// motion.done / stop 确认语义。
//
// 与 `check.mjs` 的分工：check.mjs 断言「契约本身写得对」（schema、枚举、策略名字），
// 本文件用 openapi-backend 真正**校验实例**，再用契约里的策略拒掉伪造的物理完成。
// 只读契约与生成物，不建 HTTP 服务，离线可跑。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAPIBackend } from 'openapi-backend';
import { parse } from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const spec = parse(fs.readFileSync(path.join(ROOT, 'openapi.yaml'), 'utf8'));
const events = JSON.parse(fs.readFileSync(path.join(ROOT, 'events.json'), 'utf8'));

const api = new OpenAPIBackend({ definition: spec, validate: true });
await api.init();

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${name}`, e.message);
  }
}

const submitBody = (body) => api.validateRequest({ method: 'POST', path: '/v1/tasks', headers: {}, body });
const submitResponse = (body) => api.validateResponse(body, 'task_submit', 200);
const taskProjection = (result) => ({
  task_id: 't-1',
  capability: 'task_submit',
  state: 'completed',
  progress: 1,
  started_at: 1_700_000_000_000,
  cancelable: false,
  result,
});
const taskResponse = (body) => api.validateResponse(body, 'task_get', 200);

// 契约为 JSON Schema 3.0 表达不了的约束（x-nonzero / x-min-abs）提供可执行解释。
function distanceProblems(body) {
  const schema = spec.components.schemas.MoveDistanceRequest;
  const distance = body?.distance_m;
  if (typeof distance !== 'number') return ['distance_m 缺失或不是数字'];
  const problems = [];
  const d = schema.properties.distance_m;
  if (d['x-nonzero'] === true && distance === 0) problems.push('distance_m 不得为 0');
  if (typeof d['x-min-abs'] === 'number' && Math.abs(distance) < d['x-min-abs']) {
    problems.push(`|distance_m| 小于 ${d['x-min-abs']}`);
  }
  return problems;
}

// 执行 TaskResult.x-task-result-policy 里命名的三条 invariant。
function resultPolicyProblems(result) {
  const policy = spec.components.schemas.TaskResult['x-task-result-policy'];
  const problems = [];
  for (const invariant of policy.invariants) {
    if (invariant === 'goal_achieved_true_requires_sensor_verified') {
      if (result.goal_achieved === true && result.evidence !== policy.goal_achieved_true_requires.evidence) {
        problems.push('goal_achieved=true 但没有 sensor_verified 证据');
      }
    } else if (invariant === 'non_completed_lifecycle_requires_goal_achieved_null') {
      if (policy.goal_achieved_must_be_null_for.includes(result.lifecycle) && result.goal_achieved !== null) {
        problems.push(`${result.lifecycle} 的 goal_achieved 必须是 null`);
      }
    } else if (invariant === 'board_reported_is_not_goal_achieved') {
      if (result.evidence === 'board_reported' && result.goal_achieved === true) {
        problems.push('board_reported 不能支撑 goal_achieved=true');
      }
    } else {
      problems.push(`未知 invariant ${invariant}（测试没有实现它）`);
    }
  }
  return problems;
}

// 事件 payload 的严格校验：未声明字段也拒绝（motion/task 事件不允许夹带 goal_achieved）。
function payloadProblems(payloadSpec, payload) {
  const problems = [];
  for (const key of Object.keys(payload)) {
    if (!(key in payloadSpec)) problems.push(`未声明字段 ${key}`);
  }
  for (const [field, def] of Object.entries(payloadSpec)) {
    const value = payload[field];
    if (value === undefined) {
      if (def.required === true) problems.push(`${field} 必填但缺失`);
      continue;
    }
    if (def.type === 'string' && typeof value !== 'string') problems.push(`${field} 必须是 string`);
    if (def.type === 'integer' && !Number.isInteger(value)) problems.push(`${field} 必须是 integer`);
    if (def.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      problems.push(`${field} 必须是 number`);
    }
    if (Array.isArray(def.enum) && !def.enum.includes(value)) {
      problems.push(`${field}=${String(value)} 不在枚举 ${JSON.stringify(def.enum)}`);
    }
  }
  return problems;
}

const eventOf = (type) => events.events.find((e) => e.type === type);

console.log('— submitTask(move_distance) 请求');
check('distance_m=0.3, speed_mps=0.15 受理', () => {
  const r = submitBody({ action: 'move_distance', distance_m: 0.3, speed_mps: 0.15 });
  if (!r.valid) throw new Error(JSON.stringify(r.errors));
});
check('省略 speed_mps 时用默认值，请求合法', () => {
  const r = submitBody({ action: 'move_distance', distance_m: 0.3 });
  if (!r.valid) throw new Error(JSON.stringify(r.errors));
});
check('后退（负位移）合法', () => {
  const r = submitBody({ action: 'move_distance', distance_m: -0.2 });
  if (!r.valid) throw new Error(JSON.stringify(r.errors));
});
check('无单位的 distance 被拒', () => {
  const r = submitBody({ action: 'move_distance', distance: 0.3 });
  if (r.valid) throw new Error('unitless distance accepted');
});
check('缺 action 被拒', () => {
  const r = submitBody({ distance_m: 0.3 });
  if (r.valid) throw new Error('missing action accepted');
});
check('直接 robot_move 形态被拒（不是 action 枚举值）', () => {
  const r = submitBody({ action: 'robot_move', distance_m: 0.3 });
  if (r.valid) throw new Error('robot_move accepted');
});
check('speed_mps 超上限被拒', () => {
  const r = submitBody({ action: 'move_distance', distance_m: 0.3, speed_mps: 0.5 });
  if (r.valid) throw new Error('overspeed accepted');
});
check('distance_m 越界被拒', () => {
  const r = submitBody({ action: 'move_distance', distance_m: 1.0 });
  if (r.valid) throw new Error('out-of-range distance accepted');
});
check('distance_m=0 被 x-nonzero 拒', () => {
  if (distanceProblems({ distance_m: 0 }).length === 0) throw new Error('zero distance accepted');
});
check('|distance_m| < 0.05 被 x-min-abs 拒', () => {
  if (distanceProblems({ distance_m: 0.01 }).length === 0) throw new Error('too-small distance accepted');
});
check('|distance_m| = 0.05 合法', () => {
  if (distanceProblems({ distance_m: 0.05 }).length !== 0) throw new Error('min magnitude rejected');
});

console.log('— TaskHandle 只是引用');
check('{task_id} 是合法响应', () => {
  const r = submitResponse({ task_id: 'task-1' });
  if (!r.valid) throw new Error(JSON.stringify(r.errors));
});
check('响应塞 goal_achieved 被拒', () => {
  const r = submitResponse({ task_id: 'task-1', goal_achieved: true });
  if (r.valid) throw new Error('goal_achieved leaked into TaskHandle');
});
check('响应缺 task_id 被拒', () => {
  const r = submitResponse({ status: 'accepted' });
  if (r.valid) throw new Error('handle without task_id accepted');
});

console.log('— TaskResult：lifecycle / goal_achieved / evidence 分账');
check('现有查询投影（无 episode/result）仍然合法', () => {
  const base = {
    task_id: 't-0001',
    capability: 'task_submit',
    state: 'running',
    progress: 0.4,
    started_at: 1_700_000_000_000,
    cancelable: true,
    exclusivity: 'motion',
  };
  const r = taskResponse(base);
  if (!r.valid) throw new Error(JSON.stringify(r.errors));
});
check('开环完成：completed + null + board_reported 合法', () => {
  const r = taskResponse(taskProjection({ lifecycle: 'completed', goal_achieved: null, evidence: 'board_reported' }));
  if (!r.valid) throw new Error(JSON.stringify(r.errors));
});
check('传感器验证达成：completed + true + sensor_verified 合法', () => {
  const r = taskResponse(taskProjection({ lifecycle: 'completed', goal_achieved: true, evidence: 'sensor_verified' }));
  if (!r.valid) throw new Error(JSON.stringify(r.errors));
});
check('失败：failed + null + unknown 合法', () => {
  const r = taskResponse(taskProjection({ lifecycle: 'failed', goal_achieved: null, evidence: 'unknown' }));
  if (!r.valid) throw new Error(JSON.stringify(r.errors));
});
check('伪造物理完成：completed + true + board_reported 被拒', () => {
  const result = { lifecycle: 'completed', goal_achieved: true, evidence: 'board_reported' };
  const r = taskResponse(taskProjection(result));
  if (!r.valid && (r.errors ?? []).length) return; // schema 或策略任一拒绝都算
  if (resultPolicyProblems(result).length === 0) throw new Error('fabricated completion accepted');
});
check('failed 却写 goal_achieved=false 被策略拒', () => {
  const result = { lifecycle: 'failed', goal_achieved: false, evidence: 'sensor_verified' };
  if (resultPolicyProblems(result).length === 0) throw new Error('non-null goal on failed accepted');
});
check('错误状态 paused 被拒（不是合法 lifecycle）', () => {
  const r = taskResponse(taskProjection({ lifecycle: 'paused', goal_achieved: null, evidence: 'unknown' }));
  if (r.valid) throw new Error('paused accepted as TaskResult.lifecycle');
});
check('goal_achieved 字符串被拒', () => {
  const r = taskResponse(taskProjection({ lifecycle: 'completed', goal_achieved: 'yes', evidence: 'unknown' }));
  if (r.valid) throw new Error('string goal_achieved accepted');
});
check('evidence 拼写错误被拒', () => {
  const r = taskResponse(taskProjection({ lifecycle: 'completed', goal_achieved: null, evidence: 'board-reported' }));
  if (r.valid) throw new Error('unknown evidence accepted');
});

console.log('— motion.done / motion.aborted');
const doneSpec = eventOf('motion.done').payload;
const abortedSpec = eventOf('motion.aborted').payload;
const donePayload = { task_id: 't-1', episode_id: 'ep-1', action: 'move_distance', evidence: 'board_reported' };
check('合法 motion.done（只表达动作结束）', () => {
  const problems = payloadProblems(doneSpec, donePayload);
  if (problems.length) throw new Error(problems.join('; '));
});
check('motion.done 夹带 goal_achieved 被拒', () => {
  const problems = payloadProblems(doneSpec, { ...donePayload, goal_achieved: true });
  if (problems.length === 0) throw new Error('goal_achieved accepted in motion.done');
});
check('motion.done 冒充 sensor_verified 被拒', () => {
  const problems = payloadProblems(doneSpec, { ...donePayload, evidence: 'sensor_verified' });
  if (problems.length === 0) throw new Error('sensor_verified accepted in motion.done');
});
check('motion.done 缺 episode_id 被拒', () => {
  const { episode_id, ...rest } = donePayload;
  const problems = payloadProblems(doneSpec, rest);
  if (problems.length === 0) throw new Error('missing episode_id accepted');
});
check('motion.done 按策略最多得到 goal_achieved=null', () => {
  const policy = spec.components.schemas.TaskResult['x-task-result-policy'].motion_done_implies;
  if (policy.goal_achieved !== null) throw new Error('motion.done policy implies a goal verdict');
  const derived = { lifecycle: policy.lifecycle, goal_achieved: policy.goal_achieved, evidence: policy.evidence };
  if (resultPolicyProblems(derived).length) throw new Error('derived result violates policy');
  if (resultPolicyProblems({ ...derived, goal_achieved: true }).length === 0) {
    throw new Error('policy allows fabricating goal_achieved after motion.done');
  }
});
check('合法 motion.aborted', () => {
  const problems = payloadProblems(abortedSpec, {
    task_id: 't-1',
    episode_id: 'ep-1',
    action: 'move_distance',
    reason: 'stop',
    evidence: 'unknown',
  });
  if (problems.length) throw new Error(problems.join('; '));
});
check('motion.aborted 声明 sensor_verified 被拒', () => {
  const problems = payloadProblems(abortedSpec, {
    task_id: 't-1',
    episode_id: 'ep-1',
    action: 'move_distance',
    reason: 'stop',
    evidence: 'sensor_verified',
  });
  if (problems.length === 0) throw new Error('sensor_verified accepted in motion.aborted');
});
check('task.completed 夹带 goal_achieved 被拒', () => {
  const problems = payloadProblems(eventOf('task.completed').payload, {
    task_id: 't-1',
    capability: 'task_submit',
    goal_achieved: true,
  });
  if (problems.length === 0) throw new Error('goal_achieved accepted in task.completed');
});

console.log('— 无 id 串口 stop 不产生板侧确认');
const stopPolicy = events.stop_confirmation;
check('写成功最多是 requested', () => {
  if (stopPolicy.write_success_is !== 'requested') throw new Error('write success is not requested');
});
check('无 id 的 stop 上限是 unknown', () => {
  if (stopPolicy.unaddressed_stop.request_has_id !== false) throw new Error('unaddressed stop claims an id');
  if (stopPolicy.unaddressed_stop.max_state !== 'unknown') throw new Error('unaddressed stop can reach confirmed');
});
check('确认必须有匹配 request id 的板侧应答', () => {
  if (stopPolicy.confirmed_requires !== 'board_stop_reply_with_matching_request_id') {
    throw new Error('confirmed does not require a matching board reply');
  }
});
check('allowed stop states 推导：无 id 永远不含 confirmed', () => {
  const unaddressed = stopPolicy.unaddressed_stop.allowed_states;
  if (unaddressed.includes('confirmed')) throw new Error('unaddressed stop allows confirmed');
  if (!stopPolicy.states.includes('confirmed')) throw new Error('addressed stop cannot be confirmed');
});

console.log('— 不新增 Codex 设备原语 / robot_move 工具');
check('mcp-tools.json 不含 task_submit / robot_move / move_distance', () => {
  const tools = JSON.parse(fs.readFileSync(path.join(ROOT, 'generated', 'mcp-tools.json'), 'utf8'));
  const bad = tools.map((t) => t.name).filter((n) => /task_submit|robot_move|move_distance/.test(n));
  if (bad.length) throw new Error(`unexpected tools: ${bad.join(', ')}`);
});
check('公开操作里没有 robot_move', () => {
  const ops = Object.values(spec.paths ?? {}).flatMap((item) =>
    ['get', 'post', 'put', 'delete', 'patch'].map((m) => item[m]?.operationId).filter(Boolean),
  );
  if (ops.includes('robot_move')) throw new Error('robot_move is declared');
});

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log('task/action contract checks passed');
