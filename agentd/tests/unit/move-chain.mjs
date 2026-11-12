/**
 * GH-74 判据 2 的 agentd 半段：「往前走 30 厘米」→ 快速规则 → robot_move 参数 → HTTP 请求体。
 *
 * 全程离线，不 bind 端口：
 * - 路由与执行入口用真的 `submitRunRequest`；
 * - HTTP 体用真的 `RobotdClient.callCapability`，只替换它的网络 `request`（记录 method/route/body）。
 * 串口侧字节由 `robotd/tests/unit/test_serial_board.py` 断言；两段合起来就是完整链路，
 * 进程边界两侧各自断言，不把「HTTP 体正确」冒充成「真的写了串口」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { submitRunRequest } from '../../src/agentd/run-request.ts';
import { RobotdClient } from '../../src/agentd/robotd-client.ts';
import { formatArgsSummary } from '../../../contracts/tools/announce-lexicon.mjs';

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

/** 与键顺序无关的对象比较：参数形状不靠插入顺序。 */
function sameJson(a, b) {
  const norm = (v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v)
          .sort()
          .map((k) => [k, norm(v[k])])
      : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

const tools = JSON.parse(fs.readFileSync(TOOLS, 'utf8'));
const available = new Set(['robot_stop', 'robot_move', 'robot_follow']);

function harness() {
  const fast = [];
  const slow = [];
  const clarifications = [];
  const runs = {
    activeRun: () => null,
    submitRun: (input) => ({
      run_id: 'run-1',
      status: 'accepted',
      route: input.route,
      fast_rule: input.fast_rule,
      created_at: '2026-01-01T00:00:00.000Z',
      duplicate: false,
    }),
    recordClarification: () => '2026-01-01T00:00:00.000Z',
    recordClarificationClosed: () => '2026-01-01T00:00:00.000Z',
  };
  return {
    fast,
    slow,
    clarifications,
    deps: {
      runs,
      availableCapabilities: () => available,
      executeFast: (runId, capability, args) => fast.push({ runId, capability, args }),
      executeHarness: (runId) => slow.push(runId),
      announceClarification: (a) => clarifications.push(a),
    },
  };
}

console.log('— 判据 2：句子 → 快速规则（不进 Harness）');
{
  const h = harness();
  const res = submitRunRequest(h.deps, { prompt: '往前走 30 厘米', source: 'asr' });
  check('route=fast', res.route === 'fast', res.route);
  check('命中 move_forward@1', res.fast_rule === 'move_forward@1', res.fast_rule);
  check('没有交给 Harness', h.slow.length === 0, JSON.stringify(h.slow));
  check('分别下发一次', h.fast.length === 1, JSON.stringify(h.fast));
  check(
    '下发的能力与参数',
    h.fast[0]?.capability === 'robot_move' &&
      sameJson(h.fast[0]?.args, { distance_mm: 300, speed_mm_s: 150 }),
    JSON.stringify(h.fast[0]),
  );
}

console.log('— 判据 2：参数 → robotd HTTP 请求体（真的 Client，只替换网络）');
{
  const args = { distance_mm: 300, speed_mm_s: 150 };
  const client = new RobotdClient({ baseUrl: 'http://127.0.0.1:9' });
  client.capabilities.store(tools, null);
  let captured = null;
  client.request = async (method, route, body) => {
    captured = { method, route, body };
    return { ok: true, dispatched: true };
  };
  await client.callCapability('robot_move', args);
  check('method/path 来自契约', captured?.method === 'POST' && captured?.route === '/v1/robot/move', JSON.stringify(captured));
  check(
    '请求体只含契约参数',
    sameJson(captured?.body, { distance_mm: 300, speed_mm_s: 150 }),
    JSON.stringify(captured?.body),
  );
}

console.log('— 审批复述：新增字段必须在词表里，且读法确定');
{
  const tool = tools.find((t) => t.name === 'robot_move');
  const summary = formatArgsSummary({ distance_mm: 300, speed_mm_s: 150 }, tool.approvalParams);
  check('复述含距离与速度', summary === '距离三百毫米，速度一百五十毫米每秒', summary);
}

console.log('— 反例：越界 → 澄清；没距离 → Harness');
{
  const h = harness();
  const res = submitRunRequest(h.deps, { prompt: '往前走 9 米', source: 'asr' });
  check('越界澄清', res.route === 'clarified', res.route);
  check('越界不执行', h.fast.length === 0, JSON.stringify(h.fast));

  const h2 = harness();
  submitRunRequest(h2.deps, { prompt: '往前走', source: 'asr' });
  check('没距离 → Harness', h2.slow.length === 1 && h2.fast.length === 0, JSON.stringify(h2));
}

console.log('');
if (failed > 0) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');
