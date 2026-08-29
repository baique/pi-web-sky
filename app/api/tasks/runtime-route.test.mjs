import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { setDbForTesting } = await jiti.import("@/lib/sqlite-db.ts");
const { GET: getTasks, POST: postTasks } = await jiti.import("./route.ts");
const { PATCH: patchTask, DELETE: deleteTask } = await jiti.import("./[id]/route.ts");
const { PUT: putReorder } = await jiti.import("./reorder/route.ts");

function freshDb() {
  setDbForTesting(new DatabaseSync(":memory:"));
}

test("tasks CRUD over the API", async () => {
  freshDb();

  // POST missing fields -> 400
  const badPost = await postTasks(new Request("http://localhost/api/tasks", {
    method: "POST",
    body: JSON.stringify({ projectKey: "" }),
  }));
  assert.equal(badPost.status, 400);

  // POST create
  const created = await postTasks(new Request("http://localhost/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectKey: "proj-x", name: "  重构登录  " }),
  }));
  assert.equal(created.status, 201);
  const { task } = await created.json();
  assert.equal(task.name, "重构登录");
  assert.deepEqual(task.sessionIds, []);

  // GET list by project
  const list = await getTasks(new Request("http://localhost/api/tasks?projectKey=proj-x"));
  const { tasks } = await list.json();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, task.id);
  const other = await getTasks(new Request("http://localhost/api/tasks?projectKey=other"));
  assert.equal((await other.json()).tasks.length, 0);

  // PATCH rename + membership replace
  const patchRes = await patchTask(
    new Request("http://localhost/api/tasks/x", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "改名", sessionIds: ["s1", "s2"] }),
    }),
    { params: Promise.resolve({ id: task.id }) },
  );
  assert.equal(patchRes.status, 200);
  const patched = (await patchRes.json()).task;
  assert.equal(patched.name, "改名");
  // listTaskSessionIds 按 pinned DESC, updated DESC, rowid DESC 排序（同批分配后插入在前），顺序无关断言。
  assert.deepEqual([...patched.sessionIds].sort(), ["s1", "s2"]);

  // PATCH unknown id -> 404
  const missing = await patchTask(
    new Request("http://localhost/api/tasks/x", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "y" }),
    }),
    { params: Promise.resolve({ id: "nope" }) },
  );
  assert.equal(missing.status, 404);

  // PATCH sortOrder
  const sortRes = await patchTask(
    new Request("http://localhost/api/tasks/x", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sortOrder: 42 }),
    }),
    { params: Promise.resolve({ id: task.id }) },
  );
  assert.equal(sortRes.status, 200);
  assert.equal((await sortRes.json()).task.sortOrder, 42);

  // PATCH bad sortOrder -> 400
  const badSort = await patchTask(
    new Request("http://localhost/api/tasks/x", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sortOrder: "x" }),
    }),
    { params: Promise.resolve({ id: task.id }) },
  );
  assert.equal(badSort.status, 400);

  // PUT /api/tasks/reorder — batch reorder
  const second = await postTasks(new Request("http://localhost/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectKey: "proj-x", name: "B" }),
  }));
  const secondTask = (await second.json()).task;
  const reorderRes = await putReorder(new Request("http://localhost/api/tasks/reorder", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectKey: "proj-x", orderedIds: [secondTask.id, task.id] }),
  }));
  assert.equal(reorderRes.status, 200);
  const reordered = (await reorderRes.json()).tasks;
  assert.deepEqual(reordered.map((t) => t.id), [secondTask.id, task.id]);

  // PUT reorder with foreign id -> 500 (transaction rollback)
  const foreign = await postTasks(new Request("http://localhost/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectKey: "other-proj", name: "X" }),
  }));
  const foreignTask = (await foreign.json()).task;
  const badReorder = await putReorder(new Request("http://localhost/api/tasks/reorder", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectKey: "proj-x", orderedIds: [secondTask.id, foreignTask.id] }),
  }));
  assert.equal(badReorder.status, 500);
  // 回滚后顺序不变。
  const afterRollback = await getTasks(new Request("http://localhost/api/tasks?projectKey=proj-x"));
  assert.deepEqual((await afterRollback.json()).tasks.map((t) => t.id), [secondTask.id, task.id]);

  // DELETE
  const del = await deleteTask(
    new Request("http://localhost/api/tasks/x", { method: "DELETE" }),
    { params: Promise.resolve({ id: task.id }) },
  );
  assert.equal(del.status, 200);
  const after = await getTasks(new Request("http://localhost/api/tasks?projectKey=proj-x"));
  // 只剩 reorder 测试创建的 secondTask。
  assert.deepEqual((await after.json()).tasks.map((t) => t.id), [secondTask.id]);
});