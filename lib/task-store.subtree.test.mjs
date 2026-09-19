import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

// getAgentDir() 每次调用都读环境变量 → 指向临时树，测试绝不碰 ~/.pi/agent。
// sessions 子目录先建好：无行会话补行时会按 id 在这里找文件，miss 不回落扫开发机真实目录。
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-subtree-"));
mkdirSync(join(agentDir, "sessions"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false, alias: { "@": process.cwd() } });
const { setDbForTesting } = await jiti.import("./sqlite-db.ts");
const store = await jiti.import("./task-store.ts");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  setDbForTesting(db);
  return db;
}
// 造一个「任务 T + 根 A + 子树 A<-B<-C」的库内结构
function seedTree(db) {
  const task = store.createTask("/p", "T");
  const row = (id, taskId, parentId) => db.prepare(
    "INSERT INTO session_meta (session_id, task_id, updated, pinned, path, cwd, project_key, created, modified, parent_id) VALUES (?,?,?,0,?,?,?,?,?,?)",
  ).run(id, taskId, Date.now(), `/s/${id}.jsonl`, "/p", "/p", Date.now(), Date.now(), parentId);
  row("A", null, null); row("B", null, "A"); row("C", null, "B");
  return task;
}

test("listDescendantIds 按 parent_id 递归（不含自身，含多层）", () => {
  const db = freshDb(); seedTree(db);
  assert.deepEqual(store.listDescendantIds("A").sort(), ["B", "C"]);
  assert.deepEqual(store.listDescendantIds("C"), []);
});

test("agent/new 之外的归属：assignSessionSubtreeToTask 连带子树", async () => {
  const db = freshDb(); const task = seedTree(db);
  assert.equal(await store.assignSessionSubtreeToTask("A", task.id), true);
  const ids = db.prepare("SELECT session_id, task_id FROM session_meta ORDER BY session_id").all();
  assert.deepEqual(ids.map((r) => [r.session_id, r.task_id]), [["A", task.id], ["B", task.id], ["C", task.id]]);
});

test("归属守卫：祖先属于别的任务 → 拒绝且不写任何行（子树/单节点入口一致）", async () => {
  const db = freshDb(); const task = seedTree(db);
  const other = store.createTask("/p", "Other");
  // A 属于另一个任务 → C 的祖先链（C←B←A）上有非空且 ≠ 目标任务的 task_id
  db.prepare("UPDATE session_meta SET task_id = ? WHERE session_id = 'A'").run(other.id);
  const snapshot = () => db.prepare("SELECT session_id, task_id, updated FROM session_meta ORDER BY session_id").all()
    .map((r) => [r.session_id, r.task_id, r.updated]);
  const before = snapshot();
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.map(String).join(" "));
  try {
    assert.equal(await store.assignSessionSubtreeToTask("C", task.id), false, "子树入口拒绝");
    assert.equal(await store.assignSessionToTask("C", task.id), false, "单节点入口拒绝");
  } finally {
    console.error = original;
  }
  assert.deepEqual(snapshot(), before, "不写任何行（归属与 updated 都不变）");
  assert.equal(errors.length, 2, "拒绝必须 console.error 可见");
  assert.deepEqual(
    errors.map((e) => (/子树归属被拒绝/.test(e) ? "subtree" : "single")),
    ["subtree", "single"],
    "子树入口与单节点入口各自给出可见日志",
  );
  // 悬空祖先（行已不在库）不算冲突：C 就是根
  db.prepare("DELETE FROM session_meta WHERE session_id = 'A'").run();
  assert.equal(await store.assignSessionSubtreeToTask("C", task.id), true, "祖先行已不存在 → 允许（C 是根）");
  assert.equal(store.taskForSession("C"), task.id);
});

test("归属守卫：祖先只是聊天区会话（task_id NULL）→ 正常归属", async () => {
  const db = freshDb(); const task = seedTree(db);
  assert.equal(await store.assignSessionSubtreeToTask("C", task.id), true, "聊天区祖先不拦");
  assert.equal(store.taskForSession("C"), task.id);
  assert.equal(store.taskForSession("A"), null, "只归属自身 + 子树，祖先不动");
  assert.equal(store.taskForSession("B"), null);
});

test("归属守卫：祖先就在同一任务 → 正常（幂等，不误拦）", async () => {
  const db = freshDb(); const task = seedTree(db);
  db.prepare("UPDATE session_meta SET task_id = ? WHERE session_id IN ('A','B')").run(task.id);
  assert.equal(await store.assignSessionSubtreeToTask("C", task.id), true, "祖先同任务");
  assert.equal(store.taskForSession("C"), task.id);
  assert.equal(await store.assignSessionToTask("B", task.id), true, "重复归属幂等");
  assert.equal(store.taskForSession("B"), task.id);
});

test("reparentSessionChildren：子行 parent_id 同请求改写为祖父（或 NULL）", () => {
  const db = freshDb(); seedTree(db);
  store.reparentSessionChildren("B", "A");
  assert.equal(db.prepare("SELECT parent_id FROM session_meta WHERE session_id='C'").get().parent_id, "A", "子行接到祖父");
  store.reparentSessionChildren("A", null);
  assert.equal(db.prepare("SELECT parent_id FROM session_meta WHERE session_id='B'").get().parent_id, null, "祖父拿不到 → NULL");
});

