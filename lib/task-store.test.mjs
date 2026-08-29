import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { getDb, setDbForTesting } = await jiti.import("./sqlite-db.ts");
const { createTask, deleteTask, listTasks, updateTask, taskForSession, assignSessionToTask, reorderTasks } = await jiti.import("./task-store.ts");

function freshDb() {
  setDbForTesting(new DatabaseSync(":memory:"));
}

// Seed a session_meta row directly — in real flow membership writes these
// rows, but a NULL-task row is exactly a temp session's state.
function seedSession(sessionId, taskId) {
  getDb()
    .prepare("INSERT INTO session_meta (session_id, task_id, updated) VALUES (?, ?, ?)")
    .run(sessionId, taskId, Date.now());
}

test("createTask and listTasks per project", () => {
  freshDb();
  const a = createTask("proj-a", " 重构登录 ");
  assert.equal(a.name, "重构登录");
  assert.deepEqual(a.sessionIds, []);
  createTask("proj-a", "另一任务");
  createTask("proj-b", "别项目");
  const names = listTasks("proj-a").map((t) => t.name).sort();
  assert.deepEqual(names, ["另一任务", "重构登录"]);
  assert.equal(listTasks("proj-b").length, 1);
  assert.equal(listTasks("proj-none").length, 0);
});

test("updateTask tracks membership diff without touching other tasks", () => {
  freshDb();
  const a = createTask("p", "A");
  const b = createTask("p", "B");
  seedSession("s1", null); // temp
  seedSession("s2", null); // temp
  seedSession("s3", b.id); // belongs to task B

  let updated = updateTask(a.id, { sessionIds: ["s1", "s3"] });
  // listTaskSessionIds 按 pinned DESC, updated DESC, rowid DESC 排序：
  // 同批分配时后插入的行在前，这里做顺序无关的集合断言。
  assert.deepEqual([...updated.sessionIds].sort(), ["s1", "s3"]);
  // s1 newly assigned, s3 moved away from B, B untouched otherwise.
  assert.equal(taskForSession("s1"), a.id);
  assert.equal(taskForSession("s3"), a.id);
  assert.equal(taskForSession("s2"), null);
  assert.deepEqual(listTasks("p").find((t) => t.id === b.id).sessionIds, []);

  // Replace: s1 falls back to temp, s3 kept.
  updated = updateTask(a.id, { sessionIds: ["s3"] });
  assert.deepEqual(updated.sessionIds, ["s3"]);
  assert.equal(taskForSession("s1"), null);
  assert.equal(taskForSession("s3"), a.id);

  // Rename only — membership untouched.
  updated = updateTask(a.id, { name: "改名任务" });
  assert.equal(updated.name, "改名任务");
  assert.deepEqual(updated.sessionIds, ["s3"]);

  // Pin sorting: pinned sessions float before unpinned regardless of recency.
  seedSession("sp", a.id);
  getDb().prepare("UPDATE session_meta SET pinned = 1 WHERE session_id = ?").run("sp");
  updated = updateTask(a.id, { sessionIds: ["sp", "s3", "s1"] });
  assert.deepEqual(updated.pinnedSessionIds, ["sp"]);
  assert.equal(updated.sessionIds[0], "sp");
});

test("deleteTask unassigns members and removes the task", () => {
  freshDb();
  const a = createTask("p", "A");
  seedSession("s1", null);
  updateTask(a.id, { sessionIds: ["s1"] });
  deleteTask(a.id);
  assert.equal(taskForSession("s1"), null);
  assert.equal(listTasks("p").length, 0);
  assert.equal(updateTask(a.id, { name: "x" }), null);
});

test("createTask validates input", () => {
  freshDb();
  assert.throws(() => createTask("", "x"), /projectKey is required/);
  assert.throws(() => createTask("p", "   "), /name must not be empty/);
});

test("updateTask returns null for unknown id and rejects empty rename", () => {
  freshDb();
  assert.equal(updateTask("nope", { name: "x" }), null);
  const a = createTask("p", "A");
  assert.throws(() => updateTask(a.id, { name: "  " }), /name must not be empty/);
});

test("assignSessionToTask attaches a session atomically and bumps the task's updated", () => {
  freshDb();
  const a = createTask("p", "A");
  seedSession("s1", null); // temp
  seedSession("s2", a.id); // already a member

  assert.equal(assignSessionToTask("s1", a.id), true);
  assert.equal(taskForSession("s1"), a.id);
  // 重复归属幂等：已是成员再归一次仍成功且不重复。
  assert.equal(assignSessionToTask("s2", a.id), true);

  const task = listTasks("p")[0];
  assert.deepEqual([...task.sessionIds].sort(), ["s1", "s2"]);
  assert.ok(task.updated >= task.created, "归属会刷新任务的 updated（排序用）");
});

test("assignSessionToTask returns false for a missing task without writing anything", () => {
  freshDb();
  seedSession("s1", null);
  assert.equal(assignSessionToTask("s1", "no-such-task"), false);
  assert.equal(taskForSession("s1"), null);
  assert.equal(listTasks("p").length, 0);
});

test("listTasks honors sort_order within each pinned region", () => {
  freshDb();
  const a = createTask("p", "A");
  const b = createTask("p", "B");
  const c = createTask("p", "C");
  // 默认 sort_order = 创建时间戳，按创建序稳定排列。
  assert.deepEqual(listTasks("p").map((t) => t.name), ["A", "B", "C"]);

  // 手动重排：C 置顶，A/B 非置顶区交换。
  updateTask(c.id, { pinned: true });
  reorderTasks("p", [b.id, a.id]); // 非置顶区顺序
  assert.deepEqual(listTasks("p").map((t) => t.name), ["C", "B", "A"]);
});

test("reorderTasks validates ownership and preserves region isolation", () => {
  freshDb();
  const a = createTask("p", "A");
  createTask("p", "B");
  createTask("other", "X"); // 别项目
  // 传入不属于该项目的 id → 抛错，事务回滚。
  const other = listTasks("other")[0];
  assert.throws(() => reorderTasks("p", [a.id, other.id]), /does not belong/);
  // 回滚后顺序未变。
  assert.deepEqual(listTasks("p").map((t) => t.name), ["A", "B"]);
});

test("updateTask supports sortOrder patch", () => {
  freshDb();
  const a = createTask("p", "A");
  const b = createTask("p", "B");
  // sortOrder 越小越靠前：A 设 99 后排在 B（时间戳）前面。
  updateTask(a.id, { sortOrder: 99 });
  assert.deepEqual(listTasks("p").map((t) => t.name), ["A", "B"]);
  // sortOrder 字段随任务返回。
  const task = listTasks("p").find((t) => t.id === a.id);
  assert.equal(task.sortOrder, 99);
  assert.equal(b.sortOrder > 0, true);
});

test("assignSessionToTask moves a session out of its previous task", () => {
  freshDb();
  const a = createTask("p", "A");
  const b = createTask("p", "B");
  seedSession("s1", null);
  assignSessionToTask("s1", a.id);
  assignSessionToTask("s1", b.id); // 移动到 B
  assert.equal(taskForSession("s1"), b.id);
  const taskA = listTasks("p").find((t) => t.id === a.id);
  assert.deepEqual(taskA.sessionIds, []);
});
