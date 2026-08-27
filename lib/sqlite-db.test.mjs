import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { initSchema } = await jiti.import("./sqlite-db.ts");

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