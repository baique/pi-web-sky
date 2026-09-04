import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { setDbForTesting, getDb } = await jiti.import("./sqlite-db.ts");
const { createTask } = await jiti.import("./task-store.ts");
const { getOrCreateTaskBoard } = await jiti.import("./board-store.ts");
const { createCard, updateCard } = await jiti.import("./task-card-store.ts");
const { assignSessionToTask } = await jiti.import("./task-store.ts");

const PROJECT = "proj-reconcile";

// 注入 mutateBoard mock：捕获每次事务调用（读入当前 Y 状态，执行 transaction 后
// 记录对 nodes/edges 的增删，模拟服务端权威写）。
function installYjsMock() {
  const yjs = (globalThis).__yjsBoard ?? {};
  const nodeSets = new Map(); // nodeId -> node obj
  const edgeSets = new Map(); // edgeId -> edge obj
  const mutateLog = [];

  // 取与真实库同构的 mock：nodes/edges 用普通 Map 承载，transaction 内增删与
  // reconcile 的 nodesMap/edgesMap API 一致（get/set/delete/values/Array.from）。
  const state = { nodes: nodeSets, edges: edgeSets };

  const mock = {
    async mutateBoard(boardId, transaction) {
      mutateLog.push(boardId);
      const maps = {
        nodes: {
          get: (k) => state.nodes.get(k),
          set: (k, v) => { state.nodes.set(k, v); },
          delete: (k) => { state.nodes.delete(k); },
          has: (k) => state.nodes.has(k),
          values: () => state.nodes.values(),
        },
        edges: {
          get: (k) => state.edges.get(k),
          set: (k, v) => { state.edges.set(k, v); },
          delete: (k) => { state.edges.delete(k); },
          has: (k) => state.edges.has(k),
          values: () => state.edges.values(),
        },
      };
      transaction(maps, {});
    },
  };
  (globalThis).__yjsBoard = mock;
  return { nodeSets, edgeSets, mutateLog };
}

function cardNode(id, sid, extra) {
  return {
    id,
    type: "session-card",
    position: { x: 60, y: 60 },
    style: { width: 340, height: 160 },
    data: { sessionId: sid, cwd: "", ...extra },
  };
}

let db;
let mockState;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  setDbForTesting(db);
  mockState = installYjsMock();
});

afterEach(() => {
  db.close();
  delete (globalThis).__yjsBoard;
});

test("窗口期 reconcile 不补同 sid 占位卡（新建会话指定 ID 场景）", async () => {
  const task = createTask(PROJECT, "任务A");
  const board = getOrCreateTaskBoard(task.id, PROJECT, "任务A"); // board.id = task.id
  assert.ok(board.taskId);

  // 服务端已落库（assignSessionToTask 在 /api/agent/new 中先于前端转正执行）
  const sid = "abc-123";
  assignSessionToTask(sid, task.id);

  // 画布已存在「新建中占位卡」：cwd 非空 + sessionId = 即将创建/刚创建的会话 UUID
  mockState.nodeSets.set("user-card-1", cardNode("user-card-1", sid, { cwd: "/proj", expanded: true }));

  const { reconcileBoard } = await jiti.import("./board-reconcile.ts");
  await reconcileBoard(board.id);

  // 不补第二张卡：窗口期内 reconcile 应把占位卡当作「该 sid 已有卡」
  const nodeIds = [...mockState.nodeSets.keys()];
  assert.deepEqual(nodeIds, ["user-card-1"]);
  assert.equal(mockState.nodeSets.has(`session-${sid}`), false);
});

test("无占位卡时业务表会话正常补卡（回归，不误伤）", async () => {
  const task = createTask(PROJECT, "任务B");
  const board = getOrCreateTaskBoard(task.id, PROJECT, "任务B");
  const sid = "reg-session-1";
  assignSessionToTask(sid, task.id);

  const { reconcileBoard } = await jiti.import("./board-reconcile.ts");
  await reconcileBoard(board.id);

  assert.ok(mockState.nodeSets.has(`session-${sid}`), "业务表会话无画布卡 → 应补卡");
  const node = mockState.nodeSets.get(`session-${sid}`);
  assert.equal(node.data.sessionId, sid);
});

