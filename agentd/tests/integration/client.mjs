/**
 * 手验：RobotdClient 对真实 sim robotd 的行为。
 * 需要先起 robotd serve --sim --http <port>。
 */
import { RobotdClient, RobotdCallError } from '../../src/agentd/robotd-client.ts';

// 默认必须是 robotd 的端口（8787）；8791 是 agentd 的端口，指错了会连到 agentd 自己。
const baseUrl = process.env.ROBOTD_URL ?? 'http://127.0.0.1:8787';
const client = new RobotdClient({ baseUrl, timeoutMs: 4000 });

let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

const health = await client.health();
console.log('health:', JSON.stringify(health));
check('health.ok', health.ok === true);
check('health.instance_id', typeof health.instance_id === 'string' && health.instance_id.length > 0);
check('health.observed_at', typeof health.observed_at === 'string');

const { state, observed_at } = await client.state();
console.log('state:', JSON.stringify(state));
check('state.robot_id', typeof state.robot_id === 'string');
check('state.transport', typeof state.transport === 'string');
check('state.battery 不造数', state.battery === null || state.battery.percent === null || typeof state.battery.percent === 'number');
check('state.observed_at', typeof observed_at === 'string');

const tools = await client.discoverCapabilities(health.instance_id);
console.log(`capabilities: ${tools.length} 个`);
check('capabilities 非空', tools.length > 0);
check('每个工具都有 operation', tools.every((t) => t.operation && t.operation.method && t.operation.path));
const stopTool = tools.find((t) => t.name === 'robot_stop');
check('robot_stop 存在', Boolean(stopTool));

// 停止：安全旁路
const stopRes = await client.stop('clienttest');
console.log('stop:', JSON.stringify(stopRes));
check('stop.ok', stopRes.ok === true);
check('stop.board_ack 是布尔或 null', typeof stopRes.board_ack === 'boolean' || stopRes.board_ack === null);
check('stop.at 是数字', typeof stopRes.at === 'number');
const stopAgain = await client.stop('clienttest');
check('stop 幂等', stopAgain.ok === true);

// 任务列表
const tasks = await client.listTasks();
check('listTasks 返回数组', Array.isArray(tasks));

// 能力调用：follow 需要 agentd 签发的一次性授权凭据（GH-18）。
// 这个客户端不带凭据，所以必须在 robotd 侧被 403/E_APPROVAL 拦下——
// 不能再像以前那样直接落到「未实现 → E_UNAVAILABLE」。
try {
  await client.callCapability('robot_follow', { target: '穿红衣服的人' });
  check('robot_follow 无凭据必须被拒绝', false);
} catch (e) {
  check('robot_follow 抛 RobotdCallError', e instanceof RobotdCallError, String(e));
  check('robot_follow 无凭据为 E_APPROVAL/403', e.code === 'E_APPROVAL' && e.httpStatus === 403, `${e.code} ${e.httpStatus}`);
  console.log(`       code=${e.code} http=${e.httpStatus} msg=${e.message}`);
}

// 未知能力：直接拒绝，不试探
try {
  await client.callCapability('definitely_not_a_real_tool', {});
  check('未知能力应被拒绝', false);
} catch (e) {
  check('未知能力被拒绝', e instanceof RobotdCallError && e.code === 'E_NOT_FOUND', String(e));
}

// 不可达
const dead = new RobotdClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 800 });
try {
  await dead.health();
  check('不可达应抛错', false);
} catch (e) {
  check('不可达抛 E_UNREACHABLE/E_TIMEOUT', e instanceof RobotdCallError && e.unreachable, String(e));
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
