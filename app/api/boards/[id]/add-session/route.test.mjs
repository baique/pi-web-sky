import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

// 隔离：临时 agentDir + :memory: 库（无 yjsBoard 时落卡是空操作，route 仍返回 200）。
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-add-session-route-"));
mkdirSync(join(agentDir, "sessions"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { setDbForTesting, getDb } = await jiti.import("@/lib/sqlite-db.ts");
const store = await jiti.import("@/lib/task-store.ts");
const { createBoard } = await jiti.import("@/lib/board-store.ts");
const { POST } = await jiti.import("./route.ts");

function seedRow(id, parentId = null, taskId = null) {
  getDb()
    .prepare("INSERT INTO session_meta (session_id, task_id, updated, pinned, path, cwd, project_key, parent_id, created, modified) VALUES (?, ?, ?, 0, ?, '/w/proj', 'proj', ?, 1, 1)")
    .run(id, taskId, Date.now(), `/nonexistent/${id}.jsonl`, parentId);
}

const call = (boardId, body) =>
  POST(
    new Request("http://localhost/api/boards/x/add-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: boardId }) },
  );

beforeEach(() => setDbForTesting(new DatabaseSync(":memory:")));

test("add-session：手动看板（taskId=null）→ 200，归属不受影响", async () => {
  const board = createBoard("proj", "手动看板");
  seedRow("chatty");

  const res = await call(board.id, { sessionId: "chatty" });
  assert.equal(res.status, 200);
  assert.equal(store.taskForSession("chatty"), null, "落卡不是归属变更");
});

test("add-session：任务看板 + 祖先属于其它任务 → 409（未归属、不落卡）", async () => {
  const task = store.createTask("proj", "T");
  const other = store.createTask("proj", "Other");
  const board = createBoard("proj", "任务看板", task.id);
  seedRow("ancestor", null, other.id);
  seedRow("child", "ancestor");

  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.map(String).join(" "));
  try {
    const res = await call(board.id, { sessionId: "child" });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /ancestor belongs to another task/);
  } finally {
    console.error = original;
  }
  assert.equal(store.taskForSession("child"), null, "拒绝 → 归属不写");
  assert.equal(store.taskForSession("ancestor"), other.id);
  assert.equal(errors.length, 0, "路由层先拦，不产生额外日志噪音");
});

test("add-session：任务看板 + 会话可归属 → 200，归属先写", async () => {
  const task = store.createTask("proj", "T");
  const board = createBoard("proj", "任务看板", task.id);
  seedRow("free-session");

  const res = await call(board.id, { sessionId: "free-session" });
  assert.equal(res.status, 200);
  assert.equal(store.taskForSession("free-session"), task.id, "先归属（reconcile 依据业务表放行）");
});

test("add-session：看板不存在 → 404；sessionId 缺失 → 400", async () => {
  const missing = await call("no-such-board", { sessionId: "x" });
  assert.equal(missing.status, 404);
  const board = createBoard("proj", "手动看板");
  const bad = await call(board.id, { sessionId: "  " });
  assert.equal(bad.status, 400);
});
