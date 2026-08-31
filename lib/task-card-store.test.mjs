import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { getDb, setDbForTesting } = await jiti.import("./sqlite-db.ts");
const { getCard, listCards, createCard, updateCard, deleteCard } = await jiti.import("./task-card-store.ts");
const { createBoard, addNode } = await jiti.import("./board-store.ts");

function freshDb() {
  setDbForTesting(new DatabaseSync(":memory:"));
}

test("createCard 编号项目内自增，跨项目重新从 1", () => {
  freshDb();
  const b = createBoard("proj-a", "看板A");
  createBoard("proj-a", "看板B");
  createBoard("proj-b", "看板C");

  const c1 = createCard({ boardId: b.id, projectKey: "proj-a", name: "任务一" });
  const c2 = createCard({ boardId: b.id, projectKey: "proj-a", name: "任务二" });
  const c3 = createCard({ boardId: b.id, projectKey: "proj-a", name: "任务三" });
  const b2 = createBoard("proj-a", "看板B2");
  const cOtherProject = createCard({ boardId: b2.id, projectKey: "proj-b", name: "别项目" });

  assert.equal(c1.number, 1);
  assert.equal(c2.number, 2);
  assert.equal(c3.number, 3);
  assert.equal(cOtherProject.number, 1);
});

test("createCard 默认值与必填校验", () => {
  freshDb();
  const b = createBoard("proj-a", "看板A");
  const c = createCard({ boardId: b.id, projectKey: "proj-a", name: "  修复登录  " });
  assert.equal(c.name, "修复登录");
  assert.equal(c.readyStatus, "draft");
  assert.equal(c.execStatus, "not_started");
  assert.equal(c.priority, 0);
  assert.equal(c.due, null);
  assert.deepEqual(c.attachments, []);
  assert.equal(c.cwd, null);
  assert.equal(c.useWorktree, false);
  assert.equal(c.maxRetries, 3);
  assert.equal(c.retryCount, 0);
  assert.equal(c.sessionId, null);
  assert.throws(() => createCard({ boardId: b.id, projectKey: "proj-a", name: "  " }), /name must not be empty/);
});

test("listCards 按编号升序", () => {
  freshDb();
  const b = createBoard("proj-a", "看板A");
  createCard({ boardId: b.id, projectKey: "proj-a", name: "乙" });
  createCard({ boardId: b.id, projectKey: "proj-a", name: "甲" });
  const cards = listCards(b.id);
  assert.deepEqual(cards.map((c) => c.number), [1, 2]);
});

test("updateCard 改字段；getCard 不存在返回 undefined", () => {
  freshDb();
  const b = createBoard("proj-a", "看板A");
  const c = createCard({ boardId: b.id, projectKey: "proj-a", name: "任务" });

  const updated = updateCard(c.id, {
    name: "改名",
    readyStatus: "todo",
    execStatus: "running",
    priority: 1,
    due: 1700000000000,
    attachments: ["/a.md", "/b.md"],
    cwd: "/work",
    useWorktree: true,
    maxRetries: 5,
    sessionId: "sess-1",
    retryCount: 2,
  });
  assert.equal(updated.name, "改名");
  assert.equal(updated.readyStatus, "todo");
  assert.equal(updated.execStatus, "running");
  assert.equal(updated.priority, 1);
  assert.equal(updated.due, 1700000000000);
  assert.deepEqual(updated.attachments, ["/a.md", "/b.md"]);
  assert.equal(updated.cwd, "/work");
  assert.equal(updated.useWorktree, true);
  assert.equal(updated.maxRetries, 5);
  assert.equal(updated.retryCount, 2);
  assert.equal(updated.sessionId, "sess-1");
  assert.ok(updated.updated >= updated.created);

  assert.equal(updateCard("nope", { name: "x" }), null);
  assert.equal(getCard("nope"), undefined);
});

test("deleteCard 级联删 links/questions 与 taskcard node/边", () => {
  freshDb();
  const b = createBoard("proj-a", "看板A");
  const c1 = createCard({ boardId: b.id, projectKey: "proj-a", name: "卡1" });
  const c2 = createCard({ boardId: b.id, projectKey: "proj-a", name: "卡2" });

  // 画布节点（kind=taskcard, refId=cardId）与会话卡节点
  const n1 = addNode(b.id, { kind: "taskcard", refId: c1.id, x: 10, y: 10, w: 220, h: 120 });
  const n2 = addNode(b.id, { kind: "taskcard", refId: c2.id, x: 300, y: 10 });
  addNode(b.id, { kind: "session", refId: "sess-x", x: 0, y: 0 });

  // 直接 SQL 插依赖/问答行（Task 2/3 才提供 addLink/replaceLinks）
  const db = getDb();
  db.prepare("INSERT INTO task_card_links (id, card_id, target_card_id, kind, created) VALUES (?, ?, ?, ?, ?)")
    .run("l1", c1.id, c2.id, "prerequisite", Date.now());
  db.prepare("INSERT INTO task_card_questions (id, card_id, session_id, question, status, created) VALUES (?, ?, ?, ?, ?, ?)")
    .run("q1", c1.id, "sess-1", "问题", "pending", Date.now());
  // 依赖边
  db.prepare("INSERT INTO board_edges (id, board_id, from_id, to_id, label, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("e1", b.id, n1.id, n2.id, "prerequisite", Date.now(), Date.now());

  deleteCard(c1.id);

  assert.equal(getCard(c1.id), undefined);
  assert.equal(getCard(c2.id)?.name, "卡2"); // 其他卡保留
  const links = db.prepare("SELECT * FROM task_card_links").all();
  assert.equal(links.length, 0); // links 级联删
  const questions = db.prepare("SELECT * FROM task_card_questions").all();
  assert.equal(questions.length, 0); // questions 级联删
  const nodeRows = db.prepare("SELECT * FROM board_nodes WHERE id = ?").get(n1.id);
  assert.equal(nodeRows, undefined); // taskcard node 删
  const edgeRows = db.prepare("SELECT * FROM board_edges WHERE id = ?").get("e1");
  assert.equal(edgeRows, undefined); // 依赖边删
  const otherNode = db.prepare("SELECT * FROM board_nodes WHERE id = ?").get(n2.id);
  assert.ok(otherNode); // 其他节点保留
  const sessionNode = db.prepare("SELECT * FROM board_nodes WHERE ref_id = 'sess-x'").get();
  assert.ok(sessionNode); // 会话卡节点保留
});
