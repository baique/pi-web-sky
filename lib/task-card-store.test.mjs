import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { getDb, setDbForTesting } = await jiti.import("./sqlite-db.ts");
const { getCard, listCards, createCard, updateCard, deleteCard, addLink, removeLink, replaceLinks, listLinks, listDispatchableCards, countRunningDispatched, createQuestion, listQuestions, listCardQuestions, answerQuestion, countPendingQuestions, listAnswerableQuestions } = await jiti.import("./task-card-store.ts");
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

test("addLink 同看板校验、自环拒绝、重复幂等", () => {
  freshDb();
  const b1 = createBoard("proj-a", "看板A");
  const b2 = createBoard("proj-b", "看板B");
  const c1 = createCard({ boardId: b1.id, projectKey: "proj-a", name: "卡1" });
  const c2 = createCard({ boardId: b1.id, projectKey: "proj-a", name: "卡2" });
  const cOther = createCard({ boardId: b2.id, projectKey: "proj-b", name: "异板卡" });

  assert.equal(addLink(c1.id, cOther.id, "prerequisite"), null); // 跨看板拒绝
  assert.equal(addLink(c1.id, c1.id, "prerequisite"), null);     // 自环拒绝
  const link = addLink(c1.id, c2.id, "prerequisite");
  assert.ok(link);
  assert.equal(link.kind, "prerequisite");
  // 重复添加：幂等（UNIQUE 冲突不报错，返回已有）
  const again = addLink(c1.id, c2.id, "prerequisite");
  assert.equal(again?.targetCardId, c2.id);
  assert.equal(listLinks(c1.id).length, 1);
  // 同对可加不同 kind
  addLink(c1.id, c2.id, "related");
  assert.equal(listLinks(c1.id).length, 2);
});

test("removeLink / replaceLinks 全量替换", () => {
  freshDb();
  const b = createBoard("proj-a", "看板A");
  const c1 = createCard({ boardId: b.id, projectKey: "proj-a", name: "卡1" });
  const c2 = createCard({ boardId: b.id, projectKey: "proj-a", name: "卡2" });
  const c3 = createCard({ boardId: b.id, projectKey: "proj-a", name: "卡3" });

  addLink(c1.id, c2.id, "prerequisite");
  addLink(c1.id, c3.id, "related");
  replaceLinks(c1.id, [c3.id], [c2.id]);
  const pre = listLinks(c1.id).filter((l) => l.kind === "prerequisite");
  const rel = listLinks(c1.id).filter((l) => l.kind === "related");
  assert.deepEqual(pre.map((l) => l.targetCardId), [c3.id]);
  assert.deepEqual(rel.map((l) => l.targetCardId), [c2.id]);

  removeLink(pre[0].id);
  assert.equal(listLinks(c1.id).filter((l) => l.kind === "prerequisite").length, 0);
  replaceLinks(c1.id, [], []);
  assert.equal(listLinks(c1.id).length, 0);
});

test("listDispatchableCards 前置过滤 + 就绪/重试条件", () => {
  freshDb();
  const b = createBoard("proj-a", "看板A");
  const pre = createCard({ boardId: b.id, projectKey: "proj-a", name: "前置" });
  const dep = createCard({ boardId: b.id, projectKey: "proj-a", name: "依赖卡" });
  const free = createCard({ boardId: b.id, projectKey: "proj-a", name: "自由卡" });
  const draft = createCard({ boardId: b.id, projectKey: "proj-a", name: "草稿卡" });
  const overRetry = createCard({ boardId: b.id, projectKey: "proj-a", name: "超重试卡" });
  const retryable = createCard({ boardId: b.id, projectKey: "proj-a", name: "可重试卡" });

  // 依赖卡挂在前置上（前置未完成 → 不可派发）
  addLink(dep.id, pre.id, "prerequisite");

  updateCard(free.id, { readyStatus: "todo" });
  updateCard(dep.id, { readyStatus: "todo" });
  // pre 保持 draft（不就绪）——dep 的前置检查只看 pre.execStatus
  updateCard(overRetry.id, { readyStatus: "todo", execStatus: "failed", retryCount: 3, maxRetries: 3 });
  updateCard(retryable.id, { readyStatus: "todo", execStatus: "failed", retryCount: 1, maxRetries: 3 });

  let ids = listDispatchableCards().map((c) => c.id).sort();
  assert.deepEqual(ids, [free.id, retryable.id].sort()); // dep 前置未完成、draft 不就绪、overRetry 超上限

  // 前置完成 → dep 可派发
  updateCard(pre.id, { execStatus: "done", readyStatus: "todo" });
  ids = listDispatchableCards().map((c) => c.id).sort();
  assert.ok(ids.includes(dep.id));
  assert.ok(ids.includes(free.id));
  assert.ok(ids.includes(retryable.id));
  assert.ok(!ids.includes(draft.id));
  assert.ok(!ids.includes(overRetry.id));
  assert.ok(!ids.includes(pre.id)); // done 不重复派发
});

