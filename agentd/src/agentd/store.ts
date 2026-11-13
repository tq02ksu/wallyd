/**
 * SQLite 持久存储：agentd 的真相源（身体状态仍以 robotd 为准，这里只存只读观测）。
 *
 * 设计依据：docs/spec/agentd-functional-design.md §6.1–6.3、开发计划 A05。
 *
 * ## 三条纪律
 *
 * 1. **业务状态与它的审计事件在同一事务里提交**。否则会出现「页面显示成功、历史没保存」，
 *    事后无法解释发生了什么。
 * 2. **外部调用的意图先落库再调用**。agentd 无法和 robotd 做分布式事务，所以流程是：
 *    写 `tool_calls(state=requested)` → 调 robotd → 写结果。若进程在中间崩掉，
 *    这一行会停在 `requested`，重启时标成 `outcome_unknown` 并对账，
 *    **不能当作「没执行」去重试**。
 * 3. **写不进去就 fail-closed**。磁盘满或库不可写时 `writable=false`，
 *    凡是要产生后果的动作一律拒绝；但停止路径继续可用（停止不依赖本库）。
 *
 * ## 为什么用 node:sqlite
 *
 * Node 22 内置，不需要原生编译，也不引入需要跟版本的依赖。单进程写入 + WAL 足够：
 * 所有写入都经本模块串行化。它仍标 experimental，所以启动时提示一次，不影响功能。
 *
 * ## 迁移
 *
 * `SCHEMA_VERSION` 单调整数 + `MIGRATIONS` 数组；user_version 从 0 开始，
 * 所以 `MIGRATIONS[0]` 是建 v1。逐版本推进，推进前把库文件复制到 `backups/`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 5;

const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE sessions (
       session_id TEXT PRIMARY KEY,
       title      TEXT NOT NULL,
       status     TEXT NOT NULL DEFAULT 'active',
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
    `CREATE TABLE messages (
       message_id TEXT PRIMARY KEY,
       session_id TEXT NOT NULL REFERENCES sessions(session_id),
       run_id     TEXT,
       role       TEXT NOT NULL,
       text       TEXT NOT NULL,
       streaming  INTEGER NOT NULL DEFAULT 0,
       source     TEXT NOT NULL DEFAULT 'text',
       created_at TEXT NOT NULL
     )`,
    'CREATE INDEX idx_messages_session ON messages(session_id, created_at)',
    `CREATE TABLE runs (
       run_id           TEXT PRIMARY KEY,
       session_id       TEXT,
       prompt           TEXT NOT NULL,
       status           TEXT NOT NULL,
       route            TEXT NOT NULL,
       fast_rule        TEXT,
       source           TEXT NOT NULL DEFAULT 'text',
       idempotency_key  TEXT UNIQUE,
       model_profile_id TEXT,
       model_revision   INTEGER,
       blocking_reason  TEXT,
       error_code       TEXT,
       harness_exit     INTEGER,
       created_at       TEXT NOT NULL,
       updated_at       TEXT NOT NULL,
       finished_at      TEXT
     )`,
    'CREATE INDEX idx_runs_status ON runs(status, created_at)',
    `CREATE TABLE run_steps (
       step_id     TEXT PRIMARY KEY,
       run_id      TEXT NOT NULL REFERENCES runs(run_id),
       idx         INTEGER NOT NULL,
       title       TEXT NOT NULL,
       state       TEXT NOT NULL,
       note        TEXT,
       started_at  TEXT,
       finished_at TEXT
     )`,
    'CREATE INDEX idx_steps_run ON run_steps(run_id, idx)',
    `CREATE TABLE tool_calls (
       tool_call_id      TEXT PRIMARY KEY,
       run_id            TEXT NOT NULL REFERENCES runs(run_id),
       capability        TEXT NOT NULL,
       action_label      TEXT NOT NULL,
       args_summary      TEXT NOT NULL,
       args_json         TEXT NOT NULL DEFAULT '{}',
       state             TEXT NOT NULL,
       requires_approval INTEGER NOT NULL DEFAULT 0,
       approval_id       TEXT,
       robot_task_id     TEXT,
       evidence          TEXT,
       error_code        TEXT,
       detail            TEXT,
       requested_at      TEXT NOT NULL,
       finished_at       TEXT
     )`,
    'CREATE INDEX idx_tool_calls_run ON tool_calls(run_id, requested_at)',
    'CREATE INDEX idx_tool_calls_state ON tool_calls(state)',
    `CREATE TABLE approvals (
       approval_id        TEXT PRIMARY KEY,
       run_id             TEXT,
       tool_call_id       TEXT,
       capability         TEXT NOT NULL,
       action_label       TEXT NOT NULL,
       args_summary       TEXT NOT NULL,
       args_json          TEXT NOT NULL DEFAULT '{}',
       prompt_text        TEXT NOT NULL,
       status             TEXT NOT NULL,
       window_opens_at    TEXT,
       window_closes_at   TEXT,
       decided_at         TEXT,
       decided_by         TEXT,
       authorization_json TEXT,
       authorization_consumed INTEGER NOT NULL DEFAULT 0,
       created_at         TEXT NOT NULL
     )`,
    'CREATE INDEX idx_approvals_status ON approvals(status, created_at)',
    `CREATE TABLE model_profiles (
       profile_id      TEXT PRIMARY KEY,
       name            TEXT NOT NULL,
       latest_revision INTEGER NOT NULL,
       active_revision INTEGER,
       created_at      TEXT NOT NULL,
       updated_at      TEXT NOT NULL
     )`,
    `CREATE TABLE model_revisions (
       profile_id         TEXT NOT NULL REFERENCES model_profiles(profile_id),
       revision           INTEGER NOT NULL,
       payload_json       TEXT NOT NULL,
       credential_ref     TEXT,
       validation_json    TEXT,
       config_fingerprint TEXT,
       created_at         TEXT NOT NULL,
       PRIMARY KEY (profile_id, revision)
     )`,
    `CREATE TABLE events (
       seq                INTEGER PRIMARY KEY AUTOINCREMENT,
       event_id           TEXT NOT NULL UNIQUE,
       type               TEXT NOT NULL,
       version            INTEGER NOT NULL DEFAULT 1,
       severity           TEXT NOT NULL,
       occurred_at        TEXT NOT NULL,
       received_at        TEXT NOT NULL,
       source             TEXT NOT NULL,
       source_instance_id TEXT,
       session_id         TEXT,
       run_id             TEXT,
       tool_call_id       TEXT,
       robot_task_id      TEXT,
       approval_id        TEXT,
       code               TEXT,
       params_json        TEXT NOT NULL DEFAULT '{}',
       data_json          TEXT,
       caused_by          TEXT,
       recovery_of        TEXT
     )`,
    'CREATE INDEX idx_events_occurred ON events(occurred_at DESC, seq DESC)',
    'CREATE INDEX idx_events_type ON events(type)',
    'CREATE INDEX idx_events_run ON events(run_id)',
    'CREATE INDEX idx_events_severity ON events(severity)',
    `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  ],
  // v2（GH-13）：run 结论播报。
  // - result_summary：由执行步骤/工具结果归纳的「做了什么」，不是模型推理正文；
  // - narration_requested_at：播报请求的原子认领时间，保证同一 run 至多播一次；
  // - narration：播报结果 spoken/interrupted/failed，与 run.status 完全解耦。
  [
    'ALTER TABLE runs ADD COLUMN result_summary TEXT',
    'ALTER TABLE runs ADD COLUMN narration_requested_at TEXT',
    'ALTER TABLE runs ADD COLUMN narration TEXT',
  ],
  // v3（GH-10）：会话复用的 Harness thread。
  // - thread_id 只属于 sessions：同一会话的多个 run 复用同一个 thread；
  // - 放在 sessions 而不是 runs，因为「复用」的粒度是会话，不是单次任务；
  // - 可空：既有会话尚未跑过 Harness，或 Harness 未配置。
  ['ALTER TABLE sessions ADD COLUMN thread_id TEXT'],
  // v4（GH-53）：确认窗口内「再说一遍」的次数。
  // 落库而不是只放内存：进程重启后不能把用户已经用掉的复述次数清零，
  // 否则「最多 3 次」就变成了「每次重启再送 3 次」。
  ['ALTER TABLE approvals ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 0'],
  // v5（GH-68）：说话人 ↔ track 绑定表。
  // - confidence / source 必须落库：follow 的门限判断与审计都要能查；
  // - expires_at 是毫秒时间戳，读取方按注入时钟判定，不依赖 sleep；
  // - track_id 建索引：person.lost 要按 track 立即删干净，不能留悬空引用。
  [
    `CREATE TABLE person_bindings (
       speaker_id TEXT PRIMARY KEY,
       track_id   TEXT NOT NULL,
       confidence REAL NOT NULL,
       source     TEXT NOT NULL,
       bound_at   INTEGER NOT NULL,
       expires_at INTEGER NOT NULL
     )`,
    'CREATE INDEX idx_person_bindings_track ON person_bindings(track_id)',
    'CREATE INDEX idx_person_bindings_expires ON person_bindings(expires_at)',
  ],
];

export class StoreUnavailable extends Error {
  readonly code = 'E_STORE';
  constructor(message: string) {
    super(message);
    this.name = 'StoreUnavailable';
  }
}

export interface StoreStats {
  path: string;
  writable: boolean;
  schema_version: number;
  events: number;
  runs: number;
  last_error: string | null;
}

/** 统一时间格式：UTC ISO 8601，毫秒精度，Z 结尾。库里所有时间都用它。 */
export function nowIso(ms = Date.now()): string {
  return new Date(ms).toISOString();
}

