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

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("loadSessionSummariesByIds：title/lastReply 取库（不读文件）", async () => {
  freshDb();
  markIndexReady();
  const root = mkdtempSync(join(tmpdir(), "pi-sum-"));
  const projDir = join(root, "--home-u-p--");
  mkdirSync(projDir, { recursive: true });
  try {
    const cwd = "/home/u/p";
    // 磁盘上有文件，但库行存在 → 库优先（title/lastReply/modified 全部不摸盘）
    const namedPath = join(projDir, "2026-01-01T00-00-00-000Z_named.jsonl");
    writeFileSync(namedPath, [
      `{"type":"session","version":3,"id":"named","timestamp":"2026-01-01T00:00:00.000Z","cwd":"${cwd}"}`,
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"首条"}}',
      '{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"文件里的回复"}]}}',
      '{"type":"session_info","id":"s1","parentId":"a1","name":"文件里的自定义标题"}',
    ].join("\n") + "\n");
    seedSession({ id: "named", cwd, projectKey: cwd, path: namedPath, title: "库里的标题", firstMessage: "首条" });
    getDb().prepare("UPDATE session_meta SET last_reply = ? WHERE session_id = 'named'").run("库里的回复");
    // 库内无行的 id（外部工具刚建）走文件兜底——那条路径需要 agentDir 隔离，
    // 已在 session-reader.noscan.test.mjs 里用空 agentDir 单独覆盖。

    const { loadSessionSummariesByIds } = await jiti.import("./session-reader.ts");
    const sessions = await loadSessionSummariesByIds(["named", "missing-id"]);
    const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
    assert.equal(sessions.length, 1, "missing-id 跳过");
    assert.equal(byId.named.name, "库里的标题", "title 取库（不读文件尾 session_info）");
    assert.equal(byId.named.lastReply, "库里的回复", "last_reply 取库（不读文件尾）");
    assert.equal(byId.named.cwd, cwd);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadTaskSessionsPage：任务列表标题与聊天同源（session_meta，不依赖文件存在）", async () => {
  freshDb();
  markIndexReady();
  // 文件都不存在（磁盘扫描快照外/已删）：标题/最后回复必须仍能从 session_meta 读出，
  // 与聊天列表 loadProjectSessions 同源（旧实现 buildTaskSessionIndex 扫盘 + scanOneSessionFile 读文件 → 全跳过）。
  seedSession({ id: "a", cwd: "/home/u/p", projectKey: "/home/u/p", taskId: "task-1", firstMessage: "任务首条", path: "/no/such/a.jsonl", modified: 300 });
  seedSession({ id: "b", cwd: "/home/u/p", projectKey: "/home/u/p", taskId: "task-1", firstMessage: "另一条", path: "/no/such/b.jsonl", modified: 200 });
  // 非任务会话 → 不返回
  seedSession({ id: "c", cwd: "/home/u/p", projectKey: "/home/u/p", firstMessage: "游离", path: "/no/such/c.jsonl", modified: 100 });

  const { loadTaskSessionsPage } = await jiti.import("./session-reader.ts");
  const res = await loadTaskSessionsPage("task-1", 0, 5);
  assert.equal(res.sessions.length, 2, "文件不存在但 meta 有行 → 仍返回（与聊天列表同源）");
  assert.equal(res.rootTotal, 2, "两个根（库内无父子关系）");
  const byId = Object.fromEntries(res.sessions.map((s) => [s.id, s]));
  assert.equal(byId.a.firstMessage, "任务首条", "标题来自 session_meta.first_message");
  assert.equal(byId.b.firstMessage, "另一条");
  assert.equal(byId.a.name, undefined);
});

test("loadProjectSessions：first_message 空且文件有首条消息 → 仍不读文件（回填已挪出读取路径）", async () => {
  freshDb();
  markIndexReady();
  const root = mkdtempSync(join(tmpdir(), "pi-lazy-"));
  const projDir = join(root, "--home-u-p--");
  mkdirSync(projDir, { recursive: true });
  try {
    const cwd = "/home/u/p";
    // 有消息但 meta 未同步（persist 建行冻结场景）：旧实现列表 GET 会读文件头并回写库，
    // 现在读取路径不摸盘——回填由扫描器（index 列）/事件链路负责，列表只呈现库里的事实。
    const file = join(projDir, "2026-01-01T00-00-00-000Z_a.jsonl");
    writeFileSync(file, [
      `{"type":"session","version":3,"id":"a","timestamp":"2026-01-01T00:00:00.000Z","cwd":"${cwd}"}`,
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"lazy 首条"}}',
    ].join("\n") + "\n");
    seedSession({ id: "a", cwd, projectKey: cwd, path: file, firstMessage: null });

    const { loadProjectSessions } = await jiti.import("./session-reader.ts");
    const sessions = await loadProjectSessions(cwd);
    assert.equal(sessions[0].firstMessage, "(no messages)", "列表不读文件头");
    const row = getDb().prepare("SELECT first_message FROM session_meta WHERE session_id='a'").get();
    assert.equal(row.first_message, null, "列表 GET 不回写库");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadSessionDetailsFromMeta：任务列表同样不读文件（标题来自库，不 lazy 回写）", async () => {
  freshDb();
  markIndexReady();
  const root = mkdtempSync(join(tmpdir(), "pi-lazy-task-"));
  const projDir = join(root, "--home-u-p--");
  mkdirSync(projDir, { recursive: true });
  try {
    const cwd = "/home/u/p";
    const file = join(projDir, "2026-01-01T00-00-00-000Z_a.jsonl");
    writeFileSync(file, [
      `{"type":"session","version":3,"id":"a","timestamp":"2026-01-01T00:00:00.000Z","cwd":"${cwd}"}`,
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"任务 lazy 首条"}}',
    ].join("\n") + "\n");
    seedSession({ id: "a", cwd, projectKey: cwd, path: file, firstMessage: null, taskId: "task-1" });

    const { loadSessionDetailsFromMeta } = await jiti.import("./session-reader.ts");
    const sessions = await loadSessionDetailsFromMeta(["a"]);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].firstMessage, "(no messages)", "任务列表也不读文件");
    const row = getDb().prepare("SELECT first_message FROM session_meta WHERE session_id='a'").get();
    assert.equal(row.first_message, null, "不回写");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
