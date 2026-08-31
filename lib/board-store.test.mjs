import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { setDbForTesting, SCHEMA_VERSION } = await jiti.import("./sqlite-db.ts");
const {
  getBoard,
  listBoards,
  createBoard,
  renameBoard,
  deleteBoard,
  deleteBoardCascade,
  getOrCreateTaskBoard,
  getBoardCanvas,
  putBoardCanvas,
  addNode,
  patchNode,
  deleteNode,
  addEdge,
  deleteEdge,
  getSystemRunningBoard,
  reorderBoards,
} = await jiti.import("./board-store.ts");
const { SYSTEM_RUNNING_BOARD_ID } = await jiti.import("./board-types.ts");

const PROJECT = "test-project";

let db;


beforeEach(() => {
  db = new DatabaseSync(":memory:");
  setDbForTesting(db);
});

afterEach(() => {
  db.close();
});

test("schema version reaches 3 with board tables", () => {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'board_%' ORDER BY name")
    .all();
  const names = tables.map((t) => t.name).sort();
  assert.deepEqual(names, ["board_edges", "board_nodes", "board_view", "boards"].sort());
  const boards = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'boards'")
    .all();
  assert.equal(boards.length, 1);
  assert.equal(SCHEMA_VERSION, 5);
  const row = db.prepare("PRAGMA user_version").get();
  assert.equal(row.user_version, 5);
  // v5 迁移：boards.task_id 列存在
  const cols = db.prepare("PRAGMA table_info(boards)").all().map((c) => c.name);
  assert.ok(cols.includes("task_id"));
});

test("board CRUD: create / rename / list / delete", () => {
  const b = createBoard(PROJECT, "默认看板");
  assert.equal(b.isSystem, false);
  assert.equal(b.name, "默认看板");
  assert.equal(b.nodeCount, 0);

  const renamed = renameBoard(b.id, "重构看板");
  assert.equal(renamed?.name, "重构看板");
  assert.equal(getBoard(b.id)?.name, "重构看板");

  const other = createBoard("other-project", "别的项目");
  assert.equal(listBoards(PROJECT).length, 1);
  assert.equal(listBoards("other-project").length, 1);
  assert.equal(getBoard(other.id)?.projectKey, "other-project");

  assert.equal(deleteBoard(b.id), true);
  assert.equal(getBoard(b.id), undefined);
  assert.equal(listBoards(PROJECT).length, 0);
});

test("empty projectKey / name rejected", () => {
  assert.throws(() => createBoard("", "x"), /projectKey is required/);
  assert.throws(() => createBoard(PROJECT, "  "), /name must not be empty/);
});

test("system running board: always present, not deletable/renamable", () => {
  const sys = getSystemRunningBoard();
  assert.equal(sys.id, SYSTEM_RUNNING_BOARD_ID);
  assert.equal(sys.isSystem, true);
  assert.equal(getBoard(SYSTEM_RUNNING_BOARD_ID)?.isSystem, true);
  assert.equal(renameBoard(SYSTEM_RUNNING_BOARD_ID, "x"), null);
  assert.equal(deleteBoard(SYSTEM_RUNNING_BOARD_ID), false);
  assert.equal(addNode(SYSTEM_RUNNING_BOARD_ID, { x: 0, y: 0 }), null);
});

test("nodes: add / patch / delete cascade edges", () => {
  const b = createBoard(PROJECT, "b");
  const n1 = addNode(b.id, { x: 10, y: 20, w: 280, h: 120, refId: "s1" });
  const n2 = addNode(b.id, { x: 400, y: 50, refId: "s2" });
  assert.ok(n1 && n2);
  assert.equal(n1.kind, "session");
  assert.equal(n1.x, 10);

  const patched = patchNode(b.id, n1.id, { x: 99, expanded: true });
  assert.equal(patched?.x, 99);
  assert.equal(patched?.expanded, true);

  const e = addEdge(b.id, { fromId: n1.id, toId: n2.id, label: "depends", dashed: true });
  assert.ok(e);
  assert.equal(e.dashed, true);

  // deleting n1 removes the edge
  assert.equal(deleteNode(b.id, n1.id), true);
  const canvas = getBoardCanvas(b.id);
  assert.equal(canvas?.nodes.length, 1);
  assert.equal(canvas?.edges.length, 0);
  assert.equal(deleteNode(b.id, n1.id), false);
});

