import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { initSchema, SCHEMA_VERSION } = await jiti.import("./sqlite-db.ts");

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  return db;
}

test("initSchema creates all four tables (idempotent)", () => {
  const db = memoryDb();
  db.exec("PRAGMA journal_mode = WAL;"); // ensure no-op doesn't throw
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  for (const t of ["tasks", "session_meta", "search_state", "session_search"]) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
  // Second init must not throw (idempotent).
  initSchema(db);
  assert.ok(true);
});

test("migrations upgrade an old v0 database (adds pinned + sort_order)", () => {
  const db = new DatabaseSync(":memory:");
  // 模拟无版本管理时代的老库：基础表，无 pinned/sort_order 列，user_version=0。
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      name TEXT NOT NULL,
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL
    );
    CREATE TABLE session_meta (
      session_id TEXT PRIMARY KEY,
      task_id TEXT,
      updated INTEGER NOT NULL
    );
    INSERT INTO tasks (id, project_key, name, created, updated) VALUES ('t1', 'p', 'A', 1, 1);
  `);
  db.exec("PRAGMA user_version = 0");

  initSchema(db);

  const v = db.prepare("PRAGMA user_version").get().user_version;
  assert.equal(v, SCHEMA_VERSION);
  const taskCols = db.prepare("SELECT name FROM pragma_table_info('tasks')").all().map((r) => r.name);
  assert.ok(taskCols.includes("pinned"), "tasks.pinned added by v1");
  assert.ok(taskCols.includes("sort_order"), "tasks.sort_order added by v2");
  const metaCols = db.prepare("SELECT name FROM pragma_table_info('session_meta')").all().map((r) => r.name);
  assert.ok(metaCols.includes("pinned"), "session_meta.pinned added by v1");
  // 老数据保留，新列默认值可用。
  const row = db.prepare("SELECT name, pinned, sort_order FROM tasks WHERE id = 't1'").get();
  assert.equal(row.name, "A");
  assert.equal(row.pinned, 0);
  assert.equal(row.sort_order, 0);
});

test("migrations are idempotent and skip already-applied versions", () => {
  const db = new DatabaseSync(":memory:");
  initSchema(db); // fresh -> SCHEMA_VERSION
  const v1 = db.prepare("PRAGMA user_version").get().user_version;
  initSchema(db); // second run must be a no-op
  const v2 = db.prepare("PRAGMA user_version").get().user_version;
  assert.equal(v1, v2);
  assert.equal(v1, SCHEMA_VERSION);
});

test("v1 database (pinned present, no sort_order) upgrades to v2 only", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      name TEXT NOT NULL,
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE session_meta (
      session_id TEXT PRIMARY KEY,
      task_id TEXT,
      updated INTEGER NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.exec("PRAGMA user_version = 1");

  initSchema(db);

  assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  const cols = db.prepare("SELECT name FROM pragma_table_info('tasks')").all().map((r) => r.name);
  assert.ok(cols.includes("sort_order"));
  assert.equal(cols.filter((c) => c === "pinned").length, 1, "pinned not duplicated");
});

test("FTS5 trigram indexes Chinese substrings", () => {
  const db = memoryDb();
  db.prepare("INSERT INTO session_search(session_id, title, body) VALUES (?, ?, ?)")
    .run("s1", "修复登录接口", "hello world 你好");
  // 4-char query matches mid-token (unicode61 would fail this).
  const byMatch = db.prepare("SELECT session_id FROM session_search WHERE session_search MATCH ?")
    .all('"登录接口"');
  assert.deepEqual(byMatch.map((r) => r.session_id), ["s1"]);
});

test("FTS5 trigram short-query falls back to LIKE", () => {
  const db = memoryDb();
  db.prepare("INSERT INTO session_search(session_id, title, body) VALUES (?, ?, ?)")
    .run("s1", "修复登录接口", "做个登录页 hello world");
  // 2-char trigram MATCH misses entirely (needs >= 3 chars).
  const byMatch = db.prepare("SELECT session_id FROM session_search WHERE session_search MATCH ?")
    .all('"登录"');
  assert.equal(byMatch.length, 0, "2-char MATCH must not hit (documents the LIKE fallback need)");
  // LIKE on the FTS table is the short-query path — hits both columns.
  const byTitleLike = db.prepare("SELECT session_id FROM session_search WHERE title LIKE ?").all("%登录%");
  assert.equal(byTitleLike.length, 1);
  const byBodyLike = db.prepare("SELECT session_id FROM session_search WHERE body LIKE ?").all("%登录%");
  assert.equal(byBodyLike.length, 1);
  // LIKE stays case-insensitive-free for Latin (trigram) — plain contains check:
  const byEnglishLike = db.prepare("SELECT session_id FROM session_search WHERE body LIKE ?").all("%hello%");
  assert.equal(byEnglishLike.length, 1);
});

test("session_search keeps UNINDEXED session_id column distinct from content", () => {
  const db = memoryDb();
  db.prepare("INSERT INTO session_search(session_id, title, body) VALUES (?, ?, ?)")
    .run("s-a-b", "t1", "b1");
  db.prepare("INSERT INTO session_search(session_id, title, body) VALUES (?, ?, ?)")
    .run("s-x-y", "t2", "b2");
  const rows = db.prepare("SELECT session_id FROM session_search").all();
  assert.deepEqual(rows.map((r) => r.session_id), ["s-a-b", "s-x-y"]);
});