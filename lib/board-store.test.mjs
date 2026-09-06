import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { setDbForTesting, SCHEMA_VERSION } = await jiti.import("./sqlite-db.ts");
const {
  getBoard,
  listBoards,
  listAllBoards,
  createBoard,
  renameBoard,
  deleteBoard,
  deleteBoardCascade,
  getOrCreateTaskBoard,
  getSystemRunningBoard,
  reorderBoards,
  reorderAllBoards,
  removeSessionFromBoards,
} = await jiti.import("./board-store.ts");
const { createCard, updateCard, getCard } = await jiti.import("./task-card-store.ts");
const { SYSTEM_RUNNING_BOARD_ID } = await jiti.import("./board-types.ts");

const PROJECT = "test-project";

const now = () => Date.now();

let db;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  setDbForTesting(db);
});

afterEach(() => {
  db.close();
});

test("schema version reaches latest with board tables", () => {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'board_%' ORDER BY name")
    .all();
  const names = tables.map((t) => t.name).sort();
  assert.deepEqual(names, ["board_edges", "board_nodes", "board_view", "boards"].sort());
  const boards = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'boards'")
    .all();
  assert.equal(boards.length, 1);
  assert.equal(SCHEMA_VERSION, 11);
  const row = db.prepare("PRAGMA user_version").get();
  assert.equal(row.user_version, 11);
  // v5 迁移：boards.task_id 列存在
  const cols = db.prepare("PRAGMA table_info(boards)").all().map((c) => c.name);
  assert.ok(cols.includes("task_id"));
  // v6 迁移：task_id 唯一索引（并发防重复创建任务看板）
  const uniq = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'boards' AND name = 'idx_boards_task_unique'").all();
  assert.equal(uniq.length, 1);
});

test("board CRUD: create / rename / list / delete", () => {
  const b = createBoard(PROJECT, "默认看板");
  assert.equal(b.isSystem, false);
  assert.equal(b.name, "默认看板");

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

test("empty projectKey creates global board / empty name rejected", () => {
  // 空 projectKey 现为全局共享看板（跨项目聚合，与系统看板同层语义）
  const g = createBoard("", "全局板");
  assert.equal(g.projectKey, "");
  assert.equal(g.isSystem, false);
  assert.equal(g.taskId, null);
  assert.throws(() => createBoard(PROJECT, "  "), /name must not be empty/);
});

test("global boards: listAllBoards aggregates across projects + reorderAllBoards", () => {
  const pa = createBoard("proj-a", "A");
  const pb = createBoard("proj-b", "B");
  const g = createBoard("", "G");
  // 全局列表含所有项目 + 全局看板（新板置顶：G 取全局最小 -1 最前，A/B 同项目内 sort 0 按 created）
  assert.deepEqual(listAllBoards().map((x) => x.id), [g.id, pa.id, pb.id]);

  // 全局排序跨项目
  const reordered = reorderAllBoards([pa.id, g.id, pb.id]);
  assert.deepEqual(reordered.map((x) => x.id), [pa.id, g.id, pb.id]);

  // 外来 id（含任务型/系统）→ 回滚保持原序
  assert.throws(() => reorderAllBoards([pa.id, "foreign"]));
  assert.deepEqual(listAllBoards().map((x) => x.id), [pa.id, g.id, pb.id]);
});

test("system running board: always present, not deletable/renamable", () => {
  const sys = getSystemRunningBoard();
  assert.equal(sys.id, SYSTEM_RUNNING_BOARD_ID);
  assert.equal(sys.isSystem, true);
  assert.equal(getBoard(SYSTEM_RUNNING_BOARD_ID)?.isSystem, true);
  assert.equal(renameBoard(SYSTEM_RUNNING_BOARD_ID, "x"), null);
  assert.equal(deleteBoard(SYSTEM_RUNNING_BOARD_ID), false);
});

test("getOrCreateTaskBoard: 多次调用同一行 + task_id UNIQUE 拒绝重复（并发防重建）", () => {
  const b1 = getOrCreateTaskBoard("task-conc-1", PROJECT, "并发任务");
  // 连续多次调用（模拟并发请求）→ 恒返回同一看板
  for (let i = 0; i < 5; i += 1) {
    const again = getOrCreateTaskBoard("task-conc-1", PROJECT, "并发任务");
    assert.equal(again.id, b1.id);
  }
  // 库里 task_id 唯一（UNIQUE 索引生效）
  const rows = db.prepare("SELECT COUNT(*) c FROM boards WHERE task_id = ?").get("task-conc-1");
  assert.equal(rows.c, 1);
  // 手动重复插入被 UNIQUE 拒绝（并发时只有第一个 INSERT 成功）
  assert.throws(() => {
    db.prepare("INSERT INTO boards (id, project_key, name, is_system, task_id, sort_order, created, updated) VALUES (?, ?, ?, 0, ?, 0, 1, 1)")
      .run("dup-id", PROJECT, "dup", "task-conc-1");
  }, /UNIQUE/i);
  // 不同 task_id 互不影响
  const b2 = getOrCreateTaskBoard("task-conc-2", PROJECT, "另一个");
  assert.notEqual(b2.id, b1.id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM boards WHERE task_id IN ('task-conc-1','task-conc-2')").get().c, 2);
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
  // 写入 tldraw 遗留表的节点/边/view（deleteBoardCascade 需连带清空这些表）
  db.prepare("INSERT INTO board_nodes (id, board_id, kind, ref_id, x, y, w, h, expanded, props, created, updated) VALUES (?, ?, 'session', ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("n1", b.id, "s1", 0, 0, 100, 100, 0, "{}", now(), now());
  db.prepare("INSERT INTO board_edges (id, board_id, from_id, to_id, label, color, dashed, created, updated) VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)")
    .run("e1", b.id, "n1", "n2", "exec", now(), now());
  db.prepare("INSERT INTO board_view (board_id, camera_x, camera_y, camera_z, updated) VALUES (?, 1, 2, 3, ?)")
    .run(b.id, now());

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
  // 遗留表已清空
  assert.equal(db.prepare("SELECT COUNT(*) c FROM board_nodes WHERE board_id = ?").get("task-2").c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM board_edges WHERE board_id = ?").get("task-2").c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM board_view WHERE board_id = ?").get("task-2").c, 0);
});

test("removeSessionFromBoards: 删会话清任务卡 session_id + 待答队列，幂等", () => {
  const b = createBoard(PROJECT, "看板A");
  const c = createCard({ boardId: b.id, projectKey: PROJECT, name: "任务" });
  const c2 = createCard({ boardId: b.id, projectKey: PROJECT, name: "任务2" });
  updateCard(c.id, { sessionId: "sess-x" });
  db.prepare("INSERT INTO task_card_questions (id, card_id, session_id, question, status, created) VALUES (?, ?, ?, ?, 'pending', ?)")
    .run("q1", c.id, "sess-x", "如何做", now());

  const removed = removeSessionFromBoards("sess-x");
  // RF+yjs 架构：removedNodes/boards 恒 0（画布由 removeSessionsFromYjsBoards 清）
  assert.equal(removed.removedNodes, 0);
  assert.deepEqual(removed.boards, []);
  // 业务表闭环：session_id 解绑 + 待答记录清空
  assert.equal(getCard(c.id)?.sessionId, null);
  assert.equal(getCard(c2.id)?.sessionId, null);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM task_card_questions WHERE session_id = ?").get("sess-x").c, 0);
  // 幂等：重复调用无副作用
  assert.deepEqual(removeSessionFromBoards("sess-x"), { removedNodes: 0, boards: [] });
});