test("patchNode: refId 可定向写入/缺省保留/null 解绑（draft 卡转正）", () => {
  const b = createBoard(PROJECT, "b");
  // draft 卡：refId 为空
  const draft = addNode(b.id, { x: 0, y: 0, refId: null });
  assert.ok(draft);
  assert.equal(draft.refId, null);
  const beforeUpdated = getBoard(b.id)?.updated ?? 0;

  // 转正：写入真实会话 id
  const bound = patchNode(b.id, draft.id, { refId: "session-real-1" });
  assert.equal(bound?.refId, "session-real-1");
  // 缺省不改
  assert.equal(patchNode(b.id, draft.id, { x: 55 })?.refId, "session-real-1");
  // 显式 null 解绑
  assert.equal(patchNode(b.id, draft.id, { refId: null })?.refId, null);

  // PATCH 会 bump boards.updated（乐观锁基线）：非递减（同毫秒内可能相等，不依赖单调性）
  const afterUpdated = getBoard(b.id)?.updated ?? 0;
  assert.ok(afterUpdated >= beforeUpdated);
  // 携带过期基线的全量保存被 409 拒绝：不回头把绑定覆盖回 draft（哨兵基线 0 必过期）
  const stale = putBoardCanvas(b.id, {
    nodes: [{ id: draft.id, boardId: b.id, kind: "session", refId: null, x: 0, y: 0, w: 340, h: 160, expanded: false, props: {}, created: 1, updated: 1 }],
  }, { baseUpdated: 0 });
  assert.equal(stale, "conflict");
  // 用当前基线则放行
  const fresh = putBoardCanvas(b.id, {
    nodes: [{ id: draft.id, boardId: b.id, kind: "session", refId: "session-real-1", x: 0, y: 0, w: 340, h: 160, expanded: false, props: {}, created: 1, updated: 1 }],
  }, { baseUpdated: afterUpdated });
  assert.equal(fresh, true);
  assert.equal(getBoardCanvas(b.id)?.nodes[0].refId, "session-real-1");
});

test("addEdge rejects self-loop and cross-board refs", () => {
  const b = createBoard(PROJECT, "b");
  const b2 = createBoard(PROJECT, "b2");
  const n1 = addNode(b.id, { x: 0, y: 0 });
  const n2 = addNode(b.id, { x: 100, y: 0 });
  const n3 = addNode(b2.id, { x: 0, y: 0 });
  assert.ok(n1 && n2 && n3);
  assert.equal(addEdge(b.id, { fromId: n1.id, toId: n1.id }), null);
  assert.equal(addEdge(b.id, { fromId: n1.id, toId: n3.id }), null);
  assert.ok(addEdge(b.id, { fromId: n1.id, toId: n2.id }));
  assert.equal(deleteEdge(b.id, "nope"), false);
});

test("putBoardCanvas full replace inside transaction, rollback on error", () => {
  const b = createBoard(PROJECT, "b");
  const n1 = addNode(b.id, { x: 0, y: 0, refId: "s1" });
  const n2 = addNode(b.id, { x: 100, y: 0, refId: "s2" });
  assert.ok(n1 && n2);
  addEdge(b.id, { fromId: n1.id, toId: n2.id });

  const nodes = [
    { ...n1, x: 5, y: 5, w: 300, h: 150, props: { color: "#f00" }, created: n1.created, updated: n1.updated },
  ];
  const edges = [];
  const ok = putBoardCanvas(b.id, {
    nodes,
    edges,
    view: { boardId: b.id, cameraX: -50, cameraY: -30, cameraZ: 0.8, updated: 1 },
  });
  assert.equal(ok, true);

  const canvas = getBoardCanvas(b.id);
  assert.equal(canvas?.nodes.length, 1);
  assert.equal(canvas?.nodes[0].x, 5);
  assert.deepEqual(canvas?.nodes[0].props, { color: "#f00" });
  assert.equal(canvas?.edges.length, 0);
  assert.equal(canvas?.view?.cameraZ, 0.8);

  // system board / missing board not writable
  assert.equal(putBoardCanvas(SYSTEM_RUNNING_BOARD_ID, { nodes: [] }), false);
  assert.equal(putBoardCanvas("missing", { nodes: [] }), false);
});