export function compactJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function loadJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

type Row = Record<string, unknown>;

export class Store {
  readonly path: string;
  private db: DatabaseSync;
  private writable = true;
  private lastError: string | null = null;
  private schema = 0;
  private log: (msg: string) => void;

  constructor(dbPath: string, opts: { log?: (msg: string) => void } = {}) {
    this.path = dbPath;
    this.log = opts.log ?? (() => {});
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.db.exec('PRAGMA busy_timeout=5000');
    this.migrate();
  }

  // ---------------------------------------------------------------- 迁移
  private backup(): string | null {
    if (!fs.existsSync(this.path) || fs.statSync(this.path).size === 0) return null;
    const dir = path.join(path.dirname(this.path), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(this.path).replace(/\.sqlite$/, '');
    const target = path.join(dir, `${base}-v${this.schema}-${Date.now()}.sqlite`);
    try {
      fs.copyFileSync(this.path, target);
      this.log(`迁移前备份：${target}`);
      return target;
    } catch (e: any) {
      this.log(`迁移前备份失败（继续迁移）：${e.message}`);
      return null;
    }
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as Row | undefined;
    const current = Number(row?.user_version ?? 0);
    if (current > SCHEMA_VERSION) {
      throw new StoreUnavailable(`库版本 ${current} 高于本程序支持的 ${SCHEMA_VERSION}；拒绝降级打开以免损坏数据`);
    }
    if (current === SCHEMA_VERSION) {
      this.schema = current;
      this.ensureMeta();
      return;
    }
    this.schema = current;
    this.backup();
    for (let v = current; v < SCHEMA_VERSION; v += 1) {
      this.log(`迁移 schema v${v} → v${v + 1}`);
      try {
        this.db.exec('BEGIN IMMEDIATE');
        for (const sql of MIGRATIONS[v]) this.db.exec(sql);
        this.db.exec(`PRAGMA user_version=${v + 1}`);
        this.db.exec('COMMIT');
      } catch (e: any) {
        try { this.db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
        throw new StoreUnavailable(`迁移到 v${v + 1} 失败：${e.message}`);
      }
    }
    this.schema = SCHEMA_VERSION;
    this.ensureMeta();
  }

  private ensureMeta(): void {
    this.db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES('created_at', ?)").run(nowIso());
  }

  close(): void {
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* 忽略 */ }
    try { this.db.close(); } catch { /* 忽略 */ }
  }

  // ---------------------------------------------------------------- 健康
  get isWritable(): boolean {
    return this.writable;
  }

  /** 真写一次再回滚。只看文件权限不足以发现磁盘满或只读文件系统。 */
  probeWritable(): boolean {
    try {
      this.db.exec('CREATE TEMP TABLE IF NOT EXISTS _probe(x)');
      this.db.prepare('INSERT INTO _probe(x) VALUES(1)').run();
      this.db.exec('DELETE FROM _probe');
      if (!this.writable) {
        this.writable = true;
        this.lastError = null;
        this.log('存储已恢复可写');
      }
      return true;
    } catch (e: any) {
      this.writable = false;
      this.lastError = e.message;
      this.log(`存储不可写：${e.message}`);
      return false;
    }
  }

  requireWritable(): void {
    if (!this.writable) throw new StoreUnavailable(`历史库不可写：${this.lastError ?? '未知原因'}`);
  }

  stats(): StoreStats {
    const count = (table: string): number => {
      try {
        const r = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row;
        return Number(r?.n ?? -1);
      } catch {
        return -1;
      }
    };
    return {
      path: this.path,
      writable: this.writable,
      schema_version: this.schema,
      events: count('events'),
      runs: count('runs'),
      last_error: this.lastError,
    };
  }

  markUnwritable(message: string): void {
    this.writable = false;
    this.lastError = message;
  }

  // ---------------------------------------------------------------- 事务
  /**
   * 在事务里执行 `fn`。异常回滚并向上抛。
   *
   * 用 `BEGIN IMMEDIATE` 而非默认 deferred：agentd 是唯一写者，
   * 立即取写锁能让并发写在前端就串行化，而不是拖到提交才冲突。
   */
  transaction<T>(fn: (tx: Tx) => T): T {
    this.requireWritable();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(new Tx(this.db));
      this.db.exec('COMMIT');
      return result;
    } catch (e: any) {
      try { this.db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
      if (e instanceof StoreUnavailable) throw e;
      const msg = String(e?.message ?? e);
      if (/disk|readonly|read-only|full|unable to open/i.test(msg)) {
        this.markUnwritable(msg);
        throw new StoreUnavailable(`写入失败：${msg}`);
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------- 读
  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  one<T = Row>(sql: string, ...params: unknown[]): T | null {
    const rows = this.all<T>(sql, ...params);
    return rows.length > 0 ? rows[0] : null;
  }

  // ---------------------------------------------------------------- meta
  getMeta(key: string): string | null {
    const row = this.one<{ value: string }>('SELECT value FROM meta WHERE key = ?', key);
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.transaction((tx) => {
      tx.run(
        'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        value,
      );
    });
  }
}

/** 事务内的语句执行器。只暴露 run/one/all，不暴露原始连接。 */
export class Tx {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const res = this.db.prepare(sql).run(...(params as never[]));
    return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  one<T = Row>(sql: string, ...params: unknown[]): T | null {
    const rows = this.all<T>(sql, ...params);
    return rows.length > 0 ? rows[0] : null;
  }
}
