import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { getDb, setDbForTesting } = await jiti.import("./sqlite-db.ts");
const { createTask, deleteTask, listTasks, updateTask, taskForSession } = await jiti.import("./task-store.ts");

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