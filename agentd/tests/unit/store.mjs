/**
 * Store 的单元测试：迁移、事务原子性、可写探测、重开一致性。
 *
 * 这里刻意用断言而不是「打印看一眼」——只打印的脚本永远返回 0，
 * 无论数据对不对都会显示「通过」，等于没有测试。
 */
import { Store, nowIso, compactJson, SCHEMA_VERSION } from '../../src/agentd/store.ts';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// 每次运行都用干净的库：固定路径 + 不清理会让第二次运行撞主键，
// 失败原因看起来像 schema 问题，实际是测试不幂等。
// 用 import.meta.url 而不是 process.cwd()：否则脚本能否跑起来取决于从哪个目录启动。
const p = new URL('../../../work/agentd-test/store.sqlite', import.meta.url).pathname;
fs.rmSync(p, { force: true });
fs.rmSync(`${p}-wal`, { force: true });
fs.rmSync(`${p}-shm`, { force: true });

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

const s = new Store(p, { log: () => {} });

const evt = (tx, id) => tx.run(
  'INSERT INTO events(event_id,type,severity,occurred_at,received_at,source,params_json) VALUES(?,?,?,?,?,?,?)',
  id, 'daemon.started', 'info', nowIso(), nowIso(), 'agentd',
  compactJson({ pid: 1, contract_version: '1.0.0', recovered_runs: 0 }));

console.log('— 建库与迁移');
check('schema 版本等于当前版本', s.stats().schema_version === SCHEMA_VERSION, String(s.stats().schema_version));
const runColumns = s.all('PRAGMA table_info(runs)').map((c) => c.name);
check(
  'runs 表有结论播报列（v2）',
  ['result_summary', 'narration_requested_at', 'narration'].every((c) => runColumns.includes(c)),
  runColumns.join(','),
);
check('新库可写', s.isWritable === true);
check('新库没有事件', s.stats().events === 0);

// 真实部署里已经存在 v1 库：只验证「新建库」不够，v1 → v2 的 ALTER 也必须能跑。
const pV1 = new URL('../../../work/agentd-test/store-v1.sqlite', import.meta.url).pathname;
for (const f of [pV1, `${pV1}-wal`, `${pV1}-shm`]) fs.rmSync(f, { force: true });
const raw = new DatabaseSync(pV1);
raw.exec(`CREATE TABLE runs (
  run_id TEXT PRIMARY KEY, session_id TEXT, prompt TEXT NOT NULL, status TEXT NOT NULL,
  route TEXT NOT NULL, fast_rule TEXT, source TEXT NOT NULL DEFAULT 'text',
  idempotency_key TEXT UNIQUE, model_profile_id TEXT, model_revision INTEGER,
  blocking_reason TEXT, error_code TEXT, harness_exit INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT)`);
raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
raw.exec('PRAGMA user_version=1');
raw.close();
const migrated = new Store(pV1, { log: () => {} });
const migratedCols = migrated.all('PRAGMA table_info(runs)').map((c) => c.name);
check(
  'v1 库升级后补上结论播报列',
  ['result_summary', 'narration_requested_at', 'narration'].every((c) => migratedCols.includes(c)),
  migratedCols.join(','),
);
check('v1 升级后版本正确', migrated.stats().schema_version === SCHEMA_VERSION);
migrated.close();

console.log('— 事务提交');
s.transaction((tx) => {
  tx.run("INSERT INTO sessions(session_id,title,created_at,updated_at) VALUES('s1','测试',?,?)", nowIso(), nowIso());
  evt(tx, 'evt_1');
});
check('提交后 sessions 有 1 条', s.all('SELECT session_id FROM sessions').length === 1);
check('提交后 events 有 1 条', s.all('SELECT event_id FROM events').length === 1);

console.log('— 事务回滚是原子的');
let threw = false;
try {
  s.transaction((tx) => {
    tx.run("INSERT INTO sessions(session_id,title,created_at,updated_at) VALUES('s2','会回滚',?,?)", nowIso(), nowIso());
    evt(tx, 'evt_2');
    throw new Error('故意失败');
  });
} catch (e) {
  threw = e.message === '故意失败';
}
check('异常向外传播', threw);
check('回滚后 sessions 仍是 1 条', s.all('SELECT session_id FROM sessions').length === 1, String(s.all('SELECT session_id FROM sessions').length));
check('回滚后 events 仍是 1 条', s.all('SELECT event_id FROM events').length === 1, String(s.all('SELECT event_id FROM events').length));
check('回滚后没有留下 s2', s.all("SELECT session_id FROM sessions WHERE session_id='s2'").length === 0);

console.log('— 可写探测');
check('probeWritable 返回 true', s.probeWritable() === true);
s.close();

console.log('— 重开保持一致（迁移不重跑、数据不丢）');
const s2 = new Store(p);
check('重开后 schema 仍是当前版本', s2.stats().schema_version === SCHEMA_VERSION);
check('重开后数据仍在', s2.stats().events === 1);
check('重开后仍可写', s2.isWritable === true);
s2.close();

console.log('');
if (failed > 0) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');