test("putBoardCanvas empty overwrite guard + allowEmpty escape hatch", () => {
  const b = createBoard(PROJECT, "b");
  addNode(b.id, { x: 0, y: 0, refId: "s1" });
  // 非空看板被空节点集覆盖 → 拒绝（防客户端未加载完成清空看板）
  assert.equal(putBoardCanvas(b.id, { nodes: [] }), "empty-overwrite");
  assert.equal(getBoardCanvas(b.id)?.nodes.length, 1);
  // 显式 allowEmpty → 放行
  assert.equal(putBoardCanvas(b.id, { nodes: [], edges: [] }, { allowEmpty: true }), true);
  assert.equal(getBoardCanvas(b.id)?.nodes.length, 0);
  // 原本就空的看板，空覆盖本就允许
  assert.equal(putBoardCanvas(b.id, { nodes: [] }), true);
});

test("rollback keeps db consistent when transaction throws", () => {
  const b = createBoard(PROJECT, "b");
  const n1 = addNode(b.id, { x: 0, y: 0 });
  assert.ok(n1);
  // addEdge with a bad ref throws inside a transaction? no — returns null.
  // Force a real throw via a duplicate primary key through putBoardCanvas.
  const nodes = [
    { ...n1, id: "dup", created: n1.created, updated: n1.updated },
    { ...n1, id: "dup", created: n1.created, updated: n1.updated },
  ];
  assert.throws(() => putBoardCanvas(b.id, { nodes }));
  // rollback: original node still there
  const canvas = getBoardCanvas(b.id);
  assert.equal(canvas?.nodes.length, 1);
  assert.equal(canvas?.nodes[0].id, n1.id);
});

test("board reorder within project", () => {
  const a = createBoard(PROJECT, "A");
  const b = createBoard(PROJECT, "B");
  const c = createBoard(PROJECT, "C");
  // 新板置顶：创建顺序 C, B, A
  assert.deepEqual(listBoards(PROJECT).map((x) => x.id), [c.id, b.id, a.id]);

  const reordered = reorderBoards(PROJECT, [a.id, c.id, b.id]);
  assert.deepEqual(reordered.map((x) => x.id), [a.id, c.id, b.id]);

  // foreign id → rollback keeps order
  assert.throws(() => reorderBoards(PROJECT, [a.id, "foreign"]));
  assert.deepEqual(listBoards(PROJECT).map((x) => x.id), [a.id, c.id, b.id]);
});

test("canvas of missing board is null", () => {
  assert.equal(getBoardCanvas("missing"), null);
  assert.equal(addNode("missing", { x: 0, y: 0 }), null);
});

test("task board: lazy create (upsert), id = taskId, not in manual reorder scope", () => {
  const b1 = getOrCreateTaskBoard("task-1", PROJECT, "任务一");
  assert.equal(b1.id, "task-1");
  assert.equal(b1.taskId, "task-1");
  assert.equal(b1.isSystem, false);
  assert.equal(b1.name, "任务一");

  // 幂等：再次调用返回同一 board（不重复创建）
  const b2 = getOrCreateTaskBoard("task-1", PROJECT, "任务一");
  assert.equal(b2.id, b1.id);
  assert.equal(getBoard("task-1")?.taskId, "task-1");

  // 出现在 listBoards 中（展示层自行过滤 taskId == null）
  assert.ok(listBoards(PROJECT).some((b) => b.id === "task-1"));
});

test("task board: deleteBoardCascade removes nodes/edges/view within caller transaction", () => {
  const b = getOrCreateTaskBoard("task-2", PROJECT, "任务二");
  const n1 = addNode(b.id, { x: 0, y: 0, refId: "s1" });
  const n2 = addNode(b.id, { x: 100, y: 0, refId: "s2" });
  assert.ok(n1 && n2);
  addEdge(b.id, { fromId: n1.id, toId: n2.id });
  putBoardCanvas(b.id, {
    nodes: undefined,
    edges: undefined,
    view: { boardId: b.id, cameraX: 1, cameraY: 2, cameraZ: 3, updated: 1 },
  });

  // 事务内调用：异常回滚不残留
  const dbLocal = db;
  dbLocal.exec("BEGIN");
  try {
    deleteBoardCascade(b.id);
    throw new Error("boom");
  } catch {
    dbLocal.exec("ROLLBACK");
  }
  assert.ok(getBoard(b.id)); // 回滚后看板仍在

  dbLocal.exec("BEGIN");
  try {
    deleteBoardCascade(b.id);
    dbLocal.exec("COMMIT");
  } catch {
    dbLocal.exec("ROLLBACK");
    throw new Error("unexpected");
  }
  assert.equal(getBoard(b.id), undefined);
  assert.equal(getBoardCanvas(b.id), null);
});
