import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { DatabaseSync } from "node:sqlite";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { setDbForTesting, getDb } = await jiti.import("./sqlite-db.ts");
const { loadProjectSessions } = await jiti.import("./session-reader.ts");
const { resetSessionIndexScannerForTests } = await jiti.import("./session-index-scanner.ts");

function freshDb() {
  setDbForTesting(new DatabaseSync(":memory:"));
}

function seedSession({ id, cwd, projectKey, title = null, firstMessage = "msg", modified = 1000, pinned = 0, taskId = null, path = `/p/${id}.jsonl` }) {
  getDb().prepare(
    `INSERT INTO session_meta
       (session_id, task_id, updated, pinned, path, cwd, project_key, title, first_message, parent_id, created, modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(id, taskId, modified, pinned, path, cwd, projectKey, title, firstMessage, modified, modified);
}

// 置 ready：确保 ensureSessionIndexReady 不触发真实目录扫描。
function markIndexReady() {
  resetSessionIndexScannerForTests();
  globalThis.__piSessionIndexScanner = { timer: undefined, firstScanDone: true };
}

test("loadProjectSessions：只返回该项目非任务会话，置顶优先 + modified 降序", async () => {
  freshDb();
  markIndexReady();
  seedSession({ id: "a", cwd: "/home/u/p", projectKey: "/home/u/p", modified: 100, pinned: 0 });
  seedSession({ id: "b", cwd: "/home/u/p", projectKey: "/home/u/p", modified: 300, pinned: 1 });
  seedSession({ id: "c", cwd: "/home/u/p", projectKey: "/home/u/p", modified: 200, pinned: 0 });
  // 任务会话 → 排除
  seedSession({ id: "t", cwd: "/home/u/p", projectKey: "/home/u/p", modified: 500, taskId: "task-1" });
  // 其它项目 → 排除
  seedSession({ id: "other", cwd: "/home/u/q", projectKey: "/home/u/q", modified: 900 });

  const sessions = await loadProjectSessions("/home/u/p");
  assert.deepEqual(sessions.map((s) => s.id), ["b", "c", "a"], "置顶优先，其余 modified 降序");
  assert.ok(!sessions.some((s) => s.id === "t"), "任务会话排除");
  assert.ok(!sessions.some((s) => s.id === "other"), "其它项目排除");
});

test("loadProjectSessions：title→name，无自定义名回退 firstMessage", async () => {
  freshDb();
  markIndexReady();
  seedSession({ id: "named", cwd: "/home/u/p", projectKey: "/home/u/p", title: "自定义名", firstMessage: "首条", modified: 100 });
  seedSession({ id: "unnamed", cwd: "/home/u/p", projectKey: "/home/u/p", title: null, firstMessage: "未改名首条", modified: 200 });

  const sessions = await loadProjectSessions("/home/u/p");
  const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
  assert.equal(byId.named.name, "自定义名");
  assert.equal(byId.named.firstMessage, "首条");
  assert.equal(byId.unnamed.name, undefined, "无自定义名则 name 为空，前端回退 firstMessage");
  assert.equal(byId.unnamed.firstMessage, "未改名首条");
});

test("loadProjectSessions：空 projectKey / 无匹配返回空", async () => {
  freshDb();
  markIndexReady();
  assert.deepEqual(await loadProjectSessions(""), []);
  assert.deepEqual(await loadProjectSessions("/no/such/project"), []);
});

test("loadProjectSessions：返回 pinned 标记与 projectKey 字段", async () => {
  freshDb();
  markIndexReady();
  seedSession({ id: "pinned1", cwd: "/home/u/p", projectKey: "/home/u/p", modified: 100, pinned: 1 });
  const sessions = await loadProjectSessions("/home/u/p");
  assert.equal(sessions[0].pinned, true);
  assert.equal(sessions[0].projectKey, "/home/u/p");
});