test("占位卡不影响其他会话补卡/exec 线（6461a61 语义保留）", async () => {
  const task = createTask(PROJECT, "任务C");
  const board = getOrCreateTaskBoard(task.id, PROJECT, "任务C");

  // 一个「新建中」占位卡（sid 未落库）
  const pendingSid = "pending-uuid";
  mockState.nodeSets.set("pending-card", cardNode("pending-card", pendingSid, { cwd: "/x" }));

  // 一个业务表真实会话 + 任务卡执行会话
  const realSid = "real-session";
  assignSessionToTask(realSid, task.id);
  const execSid = "exec-session";
  const card = createCard({ boardId: board.id, projectKey: PROJECT, name: "子任务" });
  updateCard(card.id, { sessionId: execSid });
  assignSessionToTask(execSid, task.id);

  // 业务表会话都没有对应画布卡 → reconcile 应补齐 realSid/execSid，且建 exec 线
  const { reconcileBoard } = await jiti.import("./board-reconcile.ts");
  await reconcileBoard(board.id);

  assert.ok(mockState.nodeSets.has(`session-${realSid}`), "真实会话应补卡");
  assert.ok(mockState.nodeSets.has(`session-${execSid}`), "执行会话应补卡");
  // 占位卡 sid 不在业务表 → 不应补（无对应补卡），且占位卡本身不被孤儿删（cwd 非空）
  assert.equal(mockState.nodeSets.has(`session-${pendingSid}`), false);
  assert.ok(mockState.nodeSets.has("pending-card"), "占位卡不被孤儿删");

  // exec 线：任务卡节点 + 执行会话卡节点都补出后应建线（task-card 由 reconcile 补，节点 id = task-<cardId>）
  const taskNode = [...mockState.nodeSets.values()].find((n) => n.type === "task-card");
  assert.ok(taskNode, "任务卡节点应被补出");
  const execEdge = [...mockState.edgeSets.values()].find((e) => e.data?.execLink);
  assert.ok(execEdge, "exec 线应建立");
  assert.equal(execEdge.source, taskNode.id);
  assert.equal(execEdge.target, `session-${execSid}`);
});

test("普通看板任务卡派发后：补执行会话卡 + exec 线（不入板 bug 回归）", async () => {
  const { createBoard } = await jiti.import("./board-store.ts");
  const board = createBoard(PROJECT, "普通看板");
  assert.equal(board.taskId, null, "普通看板 taskId 为空");

  // 普通看板上拖出的任务卡 + 已派发（sessionId 已落表）
  const execSid = "exec-session-normal-board";
  const card = createCard({ boardId: board.id, projectKey: PROJECT, name: "普通板任务" });
  updateCard(card.id, { sessionId: execSid });

  const { reconcileBoard } = await jiti.import("./board-reconcile.ts");
  await reconcileBoard(board.id);

  // 执行会话卡应补出（普通看板也补）
  assert.ok(mockState.nodeSets.has(`session-${execSid}`), "普通看板执行会话卡应补出");
  // 任务卡节点应补出
  const taskNode = [...mockState.nodeSets.values()].find((n) => n.type === "task-card");
  assert.ok(taskNode, "任务卡节点应被补出");
  assert.equal(taskNode.id, `task-${card.id}`);
  // exec 线应建立
  const execEdge = [...mockState.edgeSets.values()].find((e) => e.data?.execLink);
  assert.ok(execEdge, "普通看板 exec 线应建立");
  assert.equal(execEdge.source, `task-${card.id}`);
  assert.equal(execEdge.target, `session-${execSid}`);
});

test("普通看板不孤儿删用户手动拖入的会话卡", async () => {
  const { createBoard } = await jiti.import("./board-store.ts");
  const board = createBoard(PROJECT, "普通看板B");

  // 用户手动拖入的会话卡（不在任何业务表）
  const userSid = "user-dragged-session";
  mockState.nodeSets.set("user-card", cardNode("user-card", userSid, {}));

  const { reconcileBoard } = await jiti.import("./board-reconcile.ts");
  await reconcileBoard(board.id);

  // 普通看板：不删会话卡（会话卡由用户拖入/新建管理）
  assert.ok(mockState.nodeSets.has("user-card"), "普通看板用户手动会话卡不被孤儿删");
});

// ---- 会话删除 → yjs 画布清理（普通看板幽灵卡） ----

function installMultiBoardYjsMock() {
  const docs = new Map(); // boardId -> { nodes: Map, edges: Map }
  const mock = {
    async mutateBoard(boardId, transaction) {
      let doc = docs.get(boardId);
      if (!doc) {
        doc = { nodes: new Map(), edges: new Map() };
        docs.set(boardId, doc);
      }
      const maps = {
        nodes: {
          get: (k) => doc.nodes.get(k),
          set: (k, v) => { doc.nodes.set(k, v); },
          delete: (k) => { doc.nodes.delete(k); },
          has: (k) => doc.nodes.has(k),
          values: () => doc.nodes.values(),
        },
        edges: {
          get: (k) => doc.edges.get(k),
          set: (k, v) => { doc.edges.set(k, v); },
          delete: (k) => { doc.edges.delete(k); },
          has: (k) => doc.edges.has(k),
          values: () => doc.edges.values(),
        },
      };
      transaction(maps, {});
    },
    async destroyBoardDocument(boardId) {
      docs.delete(boardId);
    },
  };
  (globalThis).__yjsBoard = mock;
  return { docs };
}

