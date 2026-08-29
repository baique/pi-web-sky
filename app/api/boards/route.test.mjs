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
const { GET: listBoards, POST: createBoard } = await jiti.import("./route.ts");
const { GET: getBoard, PATCH: patchBoard, DELETE: deleteBoard } = await jiti.import("./[id]/route.ts");
const { GET: getCanvas, PUT: putCanvas } = await jiti.import("./[id]/canvas/route.ts");
const { POST: addNode } = await jiti.import("./[id]/nodes/route.ts");
const { PATCH: patchNode, DELETE: deleteNode } = await jiti.import("./[id]/nodes/[nid]/route.ts");
const { POST: addEdge } = await jiti.import("./[id]/edges/route.ts");
const { DELETE: deleteEdge } = await jiti.import("./[id]/edges/[eid]/route.ts");

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
  const bad = await createBoard(jsonReq("http://localhost/api/boards", "POST", { projectKey: "" }));
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

test("canvas API: full replace + node/edge sub-resources", async () => {
  freshDb();
  const created = await createBoard(jsonReq("http://localhost/api/boards", "POST", { projectKey: PROJECT, name: "b" }));
  const board = (await created.json()).board;

  // PUT canvas on system board -> 403
  const sysPut = await putCanvas(jsonReq("http://localhost/api/boards/__running__/canvas", "PUT", { nodes: [] }), {
    params: Promise.resolve({ id: "__running__" }),
  });
  assert.equal(sysPut.status, 403);

  // PUT canvas with nodes/edges/view
  const node1 = {
    id: "n1", boardId: board.id, kind: "session", refId: "s1",
    x: 10, y: 20, w: 280, h: 120, expanded: false, props: {},
    created: 1, updated: 1,
  };
  const node2 = {
    id: "n2", boardId: board.id, kind: "session", refId: "s2",
    x: 400, y: 20, w: 280, h: 120, expanded: false, props: {},
    created: 2, updated: 2,
  };
  const edge = { id: "e1", boardId: board.id, fromId: "n1", toId: "n2", label: null, color: null, dashed: false, created: 3, updated: 3 };
  const putRes = await putCanvas(jsonReq("http://localhost/api/boards/x/canvas", "PUT", {
    nodes: [node1, node2],
    edges: [edge],
    view: { boardId: board.id, cameraX: -10, cameraY: -5, cameraZ: 0.9, updated: 4 },
  }), { params: Promise.resolve({ id: board.id }) });
  assert.equal(putRes.status, 200);

  const canvasRes = await getCanvas(new Request("http://localhost/api/boards/x/canvas"), {
    params: Promise.resolve({ id: board.id }),
  });
  const canvas = await canvasRes.json();
  assert.equal(canvas.nodes.length, 2);
  assert.equal(canvas.edges.length, 1);
  assert.equal(canvas.view.cameraZ, 0.9);

  // node sub-resource
  const addRes = await addNode(jsonReq("http://localhost/api/boards/x/nodes", "POST", { refId: "s3", x: 5, y: 5, expanded: true }), {
    params: Promise.resolve({ id: board.id }),
  });
  assert.equal(addRes.status, 201);
  const added = (await addRes.json()).node;
  assert.equal(added.expanded, true);

  const patchRes = await patchNode(jsonReq("http://localhost/x", "PATCH", { x: 99, props: { color: "#f00" } }), {
    params: Promise.resolve({ id: board.id, nid: added.id }),
  });
  assert.equal(patchRes.status, 200);
  const patched = (await patchRes.json()).node;
  assert.equal(patched.x, 99);
  assert.deepEqual(patched.props, { color: "#f00" });

  // edge sub-resource
  const edgeRes = await addEdge(jsonReq("http://localhost/api/boards/x/edges", "POST", { fromId: added.id, toId: "n1", dashed: true, label: "dep" }), {
    params: Promise.resolve({ id: board.id }),
  });
  assert.equal(edgeRes.status, 201);
  const addedEdge = (await edgeRes.json()).edge;
  assert.equal(addedEdge.dashed, true);

  const delEdgeRes = await deleteEdge(new Request("http://localhost/x", { method: "DELETE" }), {
    params: Promise.resolve({ id: board.id, eid: addedEdge.id }),
  });
  assert.equal(delEdgeRes.status, 200);

  // delete node cascades its edges
  const delNodeRes = await deleteNode(new Request("http://localhost/x", { method: "DELETE" }), {
    params: Promise.resolve({ id: board.id, nid: added.id }),
  });
  assert.equal(delNodeRes.status, 200);
  const after = await getCanvas(new Request("http://localhost/api/boards/x/canvas"), {
    params: Promise.resolve({ id: board.id }),
  });
  const afterCanvas = await after.json();
  assert.equal(afterCanvas.nodes.length, 2);
  assert.equal(afterCanvas.edges.length, 1); // only e1 remains
});