test("countRunningDispatched 只数 running 卡", () => {
  freshDb();
  const b = createBoard("proj-a", "看板A");
  const c1 = createCard({ boardId: b.id, projectKey: "proj-a", name: "跑" });
  const c2 = createCard({ boardId: b.id, projectKey: "proj-a", name: "审" });
  const c3 = createCard({ boardId: b.id, projectKey: "proj-a", name: "停" });
  updateCard(c1.id, { execStatus: "running" });
  updateCard(c2.id, { execStatus: "review" });
  updateCard(c3.id, { execStatus: "failed" });
  assert.equal(countRunningDispatched(), 1);
  updateCard(c1.id, { execStatus: "done" });
  assert.equal(countRunningDispatched(), 0);
});

test("addLink 目标卡不存在返回 null；replaceLinks 自环/跨看板抛错", () => {
  freshDb();
  const b = createBoard("proj-a", "看板A");
  const c1 = createCard({ boardId: b.id, projectKey: "proj-a", name: "卡1" });
  assert.equal(addLink(c1.id, "no-such-card", "prerequisite"), null);

  assert.throws(() => replaceLinks(c1.id, [c1.id], []), /不能是自身/);
  const b2 = createBoard("proj-b", "看板B");
  const cOther = createCard({ boardId: b2.id, projectKey: "proj-b", name: "异板卡" });
  assert.throws(() => replaceLinks(c1.id, [cOther.id], []), /不允许跨看板/);
  assert.throws(() => replaceLinks(c1.id, ["no-such-card"], []), /not found/);
  assert.equal(listLinks(c1.id).length, 0); // 抛错后无残留
});

test("问答：建/列/答/计数 + listAnswerableQuestions camelCase 回归", () => {
  freshDb();
  const b = createBoard("proj-a", "看板A");
  const c1 = createCard({ boardId: b.id, projectKey: "proj-a", name: "等回复" });
  const c2 = createCard({ boardId: b.id, projectKey: "proj-a", name: "普通" });
  updateCard(c1.id, { execStatus: "waiting_reply", sessionId: "sess-1" });

  const q1 = createQuestion(c1.id, "sess-1", "提问一");
  const q2 = createQuestion(c2.id, "sess-2", "提问二");
  assert.equal(countPendingQuestions(), 2);
  assert.equal(listQuestions("pending").length, 2);
  assert.equal(listCardQuestions(c1.id).length, 1);

  // 回答 c1 的提问
  const answered = answerQuestion(q1.id, "继续");
  assert.equal(answered?.status, "answered");
  assert.equal(answered?.answer, "继续");
  assert.equal(countPendingQuestions(), 1);

  // 回答后 c1 仍 waiting_reply → listAnswerableQuestions 应返回（camelCase 字段可读）
  const answerable = listAnswerableQuestions();
  assert.equal(answerable.length, 1);
  assert.equal(answerable[0].cardId, c1.id);
  assert.equal(answerable[0].sessionId, "sess-1");
  assert.equal(answerable[0].answer, "继续");

  // c1 续会话转 running 后不再可答
  updateCard(c1.id, { execStatus: "running" });
  assert.equal(listAnswerableQuestions().length, 0);

  // 重复回答幂等
  const again = answerQuestion(q1.id, "再答");
  assert.equal(again?.answer, "继续");
});
