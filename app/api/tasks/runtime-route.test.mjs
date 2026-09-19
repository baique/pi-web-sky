import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

// 隔离：PATCH 的 sessionIds 现在由路由层 ensureSessionRows 补全列行（会按 id 找会话文件），
// 临时 agentDir 保证测试不扫开发机真实的 ~/.pi/agent/sessions。
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-tasks-route-"));
const sessionsDir = join(agentDir, "sessions", "proj-x");
mkdirSync(sessionsDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

/** 真实会话文件：filename 带 id、header.id 一致（resolveSessionPath 按名命中）。 */
function sessionFile(id) {
  const file = join(sessionsDir, `2026-09-18T00-00-00_${id}.jsonl`);
  writeFileSync(
    file,
    `${JSON.stringify({ type: "session", id, timestamp: "2026-09-18T00:00:00.000Z", cwd: "/w/proj-x" })}\n`,
  );
  return file;
}

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { setDbForTesting, getDb } = await jiti.import("@/lib/sqlite-db.ts");
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

  // PATCH rename + membership replace（s1/s2 库里本来无行：由路由层 ensureSessionRows 建）
  const s1File = sessionFile("s1");
  const s2File = sessionFile("s2");
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
  // updateTask 的加侧只 UPDATE（不再插缺列局部行）→ 行必须由路由层补成全列行。
  for (const [sid, file] of [["s1", s1File], ["s2", s2File]]) {
    const row = getDb().prepare("SELECT * FROM session_meta WHERE session_id = ?").get(sid);
    assert.ok(row, `${sid} 行必须被建出`);
    assert.equal(row.path, file);
    assert.ok(row.project_key, "project_key 非空（缺列行会被聊天区 project_key 过滤掉）");
    assert.ok(row.created > 0, "created 不能是 0（任务区显示 1970）");
  }

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