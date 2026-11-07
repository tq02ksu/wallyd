/**
 * GH-11 判据 1 的执行半段（无需网络）：签发凭据 → tool_call → 调用能力 → succeeded。
 *
 * 为什么单独测：这条路径是「批准 → 真的执行」的最后一跳。HTTP 级验收要用回环 bind，
 * 在受限沙箱里跑不了；这里用替身 robotd 把凭据头、tool_calls 关联与失败收尾钉住。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../../src/agentd/store.ts';
import { EventLog, loadRegistry } from '../../src/agentd/events.ts';
import { RunService } from '../../src/agentd/runs.ts';
import { executeApprovedCapability } from '../../src/agentd/approval-executor.ts';
import { ensureApprovalSigningKey } from '../../src/agentd/approval-key.ts';
import { approvalSecretPath } from '../../src/agentd/paths.ts';
import { approvalArgsDigest } from '../../../contracts/tools/approval-digest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const root = path.join(REPO, 'work', 'agentd-test', `approval-executor-${process.pid}`);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
process.env.WALLY_APP_DATA_DIR = path.join(root, 'appdata');
ensureApprovalSigningKey();

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

const FOLLOW = {
  name: 'robot_follow',
  description: '跟随目标',
  inputSchema: {},
  approvalParams: ['target_track_id', 'target'],
  operation: { method: 'POST', path: '/v1/robot/follow', pathParams: [] },
};

class FakeRobotd {
  constructor() {
    this.capabilities = { current: [FOLLOW] };
    this.calls = [];
    this.fail = null;
  }
  async discoverCapabilities() {
    return this.capabilities.current;
  }
  async callCapability(name, args, opts) {
    this.calls.push({ name, args, opts });
    if (this.fail) throw this.fail;
    return { body: { ok: true }, robot_task_id: 'robot-task-1' };
  }
}

const store = new Store(path.join(root, 'agentd.sqlite'), { log: () => {} });
const events = new EventLog(store, loadRegistry(), 'boot-approval-executor');
const runs = new RunService({ store, events, log: () => {} });
const robotd = new FakeRobotd();
const deps = { runs, robotd, store, log: () => {} };

function approvedRun() {
  const run = runs.submitRun({ prompt: '过来 track:abc', route: 'fast' });
  runs.transition(run.run_id, 'executing');
  const a = runs.createApproval({
    runId: run.run_id,
    capability: 'robot_follow',
    actionLabel: '跟随我',
    argsSummary: '{"target_track_id":"abc"}',
    argsJson: '{"target_track_id":"abc"}',
  });
  store.transaction((tx) => {
    tx.run(
      "UPDATE approvals SET status = 'approved', decided_by = 'voice', decided_at = ? WHERE approval_id = ?",
      new Date().toISOString(),
      a.approval_id,
    );
  });
  return { runId: run.run_id, approvalId: a.approval_id };
}

function runOf(id) {
  return store.one('SELECT * FROM runs WHERE run_id = ?', id);
}
function lastCall(runId) {
  return store.one('SELECT * FROM tool_calls WHERE run_id = ? ORDER BY rowid DESC LIMIT 1', runId);
}

console.log('— 判据 1：批准后执行，凭据绑定参数，tool_calls 关联 approval_id');
{
  const { runId, approvalId } = approvedRun();
  await executeApprovedCapability(deps, {
    approvalId,
    runId,
    capability: 'robot_follow',
    args: { target_track_id: 'abc' },
    actionLabel: '跟随我',
  });

  check('run succeeded', runOf(runId).status === 'succeeded', runOf(runId).status);
  check('调用的是被批准的能力', robotd.calls.length === 1 && robotd.calls[0].name === 'robot_follow');
  check('复述路径没有 robot_speak', !robotd.calls.some((c) => c.name === 'robot_speak'));

  const call = lastCall(runId);
  check('tool_call 成功', call?.state === 'succeeded', call?.state);
  check('tool_call requires_approval', call?.requires_approval === 1);
  check('tool_call 关联 approval_id', call?.approval_id === approvalId, call?.approval_id);

  const header = robotd.calls[0].opts?.approvalHeader;
  check('带 X-Wally-Approval', typeof header === 'string' && header.includes('.'), String(header));
  const [payloadSeg, sig] = String(header).split('.');
  const payload = JSON.parse(Buffer.from(payloadSeg, 'base64url').toString('utf8'));
  check('凭据 capability 对齐', payload.capability === 'robot_follow');
  check(
    '凭据 args_digest 走契约规范化',
    payload.args_digest === approvalArgsDigest({ target_track_id: 'abc' }, ['target_track_id', 'target']),
  );
  const secret = Buffer.from(fs.readFileSync(approvalSecretPath(), 'utf8').trim(), 'hex');
  const expected = crypto.createHmac('sha256', secret).update(payloadSeg, 'ascii').digest('base64url');
  check('凭据 HMAC 可验', sig === expected);

  const approval = store.one('SELECT * FROM approvals WHERE approval_id = ?', approvalId);
  check('记录了授权摘要', typeof approval?.authorization_json === 'string' && approval.authorization_json.includes('args_digest'));
  check('授权标记已消费', approval?.authorization_consumed === 1);
}

console.log('— robotd 拒绝：run failed，tool_call 也 failed');
{
  const { runId, approvalId } = approvedRun();
  const err = Object.assign(new Error('该能力需要一次性授权'), { code: 'E_APPROVAL' });
  robotd.fail = err;
  await executeApprovedCapability(deps, {
    approvalId,
    runId,
    capability: 'robot_follow',
    args: { target_track_id: 'abc' },
    actionLabel: '跟随我',
  });
  robotd.fail = null;
  check('run failed', runOf(runId).status === 'failed', runOf(runId).status);
  const call = lastCall(runId);
  check('tool_call failed', call?.state === 'failed', call?.state);
  check('tool_call 记 error_code', call?.error_code === 'E_APPROVAL', call?.error_code);
}

console.log('— 能力不存在：不调用 robotd，run failed');
{
  const { runId, approvalId } = approvedRun();
  const before = robotd.calls.length;
  robotd.capabilities.current = [];
  await executeApprovedCapability(deps, {
    approvalId,
    runId,
    capability: 'robot_follow',
    args: { target_track_id: 'abc' },
    actionLabel: '跟随我',
  });
  robotd.capabilities.current = [FOLLOW];
  check('run failed', runOf(runId).status === 'failed');
  check('没有调用 robotd', robotd.calls.length === before);
}

console.log('— 秘密缺失：签发失败 → fail closed，不调用 robotd');
{
  const { runId, approvalId } = approvedRun();
  const before = robotd.calls.length;
  const keyFile = approvalSecretPath();
  fs.rmSync(keyFile, { force: true });
  await executeApprovedCapability(deps, {
    approvalId,
    runId,
    capability: 'robot_follow',
    args: { target_track_id: 'abc' },
    actionLabel: '跟随我',
  });
  ensureApprovalSigningKey();
  check('run failed', runOf(runId).status === 'failed');
  check('没有调用 robotd', robotd.calls.length === before);
  check('没有留下 tool_call', !lastCall(runId));
}

runs.dispose();
store.close();
fs.rmSync(root, { recursive: true, force: true });
delete process.env.WALLY_APP_DATA_DIR;
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
