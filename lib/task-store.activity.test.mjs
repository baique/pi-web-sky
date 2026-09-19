import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
  alias: { "@": process.cwd() },
});
const { setDbForTesting } = await jiti.import("./sqlite-db.ts");
const {
  LAST_REPLY_MAX,
  fillFirstMessageIfEmpty,
  recordSessionOutcome,
  touchSessionActivity,
} = await jiti.import("./task-store.ts");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  setDbForTesting(db);
  return db;
}

/** 造一条「扫描器/创建链路建立」的完整行：写函数只允许改自己那一列。 */
function seedRow(db, sessionId) {
  db.prepare(
    `INSERT INTO session_meta
       (session_id, task_id, updated, pinned, path, cwd, project_key, title, first_message, parent_id, created, modified, last_reply)
     VALUES (?, NULL, 111, 0, ?, '/p', 'proj', '标题', NULL, NULL, 100, 200, NULL)`,
  ).run(sessionId, `/s/${sessionId}.jsonl`);
}

const rowOf = (db, sessionId) =>
  db.prepare("SELECT * FROM session_meta WHERE session_id = ?").get(sessionId);
const count = (db) => db.prepare("SELECT COUNT(*) AS c FROM session_meta").get().c;

test("touchSessionActivity 只刷 modified，不建行（无行时静默 no-op）", () => {
  const db = freshDb();
  seedRow(db, "s1");

  touchSessionActivity("s1", 5000);

  const row = rowOf(db, "s1");
  assert.equal(row.modified, 5000);
  // 其它列一律不动：活跃时间不是归属、不是上次改写时间、也不是内容。
  assert.equal(row.updated, 111);
  assert.equal(row.last_reply, null);
  assert.equal(row.first_message, null);
  assert.equal(row.path, "/s/s1.jsonl");
  assert.equal(row.pinned, 0);

  // 缺省参数 = 当前时间（事件链路不需要自己算时间戳）
  const before = Date.now();
  touchSessionActivity("s1");
  assert.ok(rowOf(db, "s1").modified >= before);

  // 库里没有这条会话 → 只影响 0 行，绝不因事件建局部行（V4 缺陷的回归锁）
  touchSessionActivity("no-such-session", 9999);
  assert.equal(count(db), 1);
});

test("recordSessionOutcome 写 last_reply + modified，超 4000 字符截断", () => {
  const db = freshDb();
  seedRow(db, "s2");

  recordSessionOutcome("s2", { lastReply: "最后一条回复", at: 7000 });

  let row = rowOf(db, "s2");
  assert.equal(row.last_reply, "最后一条回复");
  assert.equal(row.modified, 7000);
  assert.equal(row.updated, 111, "结果落库不当作一次归属改写");

  const long = "x".repeat(LAST_REPLY_MAX + 100);
  recordSessionOutcome("s2", { lastReply: long, at: 8000 });
  row = rowOf(db, "s2");
  assert.equal(row.last_reply.length, LAST_REPLY_MAX);
  assert.equal(row.last_reply, long.slice(0, LAST_REPLY_MAX));
  assert.equal(row.modified, 8000);
});

test("recordSessionOutcome 空文本不清库：只刷 modified，保留上一条回复", () => {
  const db = freshDb();
  seedRow(db, "s3");
  recordSessionOutcome("s3", { lastReply: "上一条回复", at: 1000 });

  // 刚发出就被取消 / 整轮只有工具调用：不许把 last_reply 写成空串
  recordSessionOutcome("s3", { lastReply: "", at: 9000 });
  let row = rowOf(db, "s3");
  assert.equal(row.last_reply, "上一条回复");
  assert.equal(row.modified, 9000);

  recordSessionOutcome("s3", { lastReply: "   \n\t ", at: 9500 });
  row = rowOf(db, "s3");
  assert.equal(row.last_reply, "上一条回复", "纯空白同样不算一条消息");

  // 从没存过回复的行：空文本保持 NULL（而不是被写成 "")
  seedRow(db, "s3b");
  recordSessionOutcome("s3b", { lastReply: "", at: 9600 });
  assert.equal(rowOf(db, "s3b").last_reply, null);

  // 无行 → 0 行，不建行
  recordSessionOutcome("no-such-session", { lastReply: "x", at: 1 });
  assert.equal(count(db), 2);
});

test("fillFirstMessageIfEmpty 只在为空时写入（已有 first_message 不被覆盖）", () => {
  const db = freshDb();
  seedRow(db, "s4");

  fillFirstMessageIfEmpty("s4", "第一条用户消息");
  assert.equal(rowOf(db, "s4").first_message, "第一条用户消息");

  fillFirstMessageIfEmpty("s4", "后来的消息");
  assert.equal(rowOf(db, "s4").first_message, "第一条用户消息", "首条消息只落一次");
  assert.equal(rowOf(db, "s4").modified, 200, "回填首条消息不动活跃时间");

  // '' 视为空（老行可能被写成空串）→ 允许回填
  db.prepare("UPDATE session_meta SET first_message = '' WHERE session_id = 's4'").run();
  fillFirstMessageIfEmpty("s4", "补上");
  assert.equal(rowOf(db, "s4").first_message, "补上");

  // 空白首条消息不写（避免把空串当成内容）
  seedRow(db, "s5");
  fillFirstMessageIfEmpty("s5", "  ");
  assert.equal(rowOf(db, "s5").first_message, null);

  // 无行 → 0 行，不建行
  fillFirstMessageIfEmpty("no-such-session", "x");
  assert.equal(count(db), 2);
});

test("三个写函数一律只 UPDATE：库里没行时不留任何新行", () => {
  const db = freshDb();

  touchSessionActivity("ghost", 1);
  recordSessionOutcome("ghost", { lastReply: "回复", at: 2 });
  fillFirstMessageIfEmpty("ghost", "首条");

  assert.equal(count(db), 0);
});
