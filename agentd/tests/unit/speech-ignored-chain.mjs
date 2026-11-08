/**
 * `speech.ignored` 全链一条测试（GH-7 §5）：
 * 契约 → 生成物 → robotd 真的发 → agentd 事件桥收 → `observation.speech_ignored`。
 *
 * 为什么要跨进程：这条事件的产生方在 robotd（Python），消费方在 agentd（TS）。
 * 两边各测一遍只能证明「各自按约定工作」，证明不了**同一条事实**能串起来。
 * 这里让 robotd 真的跑一次 `AudioRuntime.new_utterance()` 的忙拒绝，把它产出的
 * 事件原样喂给 `RobotdEventBridge`——中间不手抄 payload。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/agentd/store.ts';
import { EventLog, loadRegistry } from '../../src/agentd/events.ts';
import { RobotdEventBridge } from '../../src/agentd/robotd-event-bridge.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const root = path.join(REPO, 'work', 'agentd-test', 'speech-ignored-chain');
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

// ---------------------------------------------------------------- 契约 → 生成物
console.log('— 契约与生成物都登记了 speech.ignored');
const contract = JSON.parse(fs.readFileSync(path.join(REPO, 'contracts', 'events.json'), 'utf8'));
const entry = (contract.events ?? []).find((e) => e.type === 'speech.ignored');
check('events.json 登记 speech.ignored', Boolean(entry));
const payload = entry?.payload ?? {};
check('utterance_id 必填', payload.utterance_id?.required === true && payload.utterance_id?.type === 'string');
check('reason 必填且为字符串', payload.reason?.required === true && payload.reason?.type === 'string');
check(
  'reason 枚举含 busy/echo/empty/speaking',
  ['busy', 'echo', 'empty', 'speaking'].every((r) => payload.reason?.enum?.includes(r)),
  JSON.stringify(payload.reason?.enum),
);
check('run_id 可选', payload.run_id?.required === false && payload.run_id?.type === 'string');

const generated = JSON.parse(
  fs.readFileSync(path.join(REPO, 'contracts', 'generated', 'robotd-events.json'), 'utf8'),
);
const genEntry = (generated.events ?? []).find((e) => e.type === 'speech.ignored');
check('生成物登记 speech.ignored', Boolean(genEntry));
check(
  '生成物的 required_fields 与契约一致',
  JSON.stringify(genEntry?.required_fields?.slice().sort()) ===
    JSON.stringify(['reason', 'utterance_id']),
  JSON.stringify(genEntry?.required_fields),
);

// ---------------------------------------------------------------- robotd 真的发
console.log('— robotd 的忙拒绝真的产出 speech.ignored');
const pyScript = `
import json
import sys
from robotd.core.audio_runtime import AudioRuntime
from robotd.core.types import DeviceStatus

class Bridge:
    status = DeviceStatus.READY
    def ready(self):
        return True
    def send(self, cmd, best_effort=False):
        pass

emitted = []
rt = AudioRuntime(emit=lambda t, p: emitted.append({"type": t, "payload": p}))
rt.attach(Bridge())
rt.new_utterance(task_id="t-first")
try:
    rt.new_utterance(task_id="t-second")
except RuntimeError:
    pass
print(json.dumps(emitted, ensure_ascii=False))
`;

function runRobotd(interpreter) {
  return execFileSync(interpreter, ['-c', pyScript], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: path.join(REPO, 'robotd', 'src') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const candidates = [
  process.env.ROBOTD_PYTHON,
  path.join(REPO, 'robotd', '.venv', 'bin', 'python'),
  'python3.11',
  'python3',
].filter(Boolean);
let emittedRaw = null;
let usedPython = null;
let pythonError = null;
for (const candidate of candidates) {
  try {
    emittedRaw = runRobotd(candidate);
    usedPython = candidate;
    break;
  } catch (e) {
    pythonError = e;
  }
}
check('找到可运行 robotd 的 Python', emittedRaw !== null, pythonError?.message ?? 'no interpreter');
const emitted = emittedRaw ? JSON.parse(emittedRaw) : [];
const ignored = emitted.find((e) => e.type === 'speech.ignored');
check('robotd 产出了 speech.ignored', Boolean(ignored), JSON.stringify(emitted));
check('robotd 给出的 reason=busy', ignored?.payload?.reason === 'busy', JSON.stringify(ignored?.payload));
check(
  'robotd 给出的 utterance_id 指向被丢弃的请求',
  typeof ignored?.payload?.utterance_id === 'string' && ignored.payload.utterance_id.length > 0,
  JSON.stringify(ignored?.payload),
);

// ---------------------------------------------------------------- agentd 真的收
console.log('— 同一条事件喂给事件桥 → observation.speech_ignored');
const store = new Store(path.join(root, 'agentd.sqlite'), { log: () => {} });
const events = new EventLog(store, loadRegistry(), 'boot-speech-ignored-chain');
const logs = [];
const bridge = new RobotdEventBridge({ events, store, hooks: { log: (msg, extra) => logs.push({ msg, extra }) } });
bridge.handle({
  version: 1,
  type: ignored?.type ?? 'speech.ignored',
  event_id: 'evt-chain-1',
  seq: 1,
  timestamp: new Date().toISOString(),
  payload: ignored?.payload ?? {},
});
const row = store.one(
  "SELECT * FROM events WHERE type = 'observation.speech_ignored' AND params_json LIKE ?",
  `%${ignored?.payload?.utterance_id ?? ''}%`,
);
check('写入了 observation.speech_ignored', Boolean(row), JSON.stringify(row));
const params = row ? JSON.parse(row.params_json) : null;
check('observation 保留 reason=busy', params?.reason === 'busy', row?.params_json);
check(
  'observation 保留同一个 utterance_id',
  params?.utterance_id === ignored?.payload?.utterance_id,
  row?.params_json,
);
check('observation 来源是 robotd', row?.source === 'robotd', row?.source);
check('事件桥记录了「丢弃」日志', logs.some((l) => l.msg.includes('丢弃')), JSON.stringify(logs));

store.close();
fs.rmSync(root, { recursive: true, force: true });
if (usedPython) console.log(`       robotd interpreter: ${usedPython}`);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