test("updateTask 的 sessionIds 全量替换按子树闭包展开", () => {
  const db = freshDb(); const task = seedTree(db);
  store.updateTask(task.id, { sessionIds: ["A"] });          // 只给根，服务端要连带子树
  assert.equal(store.taskForSession("B"), task.id);
  store.updateTask(task.id, { sessionIds: [] });              // 清空 → 整棵子树回到聊天区
  assert.equal(store.taskForSession("A"), null);
  assert.equal(store.taskForSession("C"), null);
});

test("移出带子树的父会话：前端提交剩余成员列表（含子 id）也整树离开", () => {
  const db = freshDb(); const task = seedTree(db);
  store.updateTask(task.id, { sessionIds: ["A"] });          // A/B/C 全在任务
  assert.equal(store.taskForSession("C"), task.id);
  // 前端拖出父 A 时提交的是「剩余成员列表」（flat sessionIds 去掉 A，仍含子 id）
  store.updateTask(task.id, { sessionIds: ["B", "C"] });
  assert.equal(store.taskForSession("A"), null, "父离开任务");
  assert.equal(store.taskForSession("B"), null, "B 的祖先 A 不在成员集合里 → B 一起离开");
  assert.equal(store.taskForSession("C"), null, "C 跟随 B 一起离开（多层）");
});

test("祖先行已不存在（断链）时不剪：子会话仍可留在任务里当根", async () => {
  const db = freshDb(); const task = seedTree(db);
  await store.assignSessionSubtreeToTask("A", task.id);
  // A 已被删（B 的 parent_id 悬空）——此窗口内不得把 B/C 踢出任务（它们就是本任务的根）
  db.prepare("DELETE FROM session_meta WHERE session_id = 'A'").run();
  store.updateTask(task.id, { sessionIds: ["B", "C"] });
  assert.equal(store.taskForSession("B"), task.id);
  assert.equal(store.taskForSession("C"), task.id);
});

test("子会话不能单独移出：祖先仍是成员时子会话保持在任务内", () => {
  const db = freshDb(); const task = seedTree(db);
  store.updateTask(task.id, { sessionIds: ["A"] });          // A/B/C 全在任务
  // 前端拖出子会话 B 时提交的是 「flat 剩余成员列表」= filter(≠B) = ["A", "C"]（含祖先 A），
  // 闭包再把 B 纳入 → 成员集合不变。这是有意的不变量：子会话不能被单独移出任务。
  store.updateTask(task.id, { sessionIds: ["A", "C"] });
  assert.equal(store.taskForSession("A"), task.id, "祖先仍在任务");
  assert.equal(store.taskForSession("B"), task.id, "B 不能单飞（否则聊天区出现孤儿根）");
  assert.equal(store.taskForSession("C"), task.id);
});

test("ensureSessionMetaRow 传 taskId 时落归属，不传时保持 NULL", () => {
  freshDb();
  store.ensureSessionMetaRow("X", { path: "/s/X.jsonl", cwd: "/p", projectKey: "/p", taskId: "T1" });
  assert.equal(store.taskForSession("X"), "T1");
  store.ensureSessionMetaRow("Y", { path: "/s/Y.jsonl", cwd: "/p", projectKey: "/p" });
  assert.equal(store.taskForSession("Y"), null);
});

test("ensureSessionMetaRow 冲突路径不覆盖已有归属（第二次传别的 taskId 仍保留首个）", () => {
  const db = freshDb();
  store.ensureSessionMetaRow("X", { path: "/s/X.jsonl", cwd: "/p", projectKey: "/p", taskId: "T1" });
  store.ensureSessionMetaRow("X", { path: "/s/X2.jsonl", cwd: "/p2", projectKey: "/p2", taskId: "T2" });
  assert.equal(store.taskForSession("X"), "T1", "归属各自管：upsert 不覆盖");
  assert.equal(
    db.prepare("SELECT path FROM session_meta WHERE session_id = 'X'").get().path,
    "/s/X2.jsonl",
    "索引列照常刷新",
  );
});

test("ensureSessionMetaRow：不传 firstMessage 的 upsert 不擦已有首条消息（COALESCE）", () => {
  const db = freshDb();
  store.ensureSessionMetaRow("F", { path: "/s/F.jsonl", cwd: "/p", projectKey: "/p", firstMessage: "首条消息" });
  // 同 id 再 upsert（如 fork/重新落盘）但不带 firstMessage：旧写法会把首条消息擦成 NULL
  store.ensureSessionMetaRow("F", { path: "/s/F2.jsonl", cwd: "/p", projectKey: "/p" });
  const row = db.prepare("SELECT first_message, path FROM session_meta WHERE session_id = 'F'").get();
  assert.equal(row.first_message, "首条消息", "已有首条消息保留");
  assert.equal(row.path, "/s/F2.jsonl", "索引列照常刷新");
});
