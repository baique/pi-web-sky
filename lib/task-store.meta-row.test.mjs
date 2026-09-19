import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

// getAgentDir() 每次调用都读环境变量 → 指向临时树，测试绝不碰 ~/.pi/agent。
// sessions 子目录先建好：无行会话补行时会按 id 在这里找文件，miss 不回落扫开发机真实目录。
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-meta-row-"));
mkdirSync(join(agentDir, "sessions"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { getDb, setDbForTesting } = await jiti.import("./sqlite-db.ts");
const { ensureSessionMetaRow, assignSessionToTask, setSessionTitle, unassignSession, createTask } = await jiti.import("./task-store.ts");

function freshDb() {
  setDbForTesting(new DatabaseSync(":memory:"));
  const db = getDb();
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

test("ensureSessionMetaRow 建全列索引行（新建会话落盘即建行）", () => {
  const db = freshDb();
  ensureSessionMetaRow("sess-1", {
    path: "/proj/sessions/sess-1.jsonl",
    cwd: "/proj",
    projectKey: "proj",
    parentId: undefined,
  });
  const row = db.prepare("SELECT * FROM session_meta WHERE session_id = ?").get("sess-1");
  assert.ok(row);
  assert.equal(row.path, "/proj/sessions/sess-1.jsonl");
  assert.equal(row.cwd, "/proj");
  assert.equal(row.project_key, "proj");
  assert.equal(row.task_id, null);
  assert.equal(row.pinned, 0);
  assert.ok(row.created > 0);
  assert.ok(row.modified > 0);
});

test("ensureSessionMetaRow 后 assignSessionToTask 只补归属、不破坏索引列", async () => {
  const db = freshDb();
  ensureSessionMetaRow("sess-2", {
    path: "/p2/sessions/sess-2.jsonl",
    cwd: "/p2",
    projectKey: "p2",
  });
  const task = createTask("p2", "t");
  assert.equal(await assignSessionToTask("sess-2", task.id), true);
  const row = db.prepare("SELECT * FROM session_meta WHERE session_id = ?").get("sess-2");
  assert.equal(row.task_id, task.id);
  assert.equal(row.path, "/p2/sessions/sess-2.jsonl");
  assert.equal(row.project_key, "p2");
});

test("ensureSessionMetaRow 后 setSessionTitle 只补标题、不破坏索引列", async () => {
  const db = freshDb();
  ensureSessionMetaRow("sess-3", {
    path: "/p3/sessions/sess-3.jsonl",
    cwd: "/p3",
    projectKey: "p3",
  });
  await setSessionTitle("sess-3", "新标题");
  const row = db.prepare("SELECT * FROM session_meta WHERE session_id = ?").get("sess-3");
  assert.equal(row.title, "新标题");
  assert.equal(row.path, "/p3/sessions/sess-3.jsonl");
  assert.equal(row.project_key, "p3");
});

test("ensureSessionMetaRow 写全 13 列（last_reply 显式 NULL，不依赖建表默认值）", () => {
  const db = freshDb();
  ensureSessionMetaRow("sess-13", { path: "/p13/x.jsonl", cwd: "/p13", projectKey: "p13" });
  const columns = db.prepare("PRAGMA table_info(session_meta)").all();
  assert.equal(columns.length, 13, "session_meta 契约是 13 列（v12）");
  const row = db.prepare("SELECT * FROM session_meta WHERE session_id = ?").get("sess-13");
  assert.equal(Object.keys(row).length, 13, "行值对象覆盖全部列");
  assert.equal(row.last_reply, null);
});

test("unassignSession 删行后 ensureSessionMetaRow 可重建（幂等）", () => {
  const db = freshDb();
  ensureSessionMetaRow("sess-4", { path: "/p4/x.jsonl", cwd: "/p4", projectKey: "p4" });
  unassignSession("sess-4");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM session_meta WHERE session_id = ?").get("sess-4").c, 0);
  ensureSessionMetaRow("sess-4", { path: "/p4/x.jsonl", cwd: "/p4", projectKey: "p4" });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM session_meta WHERE session_id = ?").get("sess-4").c, 1);
});
