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
const { createBoard, getBoardCanvas } = await jiti.import("@/lib/board-store.ts");

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

test("POST 建卡：card + node 落库（kind=taskcard, refId），编号自增", async () => {
  freshDb();
  const b = createBoard(PROJECT, "看板A");
  const r1 = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b.id, name: "任务一", x: 10, y: 20 }));
  assert.equal(r1.status, 201);
  const j1 = await r1.json();
  assert.ok(j1.nodeId);
  assert.equal(j1.card.number, 1);
  assert.equal(j1.card.name, "任务一");

  const r2 = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b.id, name: "任务二" }));
  const j2 = await r2.json();
  assert.equal(j2.card.number, 2);

  const canvas = getBoardCanvas(b.id);
  const node = canvas.nodes.find((n) => n.id === j1.nodeId);
  assert.ok(node);
  assert.equal(node.kind, "taskcard");
  assert.equal(node.refId, j1.card.id);
  assert.equal(node.x, 10);
});

test("GET 列表：每卡带 nodeId；GET 单卡：links + inbound 两向", async () => {
  freshDb();
  const b = createBoard(PROJECT, "看板A");
  const r1 = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b.id, name: "A" }));
  const r2 = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b.id, name: "B" }));
  const { card: c1 } = await r1.json();
  const { card: c2 } = await r2.json();

  const listRes = await listTaskCards(new Request("http://localhost/api/task-cards?boardId=" + b.id));
  const { cards } = await listRes.json();
  assert.equal(cards.length, 2);
  assert.ok(cards[0].nodeId);

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
  // board_edges 有自动连线
  const edges = getBoardCanvas(b.id).edges;
  assert.equal(edges.length, 1);
  assert.equal(edges[0].label, "prerequisite");
});

test("PATCH 字段更新 + 依赖替换同步边；DELETE 级联清空", async () => {
  freshDb();
  const b = createBoard(PROJECT, "看板A");
  const r1 = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b.id, name: "A" }));
  const r2 = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b.id, name: "B" }));
  const r3 = await createTaskCard(jsonReq("http://localhost/api/task-cards", "POST", { boardId: b.id, name: "C" }));
  const { card: c1 } = await r1.json();
  const { card: c2 } = await r2.json();
  const { card: c3 } = await r3.json();

  await patchTaskCard(jsonReq(`http://localhost/api/task-cards/${c1.id}`, "PATCH", {
    name: "改名", priority: 1, prerequisites: [c2.id], related: [c3.id],
  }), { params: Promise.resolve({ id: c1.id }) });
  const after = await getTaskCard(new Request(`http://localhost/api/task-cards/${c1.id}`), { params: Promise.resolve({ id: c1.id }) });
  const j = await after.json();
  assert.equal(j.card.name, "改名");
  assert.equal(j.card.priority, 1);
  assert.equal(j.links.length, 2);

  // 依赖改 target → 旧 prerequisite 边换 target
  await patchTaskCard(jsonReq(`http://localhost/api/task-cards/${c1.id}`, "PATCH", { prerequisites: [c3.id], related: [] }), { params: Promise.resolve({ id: c1.id }) });
  const canvas1 = getBoardCanvas(b.id);
  const preEdges = canvas1.edges.filter((e) => e.label === "prerequisite");
  assert.equal(preEdges.length, 1);
  assert.equal(preEdges[0].toId, canvas1.nodes.find((n) => n.refId === c3.id).id);
  assert.equal(canvas1.edges.filter((e) => e.label === "related").length, 0);

  // DELETE 级联：card/links/node/边全消失
  const del = await deleteTaskCard(new Request(`http://localhost/api/task-cards/${c1.id}`, { method: "DELETE" }), { params: Promise.resolve({ id: c1.id }) });
  assert.equal(del.status, 200);
  const gone = await getTaskCard(new Request(`http://localhost/api/task-cards/${c1.id}`), { params: Promise.resolve({ id: c1.id }) });
  assert.equal(gone.status, 404);
  const canvas2 = getBoardCanvas(b.id);
  assert.equal(canvas2.nodes.filter((n) => n.refId === c1.id).length, 0);
  assert.equal(canvas2.edges.filter((e) => e.fromId === canvas1.nodes.find((n) => n.refId === c1.id)?.id).length, 0);
  assert.equal(canvas2.nodes.length, 2); // c2/c3 卡节点保留
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
