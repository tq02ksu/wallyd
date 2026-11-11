/**
 * Store 的单元测试：迁移、事务原子性、可写探测、重开一致性。
 *
 * 这里刻意用断言而不是「打印看一眼」——只打印的脚本永远返回 0，
 * 无论数据对不对都会显示「通过」，等于没有测试。
 */
import { Store, nowIso, compactJson, SCHEMA_VERSION } from '../../src/agentd/store.ts';
import fs from 'node:fs';
import path from 'node:path';
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

// 真实部署里已经存在 v1/v2 库：只验证「新建库」不够，旧库的 ALTER 也必须能跑。
const pV1 = new URL('../../../work/agentd-test/store-v1.sqlite', import.meta.url).pathname;
for (const f of [pV1, `${pV1}-wal`, `${pV1}-shm`]) fs.rmSync(f, { force: true });
const raw = new DatabaseSync(pV1);
raw.exec(`CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
raw.exec(`CREATE TABLE runs (
  run_id TEXT PRIMARY KEY, session_id TEXT, prompt TEXT NOT NULL, status TEXT NOT NULL,
  route TEXT NOT NULL, fast_rule TEXT, source TEXT NOT NULL DEFAULT 'text',
  idempotency_key TEXT UNIQUE, model_profile_id TEXT, model_revision INTEGER,
  blocking_reason TEXT, error_code TEXT, harness_exit INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT)`);
raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
// v1 的真实 schema 包含 approvals；夹具之前漏了这张表，v4 的 ALTER 会因此失真。
raw.exec(`CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY, run_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL)`);
raw.exec('PRAGMA user_version=1');
raw.close();
const migrated = new Store(pV1, { log: () => {} });
const migratedCols = migrated.all('PRAGMA table_info(runs)').map((c) => c.name);
const migratedSessionCols = migrated.all('PRAGMA table_info(sessions)').map((c) => c.name);
check(
  'v1 库升级后补上结论播报列',
  ['result_summary', 'narration_requested_at', 'narration'].every((c) => migratedCols.includes(c)),
  migratedCols.join(','),
);
check(
  'v1 库升级后补上 thread_id（v3）',
  migratedSessionCols.includes('thread_id'),
  migratedSessionCols.join(','),
);
const migratedApprovalCols = migrated.all('PRAGMA table_info(approvals)').map((c) => c.name);
check(
  'v1 库升级后补上 repeat_count（v4）',
  migratedApprovalCols.includes('repeat_count'),
  migratedApprovalCols.join(','),
);
check('v1 升级后版本正确', migrated.stats().schema_version === SCHEMA_VERSION);
migrated.close();

// v2 库（GH-13 之后、GH-10 之前）必须能升到 v3，且迁移前有备份、数据不丢。
const pV2 = new URL('../../../work/agentd-test/store-v2.sqlite', import.meta.url).pathname;
for (const f of [pV2, `${pV2}-wal`, `${pV2}-shm`]) fs.rmSync(f, { force: true });
fs.rmSync(path.join(path.dirname(pV2), 'backups'), { recursive: true, force: true });
const rawV2 = new DatabaseSync(pV2);
rawV2.exec(`CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
rawV2.exec(`CREATE TABLE runs (
  run_id TEXT PRIMARY KEY, session_id TEXT, prompt TEXT NOT NULL, status TEXT NOT NULL,
  route TEXT NOT NULL, fast_rule TEXT, source TEXT NOT NULL DEFAULT 'text',
  idempotency_key TEXT UNIQUE, model_profile_id TEXT, model_revision INTEGER,
  blocking_reason TEXT, error_code TEXT, harness_exit INTEGER,
  result_summary TEXT, narration_requested_at TEXT, narration TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT)`);
rawV2.exec(`INSERT INTO sessions(session_id,title,created_at,updated_at)
  VALUES('sess-v2','老会话','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`);
rawV2.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
rawV2.exec(`CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY, run_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL)`);
rawV2.exec('PRAGMA user_version=2');
rawV2.close();
const migratedV2 = new Store(pV2, { log: () => {} });
const v2SessionCols = migratedV2.all('PRAGMA table_info(sessions)').map((c) => c.name);
check('v2 升级后有 thread_id', v2SessionCols.includes('thread_id'), v2SessionCols.join(','));
check('v2 升级后版本正确', migratedV2.stats().schema_version === SCHEMA_VERSION);
check('v2 老会话数据不丢', migratedV2.all("SELECT session_id FROM sessions WHERE session_id='sess-v2'").length === 1);
const backupDir = path.join(path.dirname(pV2), 'backups');
const backupFiles = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
check('v2 升级前有备份', backupFiles.some((f) => f.includes('store-v2-v2-')), backupFiles.join(',') || 'no backups dir');
migratedV2.close();

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
