/**
 * RobotdClient.speak（GH-13）：每次播报现签一张一次性 robot_speak 凭据。
 *
 * 这里只验证**签发侧**：请求确实带 X-Wally-Approval，且 args_digest 覆盖当次 text、
 * 有效期是 30 秒。拒绝侧（缺凭据 / 摘要不符 / nonce 重放）由
 * `robotd/tests/contract/test_approval_gate.py` 用真 HTTP 服务器验证（#18）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RobotdClient } from '../../src/agentd/robotd-client.ts';
import { approvalArgsDigest } from '../../../contracts/tools/approval-digest.mjs';

const root = new URL('../../../work/agentd-speak-test', import.meta.url).pathname;
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'robot', 'agentd'), { recursive: true });
fs.writeFileSync(
  path.join(root, 'robot', 'agentd', 'approval-signing-key'),
  crypto.randomBytes(32).toString('hex'),
  'utf8',
);
process.env.WALLY_APP_DATA_DIR = root;

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  return new Response(JSON.stringify({ task_id: 'task-speak-1', status: 'accepted' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

const client = new RobotdClient({ baseUrl: 'http://127.0.0.1:9' });

console.log('— speak() 签发一次性凭据');
const accepted = await client.speak({ text: '  向前走了一步  ' });
check('返回 robotd 的 task_id', accepted.task_id === 'task-speak-1', accepted.task_id);
check('正文已修剪空白', accepted.text === '向前走了一步', accepted.text);
check('只发一次请求', calls.length === 1, String(calls.length));
check('请求打到 robot_speak 的操作路径', calls[0]?.url.endsWith('/v1/robot/speak'), calls[0]?.url);
check('方法为 POST', String(calls[0]?.init?.method).toUpperCase() === 'POST', calls[0]?.init?.method);

const headers = calls[0]?.init?.headers ?? {};
const header = headers['X-Wally-Approval'];
check('带 X-Wally-Approval', typeof header === 'string' && header.length > 0);

const body = JSON.parse(String(calls[0]?.init?.body ?? '{}'));
check('请求正文带 text', body.text === '向前走了一步', JSON.stringify(body));

if (typeof header === 'string') {
  const [payloadSegment] = header.split('.');
  const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  check('issuer 是 agentd', payload.issuer === 'agentd', payload.issuer);
  check('capability 是 robot_speak', payload.capability === 'robot_speak', payload.capability);
  check(
    'args_digest 覆盖当次 text',
    payload.args_digest === approvalArgsDigest({ text: '向前走了一步' }, ['text']),
    payload.args_digest,
  );
  check(
    '凭据有效期是 30 秒（不是 300 秒上限）',
    Date.parse(payload.expires_at) - Date.parse(payload.issued_at) === 30_000,
    `${payload.issued_at} → ${payload.expires_at}`,
  );
  check('nonce 存在（一次性）', typeof payload.nonce === 'string' && payload.nonce.length >= 8);
}

console.log('— 空文本不发请求');
const before = calls.length;
let code = null;
try {
  await client.speak({ text: '   ' });
} catch (e) {
  code = e.code;
}
check('空文本抛 E_VALIDATION', code === 'E_VALIDATION', code);
check('空文本没有发请求', calls.length === before, String(calls.length));

console.log('— GH-49：澄清追问走系统播报，不签发 robot_speak 凭据');
const beforeAnnounce = calls.length;
await client.announce({
  kind: 'clarification',
  reason: 'missing_arguments',
  action_label: '走到我这儿来',
  missing: ['target_track_id'],
  candidates: [],
  more: false,
});
check('只发一次播报请求', calls.length === beforeAnnounce + 1, String(calls.length - beforeAnnounce));
check('请求打到 robot_announce', calls.at(-1)?.url.endsWith('/v1/robot/announce'), calls.at(-1)?.url);
const announceBody = JSON.parse(String(calls.at(-1)?.init?.body ?? '{}'));
check('澄清 kind 正确', announceBody.kind === 'clarification', JSON.stringify(announceBody));
check('澄清带结构化 missing', announceBody.missing?.includes('target_track_id') === true, JSON.stringify(announceBody));
check('澄清不带自由文本 text', !('text' in announceBody), JSON.stringify(announceBody));
check('澄清不带审批 ID', !('approval_id' in announceBody), JSON.stringify(announceBody));
const announceHeaders = calls.at(-1)?.init?.headers ?? {};
check('澄清不走审批凭据', !('X-Wally-Approval' in announceHeaders), JSON.stringify(announceHeaders));

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
