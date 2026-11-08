/**
 * GH-11 状态机核心（不需要网络）：播报完成 → 开窗 → 语音 settle → 裁决/忽略/过期。
 *
 * 与 `approval-settle.mjs` 的分工：
 * - 本文件覆盖 run/approval 状态机与规则 6（窗口、回声、before_window）；
 * - `approval-settle.mjs` 起真实 HTTP，覆盖服务装配、凭据头与只读审批面（CI 运行）。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../../src/agentd/store.ts';
import { EventLog, loadRegistry } from '../../src/agentd/events.ts';
import { RunService } from '../../src/agentd/runs.ts';
import { ApprovalAnnouncer } from '../../src/agentd/approval-announcer.ts';
import { RobotdEventBridge } from '../../src/agentd/robotd-event-bridge.ts';
import { mintApprovalCredential } from '../../src/agentd/approval-credential.ts';
import { ensureApprovalSigningKey } from '../../src/agentd/approval-key.ts';
import { approvalSecretPath } from '../../src/agentd/paths.ts';
import { approvalArgsDigest } from '../../../contracts/tools/approval-digest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const root = path.join(REPO, 'work', 'agentd-test', `approval-core-${process.pid}`);
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

class FakeRobotd {
  constructor() {
    this.announces = [];
    this.capabilityCalls = [];
  }
  async announce(input) {
    this.announces.push(input);
    return {
      task_id: `ann-${this.announces.length}`,
      status: 'accepted',
      approval_id: input.approval_id,
      kind: input.kind,
      text: `请确认：${input.action_label}。确认请说“确认”。`,
    };
  }
  async callCapability(name) {
    this.capabilityCalls.push(name);
    return { body: {}, robot_task_id: 'task-1' };
  }
}

const store = new Store(path.join(root, 'agentd.sqlite'), { log: () => {} });
const events = new EventLog(store, loadRegistry(), 'boot-approval-core');
const runs = new RunService({ store, events, log: () => {} });
const robotd = new FakeRobotd();
const announcer = new ApprovalAnnouncer({ runs, robotd, log: () => {}, windowMs: 60_000 });
const settled = [];
const bridge = new RobotdEventBridge({
  events,
  store,
  hooks: {
    onAnnouncementFinished: (outcome) => announcer.onFinished(outcome),
    onUtteranceHeard: (input) => {
      const latest = runs.latestApprovalForVoice();
      if (!latest) return;
      settled.push(
        runs.settleApproval({
          approvalId: latest.approval_id,
          text: input.text,
          utteranceId: input.utterance_id,
          startedAt: input.started_at ?? null,
          echo: input.echo,
        }),
      );
    },
  },
});

let seq = 0;
function feed(type, payload, timestamp = new Date().toISOString()) {
  seq += 1;
  bridge.handle({ version: 1, type, event_id: `core-${seq}`, seq, timestamp, payload });
}

function countEvents(type, approvalId) {
  return store.one(
    'SELECT COUNT(*) AS n FROM events WHERE type = ? AND approval_id = ?',
    type,
    approvalId,
  ).n;
}
function lastParams(type, approvalId) {
  const row = store.one(
    'SELECT params_json FROM events WHERE type = ? AND approval_id = ? ORDER BY seq DESC LIMIT 1',
    type,
    approvalId,
  );
  return row ? JSON.parse(row.params_json) : null;
}
function runOf(id) {
  return store.one('SELECT * FROM runs WHERE run_id = ?', id);
}

async function pending() {
  const run = runs.submitRun({ prompt: '过来 track:abc', route: 'fast' });
  const a = runs.createApproval({
    runId: run.run_id,
    capability: 'robot_follow',
    actionLabel: '跟随我',
    argsSummary: '{"target_track_id":"abc"}',
    argsJson: '{"target_track_id":"abc"}',
  });
  const res = await announcer.announce(a.approval_id);
  return { runId: run.run_id, approvalId: a.approval_id, announced: res };
}

function finishAnnouncement(approvalId, played = 2) {
  feed('speech.tts_finished', {
    response_id: `tts-${approvalId}`,
    approval_id: approvalId,
    kind: 'approval_repeat',
    played,
    chunks: 2,
  });
  return runs.getApproval(approvalId);
}

function say(utteranceId, text, { startedAt, erle } = {}) {
  const a = runs.latestApprovalForVoice();
  const opens = a?.window_opens_at ? Date.parse(a.window_opens_at) : Date.now();
  const ts = startedAt ?? new Date(opens + 1000).toISOString();
  feed('speech.started', { utterance_id: utteranceId, aec_erle_db: erle }, ts);
  feed('speech.final', { utterance_id: utteranceId, text, stop_reason: 'endpoint' });
}

console.log('— 判据 1：确认 → approved → executing');
{
  const { runId, approvalId } = await pending();
  const opened = finishAnnouncement(approvalId);
  check('播报完成才开窗', opened.status === 'waiting', opened.status);
  check('run 进入 waiting_confirmation', runOf(runId).status === 'waiting_confirmation');
  say('u-approve', '确认');
  check('settle 结果 approved', settled.at(-1)?.outcome === 'approved', JSON.stringify(settled.at(-1)));
  check('审批 approved/voice', runs.getApproval(approvalId).status === 'approved');
  check('run executing', runOf(runId).status === 'executing');
  check('复述没有调用 robot_speak', !robotd.capabilityCalls.includes('robot_speak') && robotd.announces.length === 1);
  runs.transition(runId, 'succeeded', { reason: 'test' });
}

console.log('— 判据 2/5：不用 / 确认不用 → cancelled(denied)');
{
  const { runId, approvalId } = await pending();
  finishAnnouncement(approvalId);
  say('u-deny', '确认不用');
  check('settle 结果 denied', settled.at(-1)?.outcome === 'denied', JSON.stringify(settled.at(-1)));
  check('run cancelled', runOf(runId).status === 'cancelled');
  check('blocking_reason denied', runOf(runId).blocking_reason === 'denied');
  check('审批 denied', runs.getApproval(approvalId).status === 'denied');
}

console.log('— 安全停止词在确认窗口内按拒绝处理（不能被吞掉）');
{
  const { runId, approvalId } = await pending();
  finishAnnouncement(approvalId);
  say('u-stop-word', '停');
  check('「停」settle 为 denied', settled.at(-1)?.outcome === 'denied', JSON.stringify(settled.at(-1)));
  check('run 已取消（没有动作在路上）', runOf(runId).status === 'cancelled', runOf(runId).status);
  check('审批 denied', runs.getApproval(approvalId).status === 'denied');
}

console.log('— 判据 7：窗口外开口 → before_window');
{
  const { runId, approvalId } = await pending();
  const a = finishAnnouncement(approvalId);
  say('u-early', '确认', { startedAt: new Date(Date.parse(a.window_opens_at) - 1000).toISOString() });
  check('reason before_window', lastParams('approval.ignored', approvalId)?.reason === 'before_window');
  check('run 仍等待', runOf(runId).status === 'waiting_confirmation');
  runs.cancelRun(runId, 'cleanup');
}

console.log('— 判据 8：回声 → echo');
{
  const { runId, approvalId } = await pending();
  finishAnnouncement(approvalId);
  say('u-echo', '确认', { erle: 1.5 });
  check('reason echo', lastParams('approval.ignored', approvalId)?.reason === 'echo');
  check('run 仍等待', runOf(runId).status === 'waiting_confirmation');
  runs.cancelRun(runId, 'cleanup');
}

console.log('— 未识别：泛化「好」不批准，保持等待');
{
  const { runId, approvalId } = await pending();
  finishAnnouncement(approvalId);
  say('u-generic', '好');
  check('reason unrecognized', lastParams('approval.ignored', approvalId)?.reason === 'unrecognized');
  check('run 仍等待', runOf(runId).status === 'waiting_confirmation');
  runs.cancelRun(runId, 'cleanup');
}

console.log('— 判据 9：played=0 不开窗、不 settle');
{
  const { runId, approvalId } = await pending();
  const a = finishAnnouncement(approvalId, 0);
  check('played=0 不开窗', a.status !== 'waiting', a.status);
  check('run failed', runOf(runId).status === 'failed');
  const before = countEvents('approval.ignored', approvalId);
  say('u-early-confirm', '确认', { startedAt: new Date(Date.now() + 1000).toISOString() });
  check('没有裁决 / ignored', countEvents('approval.ignored', approvalId) === before);
  check('run 保持 failed', runOf(runId).status === 'failed');
}

console.log('— 判据 3/4：定时器过期 → timeout → cancelled；迟到确认 ignored(expired)');
{
  const { runId, approvalId } = await pending();
  const opened = runs.openConfirmationWindow(approvalId, 20);
  check('短窗口开窗', opened.opened === true);
  await new Promise((r) => setTimeout(r, 80));
  check('run cancelled', runOf(runId).status === 'cancelled');
  check('blocking_reason expired', runOf(runId).blocking_reason === 'expired');
  check('审批 timeout', runs.getApproval(approvalId).status === 'timeout');
  check('approval.expired 一次', countEvents('approval.expired', approvalId) === 1);
  const a = runs.getApproval(approvalId);
  say('u-late', '确认', { startedAt: new Date(Date.parse(a.window_opens_at) + 1000).toISOString() });
  check('迟到确认 reason expired', lastParams('approval.ignored', approvalId)?.reason === 'expired');
  check('迟到确认不改状态', runOf(runId).status === 'cancelled' && runs.getApproval(approvalId).status === 'timeout');
}

console.log('— 对象绑定：拿别的 approval_id settle 不会误批');
{
  const { runId, approvalId } = await pending();
  finishAnnouncement(approvalId);
  const other = runs.settleApproval({
    approvalId: 'appr-does-not-exist',
    text: '确认',
    utteranceId: 'u-wrong',
    startedAt: new Date().toISOString(),
    echo: false,
  });
  check('未知 approval_id 不裁决', other.outcome === 'none');
  check('原审批仍 waiting', runs.getApproval(approvalId).status === 'waiting');
  check('run 仍等待', runOf(runId).status === 'waiting_confirmation');
  runs.cancelRun(runId, 'cleanup');
}

console.log('— 只用 final：partial 不参与');
{
  const { runId, approvalId } = await pending();
  finishAnnouncement(approvalId);
  const before = countEvents('approval.ignored', approvalId);
  feed('speech.partial', { utterance_id: 'u-partial', revision: 1, text: '确认' });
  check('partial 不产生裁决', countEvents('approval.ignored', approvalId) === before);
  check('run 仍等待', runOf(runId).status === 'waiting_confirmation');
  runs.cancelRun(runId, 'cleanup');
}

console.log('— 凭据签发：args_digest 走契约规则，HMAC 可验');
{
  const now = new Date('2026-11-07T00:00:00Z');
  const cred = mintApprovalCredential({
    capability: 'robot_follow',
    args: { target_track_id: 'abc' },
    approvalParams: ['target_track_id', 'target'],
    now,
  });
  check('args_digest 与契约实现一致', cred.args_digest === approvalArgsDigest({ target_track_id: 'abc' }, ['target_track_id', 'target']));
  check('有效期 60 秒', Date.parse(cred.expires_at) - Date.parse(cred.issued_at) === 60_000);
  const [payloadSeg, sig] = cred.header.split('.');
  const secret = Buffer.from(fs.readFileSync(approvalSecretPath(), 'utf8').trim(), 'hex');
  const expected = crypto.createHmac('sha256', secret).update(payloadSeg, 'ascii').digest('base64url');
  check('HMAC 覆盖 payload 段', sig === expected);
  const payload = JSON.parse(Buffer.from(payloadSeg, 'base64url').toString('utf8'));
  check('payload 字段完整', ['issuer', 'capability', 'args_digest', 'issued_at', 'expires_at', 'nonce'].every((k) => typeof payload[k] === 'string' && payload[k]));
}

runs.dispose();
store.close();
fs.rmSync(root, { recursive: true, force: true });
delete process.env.WALLY_APP_DATA_DIR;
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
