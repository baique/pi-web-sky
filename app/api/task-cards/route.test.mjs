import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { setDbForTesting } = await jiti.import("@/lib/sqlite-db.ts");
const { GET: listTaskCards, POST: createTaskCard } = await jiti.import("./route.ts");
const { GET: getTaskCard, PATCH: patchTaskCard, DELETE: deleteTaskCard } = await jiti.import("./[id]/route.ts");
const { createBoard } = await jiti.import("@/lib/board-store.ts");
const { listCards, listLinks } = await jiti.import("@/lib/task-card-store.ts");

const PROJECT = "proj-api";

function freshDb() {
  setDbForTesting(new DatabaseSync(":memory:"));
}

function jsonReq(url, method, body) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("POST 建卡：card 落库（画布节点在 sync.db，不写 board_nodes），编号自增", async () => {
  freshDb();
  const b = createBoard(PROJECT, "看板A");
  const r1 = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b.id, name: "任务一" }));
  assert.equal(r1.status, 201);
  const j1 = await r1.json();
  assert.equal(j1.card.number, 1);
  assert.equal(j1.card.name, "任务一");
  assert.equal(j1.card.readyStatus, "todo"); // 建卡即派发（默认 todo，可调度）

  const r2 = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b.id, name: "任务二", readyStatus: "todo" }));
  const j2 = await r2.json();
  assert.equal(j2.card.number, 2);
  assert.equal(j2.card.readyStatus, "todo");

  // 不再写 board_nodes：task_cards 表才是真相源
  const cards = listCards(b.id);
  assert.equal(cards.length, 2);
});

test("GET 列表：不带 nodeId；GET 单卡：links + inbound 两向", async () => {
  freshDb();
  const b = createBoard(PROJECT, "看板A");
  const r1 = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b.id, name: "A" }));
  const r2 = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b.id, name: "B" }));
  const { card: c1 } = await r1.json();
  const { card: c2 } = await r2.json();

  const listRes = await listTaskCards(new Request("http://localhost/api/task-cards?boardId=" + b.id));
  const { cards } = await listRes.json();
  assert.equal(cards.length, 2);
  assert.equal(cards[0].nodeId, undefined); // nodeId 概念废弃

  // PATCH 加依赖
  await patchTaskCard(jsonReq(`http://localhost/api/task-cards/${c1.id}`, "PATCH", { prerequisites: [c2.id] }), { params: Promise.resolve({ id: c1.id }) });

  const single = await getTaskCard(new Request(`http://localhost/api/task-cards/${c1.id}`), { params: Promise.resolve({ id: c1.id }) });
  const j = await single.json();
  assert.equal(j.card.id, c1.id);
  assert.deepEqual(j.links.map((l) => l.targetCardId), [c2.id]);
  assert.equal(j.links[0].kind, "prerequisite");
  // c2 的 inbound 含 c1
  const single2 = await getTaskCard(new Request(`http://localhost/api/task-cards/${c2.id}`), { params: Promise.resolve({ id: c2.id }) });
  const j2 = await single2.json();
  assert.deepEqual(j2.inbound.map((l) => l.cardId), [c1.id]);
  // 依赖线由前端 reconcile 渲染（不再写 board_edges）
  const { listLinks: ll } = await jiti.import("@/lib/task-card-store.ts");
  assert.equal(ll(c1.id).length, 1);
});

test("PATCH 字段更新 + 依赖替换；DELETE 级联清空（含 links）", async () => {
  freshDb();
  const b = createBoard(PROJECT, "看板A");
  const r1 = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b.id, name: "A" }));
  const r2 = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b.id, name: "B" }));
  const r3 = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b.id, name: "C" }));
  const { card: c1 } = await r1.json();
  const { card: c2 } = await r2.json();
  const { card: c3 } = await r3.json();

  await patchTaskCard(jsonReq(`http://localhost/api/task-cards/${c1.id}`, "PATCH", {
    name: "改名", priority: 1, readyStatus: "todo", prerequisites: [c2.id], related: [c3.id],
  }), { params: Promise.resolve({ id: c1.id }) });
  const after = await getTaskCard(new Request(`http://localhost/api/task-cards/${c1.id}`), { params: Promise.resolve({ id: c1.id }) });
  const j = await after.json();
  assert.equal(j.card.name, "改名");
  assert.equal(j.card.priority, 1);
  assert.equal(j.card.readyStatus, "todo");
  assert.equal(j.links.length, 2);

  // 依赖改 target → 旧 prerequisite 替换
  await patchTaskCard(jsonReq(`http://localhost/api/task-cards/${c1.id}`, "PATCH", { prerequisites: [c3.id], related: [] }), { params: Promise.resolve({ id: c1.id }) });
  const j1 = await (await getTaskCard(new Request(`http://localhost/api/task-cards/${c1.id}`), { params: Promise.resolve({ id: c1.id }) })).json();
  assert.equal(j1.links.filter((l) => l.kind === "prerequisite").length, 1);
  assert.equal(j1.links.find((l) => l.kind === "prerequisite").targetCardId, c3.id);
  assert.equal(j1.links.filter((l) => l.kind === "related").length, 0);

  // DELETE 级联：card + links 全消失
  const del = await deleteTaskCard(new Request(`http://localhost/api/task-cards/${c1.id}`, { method: "DELETE" }), { params: Promise.resolve({ id: c1.id }) });
  assert.equal(del.status, 200);
  const gone = await getTaskCard(new Request(`http://localhost/api/task-cards/${c1.id}`), { params: Promise.resolve({ id: c1.id }) });
  assert.equal(gone.status, 404);
  assert.equal(listCards(b.id).length, 2); // c2/c3 保留
  assert.equal(listLinks(c1.id).length, 0);
});