test("删除会话：普通看板 yjs 会话卡被清理，其余卡保留", async () => {
  const { createBoard } = await jiti.import("./board-store.ts");
  const { removeSessionsFromYjsBoards, destroyBoardYjsDocument } = await jiti.import("./board-reconcile.ts");

  const { docs } = installMultiBoardYjsMock();
  const boardA = createBoard(PROJECT, "手动看板A");
  const boardB = createBoard(PROJECT, "手动看板B");
  const s1 = "sess-ghost-1";
  const s2 = "sess-keep-2";
  // 看板 A：含 s1 + s2 两张卡
  await globalThis.__yjsBoard.mutateBoard(boardA.id, (maps) => {
    maps.nodes.set("a1", cardNode("a1", s1, {}));
    maps.nodes.set("a2", cardNode("a2", s2, {}));
  });
  // 看板 B：只含 s1
  await globalThis.__yjsBoard.mutateBoard(boardB.id, (maps) => {
    maps.nodes.set("b1", cardNode("b1", s1, {}));
  });

  await removeSessionsFromYjsBoards([s1]);

  const keysA = [...docs.get(boardA.id).nodes.keys()];
  const keysB = [...docs.get(boardB.id).nodes.keys()];
  assert.deepEqual(keysA, ["a2"], "boardA 删 s1 卡保留 s2");
  assert.deepEqual(keysB, [], "boardB 删 s1 卡");

  // destroy：删看板 → 文档移除
  await destroyBoardYjsDocument(boardA.id);
  assert.equal(docs.has(boardA.id), false, "destroy 后看板 yjs 文档移除");
});

test("拖入任务看板的会话：无 session_meta 归属 → 判孤儿删；有归属 → 存活不补卡", async () => {
  const task = createTask(PROJECT, "任务D");
  const board = getOrCreateTaskBoard(task.id, PROJECT, "任务D");
  const { reconcileBoard } = await jiti.import("./board-reconcile.ts");

  // 拖入一个「业务表无归属」的会话卡：按新判据（只信 session_meta）应判孤儿删
  const draggedSid = "drag-no-meta";
  mockState.nodeSets.set("drag-card", cardNode("drag-card", draggedSid, { taskId: task.id }));
  await reconcileBoard(board.id);
  assert.ok(!mockState.nodeSets.has("drag-card"), "无 session_meta 归属的拖入卡被判孤儿删");

  // 拖入的会话已写 session_meta（先归属后落卡）→ 存活；画布已有该卡 → 不补第二张
  const assignedSid = "drag-with-meta";
  assignSessionToTask(assignedSid, task.id);
  mockState.nodeSets.set("drag-card2", cardNode("drag-card2", assignedSid, { taskId: task.id }));
  await reconcileBoard(board.id);
  assert.ok(mockState.nodeSets.has("drag-card2"), "有 session_meta 归属的拖入卡存活");
  assert.equal(mockState.nodeSets.has(`session-${assignedSid}`), false, "已有卡 → 不补第二张");
});

test("删除会话：普通看板清理级联删除以会话卡为端点的边", async () => {
  const { createBoard } = await jiti.import("./board-store.ts");
  const { removeSessionsFromYjsBoards } = await jiti.import("./board-reconcile.ts");

  const { docs } = installMultiBoardYjsMock();
  const boardA = createBoard(PROJECT, "手动看板C");
  const s1 = "sess-edge-1";
  const s2 = "sess-edge-2";
  // 板 A：s1、s2 两张卡，中间一条手绘边
  await globalThis.__yjsBoard.mutateBoard(boardA.id, (maps) => {
    maps.nodes.set("a1", cardNode("a1", s1, {}));
    maps.nodes.set("a2", cardNode("a2", s2, {}));
    maps.edges.set("e1", { id: "e1", source: "a1", target: "a2", type: "default" });
  });

  await removeSessionsFromYjsBoards([s1]);

  const doc = docs.get(boardA.id);
  assert.deepEqual([...doc.nodes.keys()], ["a2"], "只删 s1 卡");
  assert.deepEqual([...doc.edges.keys()], [], "以 a1 为端点的边级联删除");
});
