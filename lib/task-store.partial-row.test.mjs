import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

// getAgentDir() 每次调用都读环境变量 → 指向临时树，测试绝不碰 ~/.pi/agent。
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-partial-row-"));
const sessionsDir = join(agentDir, "sessions");
mkdirSync(sessionsDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { getDb, setDbForTesting } = await jiti.import("./sqlite-db.ts");
const store = await jiti.import("./task-store.ts");

/** 造一个真实会话文件：文件名带 id（按名可解析）、header.id 与之一致（header 权威）。
 *  parentPath 非空时写 header.parentSession（父链只在磁盘上时用）。 */
function writeSession(project, id, parentPath) {
  const dir = join(sessionsDir, project);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-09-18T00-00-00_${id}.jsonl`);
  writeFileSync(
    file,
    `${JSON.stringify({ type: "session", id, timestamp: "2026-09-18T00:00:00.000Z", cwd: join("/w", project), ...(parentPath ? { parentSession: parentPath } : {}) })}\n`,
  );
  return file;
}

function freshDb() {
  const db = new DatabaseSync(":memory:");
  setDbForTesting(db);
  return db;
}

function rowFor(sessionId) {
  return getDb().prepare("SELECT * FROM session_meta WHERE session_id = ?").get(sessionId);
}

/** 全列断言：缺 path/project_key/created 的局部行会在聊天区被 project_key 过滤掉、
 *  在任务区显示 1970 —— 正是本任务要根除的形态。 */
function assertFullRow(sessionId, filePath) {
  const row = rowFor(sessionId);
  assert.ok(row, `${sessionId} 必须建行`);
  assert.equal(row.path, filePath);
  assert.equal(row.cwd, "/w/alpha");
  assert.ok(row.project_key, "project_key 不能为空（否则被聊天区 project_key 过滤踢掉）");
  assert.ok(row.created > 0, "created 必须来自文件，不能是 0（1970）");
  assert.ok(row.modified > 0, "modified 必须来自文件");
  return row;
}

/** 断言 miss 场景的可见性时静音 console.error（测试输出保持干净），仍校验调用次数。 */
function captureConsoleError(t) {
  const original = console.error;
  const calls = [];
  console.error = (...args) => {
    calls.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.error = original;
  });
  return calls;
}

test("setSessionTitle 对无行会话建全列行（不再是只有 title 的局部行）", async () => {
  freshDb();
  const file = writeSession("alpha", "sess-title");

  await store.setSessionTitle("sess-title", "新名字");

  const row = assertFullRow("sess-title", file);
  assert.equal(row.title, "新名字");
  assert.equal(row.task_id, null);
  assert.equal(row.pinned, 0);
});

test("setSessionPinned 对无行会话建全列行（不再是只有 pinned 的局部行）", async () => {
  freshDb();
  const file = writeSession("alpha", "sess-pin");

  await store.setSessionPinned("sess-pin", true);

  const row = assertFullRow("sess-pin", file);
  assert.equal(row.pinned, 1);
  assert.equal(row.task_id, null);
});

test("assignSessionToTask 对无行会话先建全列行再写归属", async () => {
  freshDb();
  const file = writeSession("alpha", "sess-assign");
  const task = store.createTask("alpha-proj", "任务");

  assert.equal(await store.assignSessionToTask("sess-assign", task.id), true);

  const row = assertFullRow("sess-assign", file);
  assert.equal(row.task_id, task.id, "归属与本轮建行同一次写入完成");
});

test("assignSessionSubtreeToTask 对无行会话同样先建全列行（子树归属不静默写 0 行）", async () => {
  freshDb();
  const file = writeSession("alpha", "sess-subtree");
  const task = store.createTask("alpha-proj", "任务");

  assert.equal(await store.assignSessionSubtreeToTask("sess-subtree", task.id), true);

  const row = assertFullRow("sess-subtree", file);
  assert.equal(row.task_id, task.id);
});

test("已有行时不看文件：库里行在 → 改名/置顶照常写入（不因文件丢失而丢写）", async () => {
  const db = freshDb();
  db.prepare(
    "INSERT INTO session_meta (session_id, task_id, updated, pinned, path, cwd, project_key, created, modified) VALUES (?, NULL, ?, 0, ?, ?, ?, ?, ?)",
  ).run("sess-row-only", Date.now(), "/gone/sess-row-only.jsonl", "/w/alpha", "/w/alpha", 1, 2);

  await store.setSessionTitle("sess-row-only", "改名");
  await store.setSessionPinned("sess-row-only", true);

  const row = rowFor("sess-row-only");
  assert.equal(row.title, "改名");
  assert.equal(row.pinned, 1);
  assert.equal(row.path, "/gone/sess-row-only.jsonl", "既有索引列不被覆盖");
  assert.equal(row.project_key, "/w/alpha");
});

test("库里没行、磁盘也没文件 → 不写缺列局部行，报错可见", async (t) => {
  const db = freshDb();
  const logs = captureConsoleError(t);

  await store.setSessionTitle("sess-ghost", "幽灵改名");
  await store.setSessionPinned("sess-ghost", true);

  assert.equal(db.prepare("SELECT COUNT(*) c FROM session_meta").get().c, 0, "绝不退回插局部行");
  assert.equal(logs.length, 2, "两次写库各报一次错（失败可见，不静默）");
  for (const line of logs) assert.match(line, /sess-ghost/);
});

// ── 补行时的 parent_id（归属守卫的可见性）────────────────────────────────────
// 守卫（hasForeignTaskAncestor）只看库内 parent_id：库里还没行的会话，父链只在磁盘
// header 里——补行时不写父，跨任务祖先对守卫就是盲区（无行会话会被当成顶层行放行）。

test("无行会话补行时写 parent_id：磁盘父属别的任务 → 归属被拒绝（与「有行」路径同结论）", async (t) => {
  const db = freshDb();
  const logs = captureConsoleError(t);
  const parentFile = writeSession("alpha", "guard-parent");
  const other = store.createTask("alpha-proj", "别的任务");
  db.prepare(
    "INSERT INTO session_meta (session_id, task_id, updated, pinned, path, cwd, project_key, parent_id, created, modified) VALUES ('guard-parent', ?, 1, 0, ?, '/w/alpha', '/w/alpha', NULL, 1, 1)",
  ).run(other.id, parentFile);
  // 子会话：磁盘上有父指针，库里**没有行**（正是守卫此前看不见的那一类）。
  const childFile = writeSession("alpha", "guard-child", parentFile);
  const target = store.createTask("alpha-proj", "目标任务");

  const assigned = await store.assignSessionSubtreeToTask("guard-child", target.id);

  assert.equal(assigned, false, "祖先在别的任务 → 拒绝（返回 false 而不是静默归属）");
  assert.equal(store.taskForSession("guard-child"), null, "拒绝 → 不写归属");
  assert.equal(store.taskForSession("guard-parent"), other.id, "祖先归属不动");
  assert.ok(
    logs.some((line) => /祖先属于其它任务/.test(line)),
    "拒绝可见（console.error）",
  );
  const row = rowFor("guard-child");
  assert.ok(row, "补行照常完成（列齐全）");
  assert.equal(row.path, childFile);
  assert.equal(row.parent_id, "guard-parent", "补行时由磁盘 header.parentSession 反查写入父 id");
});

test("无行会话补行写 parent_id 的正向面：磁盘父属同一任务 → 归属成功且父链保持", async () => {
  const db = freshDb();
  const parentFile = writeSession("alpha", "same-parent");
  const task = store.createTask("alpha-proj", "同一个任务");
  db.prepare(
    "INSERT INTO session_meta (session_id, task_id, updated, pinned, path, cwd, project_key, parent_id, created, modified) VALUES ('same-parent', ?, 1, 0, ?, '/w/alpha', '/w/alpha', NULL, 1, 1)",
  ).run(task.id, parentFile);
  writeSession("alpha", "same-child", parentFile);

  assert.equal(await store.assignSessionSubtreeToTask("same-child", task.id), true);
  const row = rowFor("same-child");
  assert.equal(row.parent_id, "same-parent");
  assert.equal(row.task_id, task.id, "同任务祖先不构成冲突");
});

test("无行会话的父反查不到（父行未建/父文件已消失）→ parent_id 留空，不被当成冲突", async () => {
  const db = freshDb();
  writeSession("alpha", "orphan-child", join(sessionsDir, "alpha", "2026-09-18T00-00-00_gone.jsonl"));
  const task = store.createTask("alpha-proj", "任务");

  assert.equal(await store.assignSessionSubtreeToTask("orphan-child", task.id), true);
  const row = rowFor("orphan-child");
  assert.equal(row.parent_id, null, "反查不到 → undefined（不写悬空指针）");
  assert.equal(row.task_id, task.id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM session_meta").get().c, 1);
});