test("校验：name 空 400、跨看板依赖 400、board 不存在 404", async () => {
  freshDb();
  const b1 = createBoard(PROJECT, "看板A");
  const b2 = createBoard("other-proj", "看板B");
  const r1 = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b1.id, name: "A" }));
  const { card: c1 } = await r1.json();
  const r2 = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b2.id, name: "B" }));
  const { card: c2 } = await r2.json();

  const badName = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b1.id, name: "  " }));
  assert.equal(badName.status, 400);
  const noBoard = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: "nope", name: "X" }));
  assert.equal(noBoard.status, 404);
  const cross = await patchTaskCard(jsonReq(`http://localhost/api/task-cards/${c1.id}`, "PATCH", { prerequisites: [c2.id] }), { params: Promise.resolve({ id: c1.id }) });
  assert.equal(cross.status, 400);
  const badEnum = await patchTaskCard(jsonReq(`http://localhost/api/task-cards/${c1.id}`, "PATCH", { execStatus: "nonsense" }), { params: Promise.resolve({ id: c1.id }) });
  assert.equal(badEnum.status, 400);
});

test("POST 校验增强：跨看板依赖/目标不存在 400 且无残留、readyStatus/attachments 400、系统看板 400", async () => {
  freshDb();
  const b1 = createBoard(PROJECT, "看板A");
  const b2 = createBoard("other-proj", "看板B");
  await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b1.id, name: "A" }));
  const r2 = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b2.id, name: "B" }));
  const { card: c2 } = await r2.json();

  const cross = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b1.id, name: "X", prerequisites: [c2.id] }));
  assert.equal(cross.status, 400); // 跨看板依赖 → 400
  const missing = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b1.id, name: "X", prerequisites: ["nope"] }));
  assert.equal(missing.status, 400); // 目标不存在 → 400
  const badStatus = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b1.id, name: "X", readyStatus: "bogus" }));
  assert.equal(badStatus.status, 400);
  const badAtt = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b1.id, name: "X", attachments: ["ok", 3] }));
  assert.equal(badAtt.status, 400);

  // 无残留：board 里只有 c1/c2 各自一张卡（跨看板失败那次 X 没建成）
  const list1 = await listTaskCards(new Request("http://localhost/api/task-cards?boardId=" + b1.id));
  const { cards: cards1 } = await list1.json();
  assert.equal(cards1.length, 1); // 只有 A
  const list2 = await listTaskCards(new Request("http://localhost/api/task-cards?boardId=" + b2.id));
  const { cards: cards2 } = await list2.json();
  assert.equal(cards2.length, 1); // 只有 B

  const sys = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: "__running__", name: "S" }));
  assert.equal(sys.status, 400); // 系统看板不能建卡
});

test("GET 单卡 404；DELETE 不存在幂等", async () => {
  freshDb();
  const missing = await getTaskCard(new Request("http://localhost/api/task-cards/nope"), { params: Promise.resolve({ id: "nope" }) });
  assert.equal(missing.status, 404);

  const del = await deleteTaskCard(new Request("http://localhost/api/task-cards/nope", { method: "DELETE" }), { params: Promise.resolve({ id: "nope" }) });
  assert.equal(del.status, 200); // 幂等
});

test("PATCH 自环依赖 400", async () => {
  freshDb();
  const b = createBoard(PROJECT, "看板A");
  const r1 = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b.id, name: "A" }));
  const { card: c1 } = await r1.json();
  const selfDep = await patchTaskCard(jsonReq(`http://localhost/api/task-cards/${c1.id}`, "PATCH", { prerequisites: [c1.id] }), { params: Promise.resolve({ id: c1.id }) });
  assert.equal(selfDep.status, 400);
});
