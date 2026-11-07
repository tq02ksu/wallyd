/**
 * GH-22 的 agentd 侧守卫：
 * 1. 能力面读取的是 approvalParams（存在即需审批），不再有 requiresApproval 布尔；
 * 2. TS 侧摘要实现与契约规则一致，且与 Python 侧固定向量逐字节相等。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  approvalArgsDigest,
  canonicalApprovalArgs,
  loadRules,
} from '../../../contracts/tools/approval-digest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const tools = JSON.parse(
  fs.readFileSync(path.join(REPO, 'contracts', 'generated', 'mcp-tools.json'), 'utf8'),
);

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

console.log('— 生成物：approvalParams 是唯一审批字段');
check('没有 requiresApproval 布尔字段', tools.every((t) => !('requiresApproval' in t)));
const approvalTools = new Set(tools.filter((t) => 'approvalParams' in t).map((t) => t.name));
check(
  '只有三个端点带 approvalParams',
  JSON.stringify([...approvalTools].sort()) === JSON.stringify(['robot_calibration_set', 'robot_follow', 'robot_speak']),
  JSON.stringify([...approvalTools]),
);
const speak = tools.find((t) => t.name === 'robot_speak');
check('robot_speak.approvalParams 含 text', Array.isArray(speak?.approvalParams) && speak.approvalParams.includes('text'));
const stop = tools.find((t) => t.name === 'robot_stop');
check('robot_stop 无 approvalParams（存在即需审批）', stop && !('approvalParams' in stop));

console.log('— 摘要规范化');
check(
  '固定向量与 Python 侧一致',
  approvalArgsDigest({ text: '前进 2 米' }, ['text']) ===
    'sha256:4df086c2a2eb87c717aeef50ae04a5e4172381ed71d7ab2b78bb397a3f986c06',
);
check('未声明字段被排除', approvalArgsDigest({ text: 'x', voice: 'y' }, ['text']) === approvalArgsDigest({ text: 'x' }, ['text']));
check('缺失按 null 参与', approvalArgsDigest({}, ['text']) === approvalArgsDigest({ text: null }, ['text']));
check('字符串不 trim', approvalArgsDigest({ text: ' x' }, ['text']) !== approvalArgsDigest({ text: 'x' }, ['text']));
check('数字 2.0 输出 2', canonicalApprovalArgs({ n: 2.0 }, ['n']) === '{"n":2}');
{
  let threw = false;
  try {
    approvalArgsDigest({ text: 'x' }, ['text'], { ...loadRules(), missing_fields: 'omit' });
  } catch {
    threw = true;
  }
  check('规则文件是唯一真值：未知取值抛错', threw);
}

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log('approval digest checks passed');
