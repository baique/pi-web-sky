import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { setDbForTesting, getDb } = await jiti.import("@/lib/sqlite-db.ts");
const { createCard } = await jiti.import("@/lib/task-card-store.ts");
const { GET: listBoards, POST: createBoard } = await jiti.import("./route.ts");
const { GET: getBoard, PATCH: patchBoard, DELETE: deleteBoard } = await jiti.import("./[id]/route.ts");
const { POST: purgeOrphans } = await jiti.import("./purge-orphans/route.ts");
const { PUT: reorderBoards } = await jiti.import("./reorder/route.ts");

const PROJECT = "proj-b";

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

test("boards API: list always includes system running board", async () => {
  freshDb();
  const res = await listBoards(new Request("http://localhost/api/boards?projectKey=proj-b"));
  const { boards } = await res.json();
  assert.equal(boards.length, 1);
  assert.equal(boards[0].isSystem, true);
  assert.equal(boards[0].id, "__running__");

  const sys = await getBoard(new Request("http://localhost/api/boards/__running__"), {
    params: Promise.resolve({ id: "__running__" }),
  });
  assert.equal(sys.status, 200);
  assert.equal((await sys.json()).board.isSystem, true);

  // system board rename/delete -> 403
  const patchSys = await patchBoard(jsonReq("http://localhost/x", "PATCH", { name: "x" }), {
    params: Promise.resolve({ id: "__running__" }),
  });
  assert.equal(patchSys.status, 403);
  const delSys = await deleteBoard(new Request("http://localhost/x", { method: "DELETE" }), {
    params: Promise.resolve({ id: "__running__" }),
  });
  assert.equal(delSys.status, 403);
});

