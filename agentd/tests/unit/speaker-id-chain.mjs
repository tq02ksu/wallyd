/**
 * `speaker_id` 全链（GH-63 判据 2 的集成侧）：
 * robotd 契约的 `speech.final`（可选字段）→ agentd 事件桥 → `speech.utterance_heard`。
 *
 * 两件事都要证明：
 *   1. 上游带了 → 原样带上同一个值（不做编号、不做推断、不做归一化）；
 *   2. 上游没带（或给空串）→ 字段**省略**，不是 `null`、不是空串——
 *      下游必须能区分「没有这个事实」与「事实为空」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/agentd/store.ts';
import { EventLog, loadRegistry } from '../../src/agentd/events.ts';
import { RobotdEventBridge } from '../../src/agentd/robotd-event-bridge.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const root = path.join(REPO, 'work', 'agentd-test', 'speaker-id-chain');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

// ---------------------------------------------------------------- 契约：生产侧可选
console.log('— robotd 契约声明 speech.final.speaker_id 可选');
const contract = JSON.parse(fs.readFileSync(path.join(REPO, 'contracts', 'events.json'), 'utf8'));
const final = (contract.events ?? []).find((e) => e.type === 'speech.final');
const field = final?.payload?.speaker_id;
check('speech.final 登记 speaker_id', Boolean(field));
check('speaker_id 是 string', field?.type === 'string');
check('speaker_id 不是必填', field?.required !== true);

// ---------------------------------------------------------------- 桥：全链
console.log('— speech.final → speech.utterance_heard');
const store = new Store(path.join(root, 'agentd.sqlite'), { log: () => {} });
const events = new EventLog(store, loadRegistry(), 'boot-speaker-id-chain');
const logs = [];
const bridge = new RobotdEventBridge({
  events,
  store,
  hooks: { log: (msg, extra) => logs.push({ msg, extra }) },
});

let seq = 0;
function feed(payload) {
  seq += 1;
  bridge.handle({
    version: 1,
    type: 'speech.final',
    event_id: `evt-speaker-${seq}`,
    seq,
    timestamp: new Date().toISOString(),
    payload,
  });
  const row = store.one(
    "SELECT * FROM events WHERE type = 'speech.utterance_heard' ORDER BY seq DESC LIMIT 1",
  );
  return row ? { row, params: JSON.parse(row.params_json) } : null;
}

const withSpeaker = feed({ utterance_id: 'u-with', text: '跟着我', speaker_id: 'spk-abc' });
check('带上 speaker_id 的事件已入库', Boolean(withSpeaker?.row));
check('speaker_id 原样透传', withSpeaker?.params?.speaker_id === 'spk-abc', JSON.stringify(withSpeaker?.params));
check('来源标成 robotd', withSpeaker?.row?.source === 'robotd');

const withoutSpeaker = feed({ utterance_id: 'u-without', text: '往前走' });
check('不带 speaker_id 的事件已入库', Boolean(withoutSpeaker?.row));
check(
  '不带 speaker_id 时字段省略（不是 null、不是空串）',
  withoutSpeaker ? !('speaker_id' in withoutSpeaker.params) : false,
  JSON.stringify(withoutSpeaker?.params),
);

const emptySpeaker = feed({ utterance_id: 'u-empty', text: '停下', speaker_id: '' });
check('空串 speaker_id 视为未提供（省略）', emptySpeaker ? !('speaker_id' in emptySpeaker.params) : false, JSON.stringify(emptySpeaker?.params));

check('桥没有因契约校验失败而吞事件', logs.length === 0, JSON.stringify(logs));

store.close();
console.log('');
if (failed > 0) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');
