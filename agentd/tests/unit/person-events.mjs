/**
 * `person.*` 事件登记 + `person.moved` 降频（GH-63 验收判据 1/4）。
 *
 * 本条只做契约层：不接 Vision、不写跟踪算法。这里验证的是**事件面**：
 *   1. 三条事件真的能经 `EventLog.emit` 落库（不再因「未登记」抛错），并贴出 JSON 原文；
 *   2. `person.moved` 的频率上限由**契约**声明，运行时按契约执行；
 *   3. 用 30Hz 输入跑 60 秒的模拟观测，证明入库条数被压到 ≤5Hz。
 *
 * 时钟由构造参数注入：60 秒模拟不能真的睡 60 秒，否则门禁会被拖垮。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/agentd/store.ts';
import { EventLog, loadRegistry } from '../../src/agentd/events.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(HERE, '..', '..', '..', 'work', 'agentd-test', 'person-events');
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

// 可注入的单调时钟：只用于频率窗口，不影响 occurred_at 的墙钟语义。
let fakeNow = 1_000_000;
const clock = () => fakeNow;

const store = new Store(path.join(root, 'agentd.sqlite'), { log: () => {} });
const registry = loadRegistry();
const events = new EventLog(store, registry, 'boot-person-1', { now: clock });

const bbox = (x) => ({ x, y: 0.1, width: 0.2, height: 0.3 });
const rowsOfType = (type) => store.all('SELECT * FROM events WHERE type = ? ORDER BY seq', type);
const trackOf = (row) => JSON.parse(row.params_json).track_id;

// ---------------------------------------------------------------- 1. 三条事件都能落库
console.log('— person.* 已登记且能 emit');
const appeared = events.emitStandalone({
  type: 'person.appeared',
  source: 'robotd',
  params: {
    track_id: 't-1',
    bbox: bbox(0.25),
    first_seen_at: '2026-11-11T08:00:00.000Z',
  },
});
check('person.appeared 不因未登记抛错', appeared.seq > 0);
const appearedRow = store.one('SELECT * FROM events WHERE seq = ?', appeared.seq);
check('person.appeared 已落库', appearedRow?.type === 'person.appeared');
check('person.appeared 有可读标题', Boolean(events.query({ limit: 10 }).events.find((e) => e.type === 'person.appeared')?.title));
console.log(`       emit 原文: ${JSON.stringify({
  event_id: appearedRow.event_id,
  type: appearedRow.type,
  severity: appearedRow.severity,
  occurred_at: appearedRow.occurred_at,
  received_at: appearedRow.received_at,
  source: appearedRow.source,
  payload: JSON.parse(appearedRow.params_json),
})}`);

const lost = events.emitStandalone({
  type: 'person.lost',
  source: 'robotd',
  params: { track_id: 't-1', last_seen_at: '2026-11-11T08:00:05.000Z' },
});
check('person.lost 不因未登记抛错', lost.seq > 0);
check('person.lost 已落库', store.one('SELECT * FROM events WHERE seq = ?', lost.seq)?.type === 'person.lost');

// ---------------------------------------------------------------- 2. 超出上限的观测被丢弃
console.log('— person.moved 超出上限即丢弃');
const moveInput = (track) => ({ type: 'person.moved', source: 'robotd', params: { track_id: track, bbox: bbox(0.5) } });
const burst = [];
for (let i = 0; i < 7; i += 1) burst.push(events.emitStandalone(moveInput('t-burst')));
check('同一秒内 7 条只入库 5 条', burst.filter((r) => r.throttled !== true).length === 5, JSON.stringify(burst.map((r) => Boolean(r.throttled))));
check('被压掉的观测返回 throttled', burst.filter((r) => r.throttled === true).length === 2);
check('burst 只落库 5 条', rowsOfType('person.moved').filter((r) => trackOf(r) === 't-burst').length === 5);

// ---------------------------------------------------------------- 3. 60 秒模拟观测
console.log('— 60 秒模拟观测（30Hz 输入）');
const SECONDS = 60;
const INPUT_HZ = 30;
const attempts = SECONDS * INPUT_HZ;
const simStart = fakeNow;
for (let i = 0; i < attempts; i += 1) {
  fakeNow = simStart + Math.round((i * 1000) / INPUT_HZ);
  events.emitStandalone(moveInput('t-sim'));
}
fakeNow = simStart + SECONDS * 1000;
const simRows = rowsOfType('person.moved').filter((r) => trackOf(r) === 't-sim');
const effectiveHz = simRows.length / SECONDS;
const contractCap = registry.templates.find((t) => t.type === 'person.moved')?.rate_limit?.max_hz;
check(`契约声明上限 ${contractCap}Hz`, typeof contractCap === 'number' && contractCap > 0 && contractCap <= 5);
check(`60 秒入库条数 ≤ ${SECONDS * 5}（实际 ${simRows.length}）`, simRows.length <= SECONDS * 5);
check(`等效频率 ≤ 5Hz（实际 ${effectiveHz.toFixed(2)}Hz）`, effectiveHz <= 5);
console.log(`       输入 ${attempts} 条（${INPUT_HZ}Hz × ${SECONDS}s）→ 入库 ${simRows.length} 条 → ${effectiveHz.toFixed(2)}Hz`);

// 不同 track 各自独立计数：一条 track 打满上限不饿死另一条。
const before = rowsOfType('person.moved').filter((r) => trackOf(r) === 't-other').length;
events.emitStandalone(moveInput('t-other'));
const after = rowsOfType('person.moved').filter((r) => trackOf(r) === 't-other').length;
check('另一条 track 不受 t-sim 的上限影响', after === before + 1);

store.close();
console.log('');
if (failed > 0) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');