test("boards API: create / rename / delete + project isolation", async () => {
  freshDb();
  // 空 projectKey 现为全局共享看板（合法）；空名仍拒绝
  const bad = await createBoard(jsonReq("http://localhost/api/boards", "POST", { name: "   " }));
  assert.equal(bad.status, 400);

  const created = await createBoard(jsonReq("http://localhost/api/boards", "POST", { projectKey: PROJECT, name: "  默认  " }));
  assert.equal(created.status, 201);
  const { board } = await created.json();
  assert.equal(board.name, "默认");
  assert.equal(board.isSystem, false);

  const created2 = await createBoard(jsonReq("http://localhost/api/boards", "POST", { projectKey: "other", name: "别的" }));
  assert.equal(created2.status, 201);
  const other = (await created2.json()).board;

  const list = await listBoards(new Request("http://localhost/api/boards?projectKey=proj-b"));
  const { boards } = await list.json();
  assert.equal(boards.length, 2); // system + 默认
  assert.deepEqual(boards.filter((b) => !b.isSystem).map((b) => b.id), [board.id]);

  const patched = await patchBoard(jsonReq("http://localhost/x", "PATCH", { name: "重构" }), {
    params: Promise.resolve({ id: board.id }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).board.name, "重构");

  const del = await deleteBoard(new Request("http://localhost/x", { method: "DELETE" }), {
    params: Promise.resolve({ id: board.id }),
  });
  assert.equal(del.status, 200);
  const getDel = await getBoard(new Request("http://localhost/api/boards/x"), {
    params: Promise.resolve({ id: board.id }),
  });
  assert.equal(getDel.status, 404);
  // other project board unaffected
  assert.ok(await getBoard(new Request("http://localhost/api/boards/x"), { params: Promise.resolve({ id: other.id }) }));
});

test("boards API: no projectKey returns global (all) boards", async () => {
  freshDb();
  await createBoard(jsonReq("http://localhost/api/boards", "POST", { projectKey: "proj-b", name: "B板" }));
  await createBoard(jsonReq("http://localhost/api/boards", "POST", { projectKey: "other", name: "别的" }));
  await createBoard(jsonReq("http://localhost/api/boards", "POST", { name: "全局板" }));
  const res = await listBoards(new Request("http://localhost/api/boards"));
  const { boards } = await res.json();
  const manual = boards.filter((b) => !b.isSystem);
  assert.equal(manual.length, 3);
  assert.deepEqual(manual.map((b) => b.projectKey).sort(), ["", "other", "proj-b"]);
});

test("reorder API: full order replace + foreign id rollback", async () => {
  freshDb();
  const a = await createBoard(jsonReq("http://localhost/api/boards", "POST", { projectKey: PROJECT, name: "A" }));
  const b = await createBoard(jsonReq("http://localhost/api/boards", "POST", { projectKey: PROJECT, name: "B" }));
  const c = await createBoard(jsonReq("http://localhost/api/boards", "POST", { projectKey: PROJECT, name: "C" }));
  const [A, B, C] = [(await a.json()).board, (await b.json()).board, (await c.json()).board];

  const res = await reorderBoards(jsonReq("http://localhost/api/boards/reorder", "PUT", { projectKey: PROJECT, orderedIds: [C.id, A.id, B.id] }));
  assert.equal(res.status, 200);
  const { boards } = await res.json();
  assert.deepEqual(boards.map((x) => x.id), [C.id, A.id, B.id]);

  const bad = await reorderBoards(jsonReq("http://localhost/api/boards/reorder", "PUT", { projectKey: PROJECT, orderedIds: [A.id, "foreign"] }));
  assert.equal(bad.status, 500);
  const after = await listBoards(new Request("http://localhost/api/boards?projectKey=proj-b"));
  const afterBoards = (await after.json()).boards.filter((x) => !x.isSystem);
  assert.deepEqual(afterBoards.map((x) => x.id), [C.id, A.id, B.id]);
});

test("reorder API: global reorder without projectKey + rollback", async () => {
  freshDb();
  const a = await createBoard(jsonReq("http://localhost/api/boards", "POST", { projectKey: "p1", name: "A" }));
  const b = await createBoard(jsonReq("http://localhost/api/boards", "POST", { projectKey: "p2", name: "B" }));
  const c = await createBoard(jsonReq("http://localhost/api/boards", "POST", { name: "C" }));
  const [A, B, C] = [(await a.json()).board, (await b.json()).board, (await c.json()).board];

  const res = await reorderBoards(jsonReq("http://localhost/api/boards/reorder", "PUT", { orderedIds: [C.id, A.id, B.id] }));
  assert.equal(res.status, 200);
  const { boards } = await res.json();
  assert.deepEqual(boards.map((x) => x.id), [C.id, A.id, B.id]);

  const bad = await reorderBoards(jsonReq("http://localhost/api/boards/reorder", "PUT", { orderedIds: [A.id, "foreign"] }));
  assert.equal(bad.status, 500);
  const after = await listBoards(new Request("http://localhost/api/boards"));
  const afterBoards = (await after.json()).boards.filter((x) => !x.isSystem);
  assert.deepEqual(afterBoards.map((x) => x.id), [C.id, A.id, B.id]);
});

test("purge-orphans API: 删除指向已删会话的孤儿卡片", async () => {
  freshDb();
  const created = await createBoard(jsonReq("http://localhost/api/boards", "POST", { projectKey: PROJECT, name: "purge" }));
  const { board } = await created.json();
  const now = Date.now();
  const insertNode = (refId, x) =>
    getDb()
      .prepare("INSERT INTO board_nodes (id, board_id, kind, ref_id, x, y, w, h, expanded, props, created, updated) VALUES (?, ?, 'session', ?, ?, 0, 280, 120, 0, '{}', ?, ?)")
      .run("n-" + Math.random().toString(36).slice(2), board.id, refId, x, now, now);
  // 孤儿节点（会话 id 随机，文件系统必不存在）
  insertNode("purge-nonexistent-" + Math.random().toString(36).slice(2), 0);
  // draft 节点（refId 为空）保留
  insertNode(null, 100);

  const purgeRes = await purgeOrphans(new Request("http://localhost/api/boards/purge-orphans", { method: "POST" }));
  assert.equal(purgeRes.status, 200);
  const body = await purgeRes.json();
  assert.equal(body.deletedNodes, 1);
  assert.deepEqual(body.boards, [board.id]);

  const remaining = getDb().prepare("SELECT * FROM board_nodes WHERE board_id = ?").all(board.id);
  assert.equal(remaining.length, 1); // draft 保留
  assert.equal(remaining[0].ref_id, null);
});

test("purge-orphans API: 删除指向已删任务卡的 taskcard 孤儿节点，保留有效卡节点", async () => {
  freshDb();
  const created = await createBoard(jsonReq("http://localhost/api/boards", "POST", { projectKey: PROJECT, name: "purge-tc" }));
  const { board } = await created.json();
  // 有效任务卡（task_cards 存在）+ 其画布节点 → 保留
  const card = createCard({ boardId: board.id, projectKey: PROJECT, name: "有效卡" });
  const now = Date.now();
  const insertNode = (id, refId, x) =>
    getDb()
      .prepare("INSERT INTO board_nodes (id, board_id, kind, ref_id, x, y, w, h, expanded, props, created, updated) VALUES (?, ?, 'taskcard', ?, ?, 0, 220, 120, 0, '{}', ?, ?)")
      .run(id, board.id, refId, x, now, now);
  insertNode("node-valid", card.id, 0);
  insertNode("node-ghost", "ghost-card-" + Math.random().toString(36).slice(2), 200);

  const purgeRes = await purgeOrphans(new Request("http://localhost/api/boards/purge-orphans", { method: "POST" }));
  assert.equal(purgeRes.status, 200);
  const body = await purgeRes.json();
  assert.equal(body.deletedNodes, 1); // 只删 taskcard 孤儿，有效卡节点保留

  const remaining = getDb().prepare("SELECT * FROM board_nodes WHERE board_id = ?").all(board.id);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].ref_id, card.id);
});
