import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

// 隔离：临时 agentDir + :memory: 库；无行会话补全列行时会按 id 在临时 sessions 目录找文件，
// 绝不碰开发机真实的 ~/.pi/agent。
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-assign-route-"));
const sessionsDir = join(agentDir, "sessions", "--w-proj--");
mkdirSync(sessionsDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { setDbForTesting, getDb } = await jiti.import("@/lib/sqlite-db.ts");
const store = await jiti.import("@/lib/task-store.ts");
const { POST } = await jiti.import("./route.ts");

/** 真实会话文件：文件名带 id、header.id 一致（resolveSessionPath 的名字兜底能命中）。 */
function sessionFile(id) {
  const file = join(sessionsDir, `2026-09-18T00-00-00_${id}.jsonl`);
  writeFileSync(
    file,
    `${JSON.stringify({ type: "session", id, timestamp: "2026-09-18T00:00:00.000Z", cwd: "/w/proj" })}\n`,
  );
  return file;
}

function seedRow(id, parentId = null, taskId = null) {
  getDb()
    .prepare("INSERT INTO session_meta (session_id, task_id, updated, pinned, path, cwd, project_key, parent_id, created, modified) VALUES (?, ?, ?, 0, ?, '/w/proj', 'proj', ?, 1, 1)")
    .run(id, taskId, Date.now(), `/nonexistent/${id}.jsonl`, parentId);
}

const call = (taskId, body) =>
  POST(
    new Request("http://localhost/api/tasks/x/assign-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: taskId }) },
  );

beforeEach(() => setDbForTesting(new DatabaseSync(":memory:")));

test("assign-session：会话已归属 → 200，库内归属落定", async () => {
  const file = sessionFile("s-ok");
  const task = store.createTask("proj", "T");

  const res = await call(task.id, { sessionId: "s-ok" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(store.taskForSession("s-ok"), task.id);
  assert.equal(getDb().prepare("SELECT path FROM session_meta WHERE session_id='s-ok'").get().path, file);
});

test("assign-session：任务不存在 → 404，不写库", async () => {
  seedRow("s-1");
  const res = await call("no-such-task", { sessionId: "s-1" });
  assert.equal(res.status, 404);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM session_meta WHERE task_id IS NOT NULL").get().n, 0);
});

test("assign-session：祖先属于其它任务 → 409 + 原因（不再静默 200）", async () => {
  const task = store.createTask("proj", "T");
  const other = store.createTask("proj", "Other");
  seedRow("ancestor", null, other.id);
  seedRow("child", "ancestor");

  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.map(String).join(" "));
  try {
    const res = await call(task.id, { sessionId: "child" });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /ancestor belongs to another task/);
  } finally {
    console.error = original;
  }
  assert.equal(store.taskForSession("child"), null, "拒绝 → 不写任何归属");
  assert.equal(store.taskForSession("ancestor"), other.id, "祖先归属不动");
  assert.equal(errors.length, 0, "路由层先拦（409 本身就是可见失败），不重复落服务端日志");
});

test("assign-session：库里没行 + 磁盘父属别的任务 → 补行后仍 409（守卫不再对无行会话失明）", async () => {
  const task = store.createTask("proj", "T");
  const other = store.createTask("proj", "Other");
  // 父：库里有行且已归属别的任务（路径要真实，否则反查不到父 id）。
  const parentFile = sessionFile("anc-parent");
  getDb()
    .prepare("INSERT INTO session_meta (session_id, task_id, updated, pinned, path, cwd, project_key, parent_id, created, modified) VALUES ('anc-parent', ?, ?, 0, ?, '/w/proj', 'proj', NULL, 1, 1)")
    .run(other.id, Date.now(), parentFile);
  // 子：磁盘上有父指针，库里**没有行**——正是守卫此前看不见的那一类。
  const childFile = join(sessionsDir, "2026-09-18T00-00-00_anc-child.jsonl");
  writeFileSync(
    childFile,
    `${JSON.stringify({ type: "session", id: "anc-child", timestamp: "2026-09-18T00:00:00.000Z", cwd: "/w/proj", parentSession: parentFile })}\n`,
  );

  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.map(String).join(" "));
  try {
    const res = await call(task.id, { sessionId: "anc-child" });
    assert.equal(res.status, 409, "补行后才可见的祖先冲突也是 409（不是误导性的 404）");
  } finally {
    console.error = original;
  }
  assert.equal(store.taskForSession("anc-child"), null, "拒绝 → 不写归属");
  assert.equal(store.taskForSession("anc-parent"), other.id, "祖先归属不动");
  assert.equal(
    getDb().prepare("SELECT parent_id FROM session_meta WHERE session_id='anc-child'").get().parent_id,
    "anc-parent",
    "补行写入了 parent_id（守卫才看得见祖先）",
  );
  assert.ok(errors.some((line) => /祖先属于其它任务/.test(line)), "拒绝可见");
});

test("assign-session：会话解析不出（库内无行 + 无文件）→ 404", async () => {
  const task = store.createTask("proj", "T");
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.map(String).join(" "));
  try {
    const res = await call(task.id, { sessionId: "ghost-session" });
    assert.equal(res.status, 404);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1, "补行失败可见");
  assert.match(errors[0], /会话行补建失败/);
});

test("assign-session：sessionId 缺失 → 400", async () => {
  const task = store.createTask("proj", "T");
  const res = await call(task.id, {});
  assert.equal(res.status, 400);
});
