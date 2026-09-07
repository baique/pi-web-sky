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

test("loadSessionSummariesByIds：按 id 点查摘要（title/lastReply/自定义名），不存在跳过", async () => {
  freshDb();
  markIndexReady();
  const root = mkdtempSync(join(tmpdir(), "pi-sum-"));
  const projDir = join(root, "--home-u-p--");
  mkdirSync(projDir, { recursive: true });
  try {
    const cwd = "/home/u/p";
    // 有自定义名（尾部 session_info）
    const namedPath = join(projDir, "2026-01-01T00-00-00-000Z_named.jsonl");
    writeFileSync(namedPath, [
      `{"type":"session","version":3,"id":"named","timestamp":"2026-01-01T00:00:00.000Z","cwd":"${cwd}"}`,
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"首条"}}',
      '{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"回复内容"}]}}',
      '{"type":"session_info","id":"s1","parentId":"a1","name":"自定义标题"}',
    ].join("\n") + "\n");
    // 无自定义名
    const plainPath = join(projDir, "2026-01-02T00-00-00-000Z_plain.jsonl");
    writeFileSync(plainPath, [
      `{"type":"session","version":3,"id":"plain","timestamp":"2026-01-02T00:00:00.000Z","cwd":"${cwd}"}`,
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"无名字会话"}}',
      '{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"回复2"}]}}',
    ].join("\n") + "\n");
    // meta 索引行（path 指向文件）
    seedSession({ id: "named", cwd, projectKey: cwd, path: namedPath, firstMessage: "首条" });
    seedSession({ id: "plain", cwd, projectKey: cwd, path: plainPath, firstMessage: "无名字会话" });
    seedSession({ id: "ghost", cwd, projectKey: cwd, path: "/no/such/file.jsonl", firstMessage: "x" });

    const { loadSessionSummariesByIds } = await jiti.import("./session-reader.ts");
    const sessions = await loadSessionSummariesByIds(["named", "plain", "ghost", "missing-id"]);
    const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
    assert.equal(sessions.length, 2, "ghost(文件不存在) 与 missing-id 跳过");
    assert.equal(byId.named.name, "自定义标题", "自定义名来自文件尾 session_info");
    assert.equal(byId.named.lastReply, "回复内容");
    assert.equal(byId.plain.name, undefined, "无自定义名");
    assert.equal(byId.plain.lastReply, "回复2");
    assert.equal(byId.named.cwd, cwd);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadTaskSessionsPageWithIndex：任务列表标题与聊天同源（session_meta，不依赖文件存在）", async () => {
  freshDb();
  markIndexReady();
  // 文件都不存在（磁盘扫描快照外/已删）：标题必须仍能从 session_meta 读出，
  // 与聊天列表 loadProjectSessions 同源（旧实现 scanOneSessionFile 读文件 → 全跳过）。
  seedSession({ id: "a", cwd: "/home/u/p", projectKey: "/home/u/p", taskId: "task-1", firstMessage: "任务首条", path: "/no/such/a.jsonl", modified: 300 });
  seedSession({ id: "b", cwd: "/home/u/p", projectKey: "/home/u/p", taskId: "task-1", firstMessage: "另一条", path: "/no/such/b.jsonl", modified: 200 });
  // 非任务会话 → 不返回
  seedSession({ id: "c", cwd: "/home/u/p", projectKey: "/home/u/p", firstMessage: "游离", path: "/no/such/c.jsonl", modified: 100 });

  const { loadTaskSessionsPageWithIndex } = await jiti.import("./session-reader.ts");
  const index = {
    metaById: new Map([
      ["a", { path: "/no/such/a.jsonl", id: "a", modified: new Date(300) }],
      ["b", { path: "/no/such/b.jsonl", id: "b", modified: new Date(200) }],
    ]),
    childrenOf: new Map(),
  };
  const res = await loadTaskSessionsPageWithIndex("task-1", index, 0, 5);
  assert.equal(res.sessions.length, 2, "文件不存在但 meta 有行 → 仍返回（与聊天列表同源）");
  assert.equal(res.sessions[0].id, "a");
  assert.equal(res.sessions[0].firstMessage, "任务首条", "标题来自 session_meta.first_message");
  assert.equal(res.sessions[1].firstMessage, "另一条");
  assert.equal(res.sessions[0].name, undefined);
});
