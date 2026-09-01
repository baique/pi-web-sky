import { randomUUID } from "crypto";
import { getDb } from "./sqlite-db";
import { getCard, listLinks, type LinkKind } from "./task-card-store";
import {
  SYSTEM_RUNNING_BOARD_ID,
  type BoardCanvas,
  type BoardEdge,
  type BoardInfo,
  type BoardNode,
  type BoardNodeKind,
  type BoardView,
} from "./board-types";

const now = () => Date.now();

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

interface BoardRow {
  id: string;
  projectKey: string;
  name: string;
  isSystem: number;
  taskId: string | null;
  sortOrder: number;
  created: number;
  updated: number;
}

interface BoardNodeRow {
  id: string;
  boardId: string;
  kind: BoardNodeKind;
  refId: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  expanded: number;
  props: string;
  created: number;
  updated: number;
}

interface BoardEdgeRow {
  id: string;
  boardId: string;
  fromId: string;
  toId: string;
  label: string | null;
  color: string | null;
  dashed: number;
  created: number;
  updated: number;
}

interface BoardViewRow {
  boardId: string;
  cameraX: number;
  cameraY: number;
  cameraZ: number;
  updated: number;
}

function rowToBoard(row: BoardRow, nodeCount: number): BoardInfo {
  return {
    id: row.id,
    projectKey: row.projectKey,
    name: row.name,
    isSystem: row.isSystem === 1,
    taskId: row.taskId,
    sortOrder: row.sortOrder,
    created: row.created,
    updated: row.updated,
    nodeCount,
  };
}

function rowToNode(row: BoardNodeRow): BoardNode {
  return {
    id: row.id,
    boardId: row.boardId,
    kind: row.kind,
    refId: row.refId,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    expanded: row.expanded === 1,
    props: parseProps(row.props),
    created: row.created,
    updated: row.updated,
  };
}

function rowToEdge(row: BoardEdgeRow): BoardEdge {
  return {
    id: row.id,
    boardId: row.boardId,
    fromId: row.fromId,
    toId: row.toId,
    label: row.label,
    color: row.color,
    dashed: row.dashed === 1,
    created: row.created,
    updated: row.updated,
  };
}

function rowToView(row: BoardViewRow): BoardView {
  return {
    boardId: row.boardId,
    cameraX: row.cameraX,
    cameraY: row.cameraY,
    cameraZ: row.cameraZ,
    updated: row.updated,
  };
}

function parseProps(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function countNodes(boardId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM board_nodes WHERE board_id = ?")
    .get(boardId) as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// boards
// ---------------------------------------------------------------------------

function getBoardRow(id: string): BoardRow | undefined {
  return getDb()
    .prepare("SELECT id, project_key AS projectKey, name, is_system AS isSystem, task_id AS taskId, sort_order AS sortOrder, created, updated FROM boards WHERE id = ?")
    .get(id) as BoardRow | undefined;
}

/**
 * 系统「运行中」看板：不落库，恒存在。列表时以 isSystem 形态返回；
 * projectKey 用空串（跨项目聚合，不归任何项目）。
 */
export function getSystemRunningBoard(): BoardInfo {
  return {
    id: SYSTEM_RUNNING_BOARD_ID,
    projectKey: "",
    name: "running",
    isSystem: true,
    taskId: null,
    sortOrder: 0,
    created: 0,
    updated: 0,
    nodeCount: 0,
  };
}

/** 单看板（含系统看板）；不存在返回 undefined。 */
export function getBoard(id: string): BoardInfo | undefined {
  if (id === SYSTEM_RUNNING_BOARD_ID) return getSystemRunningBoard();
  const row = getBoardRow(id);
  return row ? rowToBoard(row, countNodes(row.id)) : undefined;
}

/** 某项目的全部看板（不含系统看板，系统看板由调用方前置插入）。
 *  含任务型看板（taskId 非空）；展示层自行决定是否过滤。 */
export function listBoards(projectKey: string): BoardInfo[] {
  const rows = getDb()
    .prepare(
      "SELECT id, project_key AS projectKey, name, is_system AS isSystem, task_id AS taskId, sort_order AS sortOrder, created, updated FROM boards WHERE project_key = ? ORDER BY sort_order, created, rowid",
    )
    .all(projectKey) as unknown as BoardRow[];
  return rows.map((row) => rowToBoard(row, countNodes(row.id)));
}

/**
 * 项目内看板批量排序（完整有序 id 列表）。id 必须都属于该项目，否则事务回滚。
 */
export function reorderBoards(projectKey: string, orderedIds: string[]): BoardInfo[] {
  const db = getDb();
  if (orderedIds.length === 0) return listBoards(projectKey);
  db.exec("BEGIN");
  try {
    const stmt = db.prepare("UPDATE boards SET sort_order = ?, updated = ? WHERE id = ? AND project_key = ?");
    orderedIds.forEach((id, index) => {
      const res = stmt.run(index, now(), id, projectKey);
      if (res.changes === 0) {
        throw new Error(`board ${id} does not belong to project ${projectKey}`);
      }
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return listBoards(projectKey);
}

/** 创建看板。空 projectKey / 空名抛错。taskId 可选：非空时看板为任务型（id = taskId）。 */
export function createBoard(projectKey: string, name: string, taskId?: string): BoardInfo {
  const trimmed = name.trim();
  if (!projectKey) throw new Error("projectKey is required");
  if (!trimmed) throw new Error("name must not be empty");
  const id = taskId ?? randomUUID();
  const ts = now();
  // 新看板置顶：sort_order 取当前项目最小值 - 1
  const minRow = getDb()
    .prepare("SELECT MIN(sort_order) AS minOrder FROM boards WHERE project_key = ?")
    .get(projectKey) as { minOrder: number | null };
  const sortOrder = minRow.minOrder === null ? 0 : minRow.minOrder - 1;
  getDb()
    .prepare("INSERT INTO boards (id, project_key, name, is_system, task_id, sort_order, created, updated) VALUES (?, ?, ?, 0, ?, ?, ?, ?)")
    .run(id, projectKey, trimmed, taskId ?? null, sortOrder, ts, ts);
  return { id, projectKey, name: trimmed, isSystem: false, taskId: taskId ?? null, sortOrder, created: ts, updated: ts, nodeCount: 0 };
}

/**
 * 任务看板懒创建（原子 upsert）：查 boards WHERE task_id = ?；不存在则创建
 * （id = taskId，名 = 任务名）。返回 BoardInfo。
 *
 * 并发安全：boards.task_id 有 UNIQUE 索引（迁移 v6），多请求同时懒创建时
 * 只有一个 INSERT 成功，其余 `INSERT OR IGNORE` 静默跳过；统一以最后查回
 * 的结果返回——无论谁插入，所有并发请求都拿到同一行，不会重复创建。
 */
export function getOrCreateTaskBoard(taskId: string, projectKey: string, name: string): BoardInfo {
  const db = getDb();
  const query = "SELECT id, project_key AS projectKey, name, is_system AS isSystem, task_id AS taskId, sort_order AS sortOrder, created, updated FROM boards WHERE task_id = ?";
  const existing = db.prepare(query).get(taskId) as BoardRow | undefined;
  if (existing) return rowToBoard(existing, countNodes(existing.id));

  // 原子插入：task_id UNIQUE 约束下并发只有一个成功，其余被 IGNORE
  const trimmed = name.trim();
  const ts = now();
  // 新看板置顶：sort_order 取当前项目最小值 - 1（并发算同值无害，仅排序并列）
  const minRow = db.prepare("SELECT MIN(sort_order) AS minOrder FROM boards WHERE project_key = ?").get(projectKey) as { minOrder: number | null };
  const sortOrder = minRow.minOrder === null ? 0 : minRow.minOrder - 1;
  db.prepare("INSERT OR IGNORE INTO boards (id, project_key, name, is_system, task_id, sort_order, created, updated) VALUES (?, ?, ?, 0, ?, ?, ?, ?)")
    .run(taskId, projectKey, trimmed, taskId, sortOrder, ts, ts);

  // 统一查回：无论刚插入还是并发者已插入，task_id 唯一 → 同一行
  const row = db.prepare(query).get(taskId) as BoardRow | undefined;
  if (!row) {
    // 理论不可达（INSERT OR IGNORE 后必存在）；防御性兜底
    throw new Error(`Failed to create task board for task ${taskId}`);
  }
  return rowToBoard(row, countNodes(row.id));
}

/** 改名。系统看板 / 不存在返回 null。 */
export function renameBoard(id: string, name: string): BoardInfo | null {
  if (id === SYSTEM_RUNNING_BOARD_ID) return null;
  const trimmed = name.trim();
  if (!trimmed) throw new Error("name must not be empty");
  const db = getDb();
  const row = getBoardRow(id);
  if (!row) return null;
  const ts = now();
  db.prepare("UPDATE boards SET name = ?, updated = ? WHERE id = ?").run(trimmed, ts, id);
  return rowToBoard({ ...row, name: trimmed, updated: ts }, countNodes(id));
}

/**
 * 级联删除看板数据（nodes/edges/view/boards 行）。**无事务**——由调用方
 * （deleteBoard / task-store.deleteTask）在自身事务内调用，避免 SQLite 嵌套 BEGIN。
 */
export function deleteBoardCascade(id: string): void {
  getDb().prepare("DELETE FROM board_nodes WHERE board_id = ?").run(id);
  getDb().prepare("DELETE FROM board_edges WHERE board_id = ?").run(id);
  getDb().prepare("DELETE FROM board_view WHERE board_id = ?").run(id);
  getDb().prepare("DELETE FROM boards WHERE id = ?").run(id);
}

/** 删除看板（级联删 nodes/edges/view）。系统看板 / 不存在返回 false。 */
export function deleteBoard(id: string): boolean {
  if (id === SYSTEM_RUNNING_BOARD_ID) return false;
  const db = getDb();
  if (!getBoardRow(id)) return false;
  db.exec("BEGIN");
  try {
    deleteBoardCascade(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return true;
}

/**
 * 任务改名时同步看板名（看板不存在则 0 行无害）。**无事务**——由调用方
 * （task-store.updateTask）在自身事务内调用。
 */
export function renameTaskBoard(taskId: string, name: string): void {
  getDb()
    .prepare("UPDATE boards SET name = ?, updated = ? WHERE task_id = ?")
    .run(name, now(), taskId);
}

// ---------------------------------------------------------------------------
// canvas / nodes / edges / view
// ---------------------------------------------------------------------------

export function getBoardCanvas(boardId: string): BoardCanvas | null {
  const board = getBoard(boardId);
  if (!board) return null;
  const nodes = getDb()
    .prepare("SELECT id, board_id AS boardId, kind, ref_id AS refId, x, y, w, h, expanded, props, created, updated FROM board_nodes WHERE board_id = ? ORDER BY created, rowid")
    .all(boardId) as unknown as BoardNodeRow[];
  const edges = getDb()
    .prepare("SELECT id, board_id AS boardId, from_id AS fromId, to_id AS toId, label, color, dashed, created, updated FROM board_edges WHERE board_id = ? ORDER BY created, rowid")
    .all(boardId) as unknown as BoardEdgeRow[];
  const view = getDb()
    .prepare("SELECT board_id AS boardId, camera_x AS cameraX, camera_y AS cameraY, camera_z AS cameraZ, updated FROM board_view WHERE board_id = ?")
    .get(boardId) as BoardViewRow | undefined;
  return { board, nodes: nodes.map(rowToNode), edges: edges.map(rowToEdge), view: view ? rowToView(view) : null };
}

/**
 * 全量保存整张画布（nodes/edges/view 一次事务替换）。
 * 系统看板不可写；看板不存在返回 false。
 */
export function putBoardCanvas(
  boardId: string,
  payload: { nodes?: BoardNode[]; edges?: BoardEdge[]; view?: BoardView | null },
  opts?: { baseUpdated?: number; allowEmpty?: boolean },
): boolean | "empty-overwrite" | "conflict" {
  if (boardId === SYSTEM_RUNNING_BOARD_ID) return false;
  const db = getDb();
  const row = getBoardRow(boardId);
  if (!row) return false;
  // 乐观锁：客户端基于 baseUpdated 快照全量替换。若期间有其他客户端/标签页保存过
  // （boards.updated 已变化），说明本地快照过期，直接拒绝 —— 由客户端拉取远端合并后重试。
  if (opts?.baseUpdated !== undefined && opts.baseUpdated !== row.updated) {
    return "conflict";
  }
  // 防数据丢失（多次真实发生）：客户端物化失败/未加载时，会带着空/部分节点集自动保存，
  // 全量替换会直接把看板删空。硬性兜底：看板已有节点而本次 payload 节点为空 → 拒绝写入。
  // 用户主动「清空画布」走 allowEmpty 显式放行。
  if (!opts?.allowEmpty && payload.nodes !== undefined && payload.nodes.length === 0) {
    const existing = db.prepare("SELECT COUNT(*) c FROM board_nodes WHERE board_id = ?").get(boardId) as { c: number };
    if (existing.c > 0) return "empty-overwrite";
  }
  const ts = now();
  db.exec("BEGIN");
  try {
    if (payload.nodes) {
      db.prepare("DELETE FROM board_nodes WHERE board_id = ?").run(boardId);
      const insert = db.prepare(
        "INSERT INTO board_nodes (id, board_id, kind, ref_id, x, y, w, h, expanded, props, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const n of payload.nodes) {
        insert.run(n.id, boardId, n.kind, n.refId, n.x, n.y, n.w, n.h, n.expanded ? 1 : 0, JSON.stringify(n.props ?? {}), n.created || ts, ts);
      }
    }
    if (payload.edges) {
      db.prepare("DELETE FROM board_edges WHERE board_id = ?").run(boardId);
      const insert = db.prepare(
        "INSERT INTO board_edges (id, board_id, from_id, to_id, label, color, dashed, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const e of payload.edges) {
        insert.run(e.id, boardId, e.fromId, e.toId, e.label ?? null, e.color ?? null, e.dashed ? 1 : 0, e.created || ts, ts);
      }
    }
    if (payload.view !== undefined) {
      db.prepare("DELETE FROM board_view WHERE board_id = ?").run(boardId);
      if (payload.view) {
        db.prepare(
          "INSERT INTO board_view (board_id, camera_x, camera_y, camera_z, updated) VALUES (?, ?, ?, ?, ?)",
        ).run(boardId, payload.view.cameraX ?? 0, payload.view.cameraY ?? 0, payload.view.cameraZ ?? 1, ts);
      }
    }
    db.prepare("UPDATE boards SET updated = ? WHERE id = ?").run(ts, boardId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return true;
}

export interface CreateNodeInput {
  kind?: BoardNodeKind;
  refId?: string | null;
  x: number;
  y: number;
  w?: number;
  h?: number;
  expanded?: boolean;
  props?: Record<string, unknown>;
}

/** 添加节点。系统看板不可写；看板不存在返回 null。 */
export function addNode(boardId: string, input: CreateNodeInput): BoardNode | null {
  if (boardId === SYSTEM_RUNNING_BOARD_ID) return null;
  if (!getBoardRow(boardId)) return null;
  const id = randomUUID();
  const ts = now();
  getDb()
    .prepare(
      "INSERT INTO board_nodes (id, board_id, kind, ref_id, x, y, w, h, expanded, props, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, boardId, input.kind ?? "session", input.refId ?? null, input.x, input.y, input.w ?? 0, input.h ?? 0, input.expanded ? 1 : 0, JSON.stringify(input.props ?? {}), ts, ts);
  getDb().prepare("UPDATE boards SET updated = ? WHERE id = ?").run(ts, boardId);
  return getNode(boardId, id) ?? null;
}

function getNode(boardId: string, nodeId: string): BoardNode | undefined {
  const row = getDb()
    .prepare("SELECT id, board_id AS boardId, kind, ref_id AS refId, x, y, w, h, expanded, props, created, updated FROM board_nodes WHERE board_id = ? AND id = ?")
    .get(boardId, nodeId) as BoardNodeRow | undefined;
  return row ? rowToNode(row) : undefined;
}

/**
 * 按全局 nodeId 绑定会话（board_nodes.ref_id 写回；看板已迁 tldraw sync 后废弃保留）。
 * nodeId 是 board_nodes.id（randomUUID，全局唯一），无需 boardId。
 * 绑定成功 bump 所属看板 updated（乐观锁基线），返回更新后的节点；
 * 节点不存在 / 属于系统看板返回 null。
 */
export function bindNodeToSession(nodeId: string, sessionId: string): BoardNode | null {
  const db = getDb();
  const row = db
    .prepare("SELECT board_id AS boardId FROM board_nodes WHERE id = ?")
    .get(nodeId) as { boardId: string } | undefined;
  if (!row) return null;
  if (row.boardId === SYSTEM_RUNNING_BOARD_ID) return null;
  const ts = now();
  db.prepare("UPDATE board_nodes SET ref_id = ?, updated = ? WHERE id = ?").run(sessionId, ts, nodeId);
  db.prepare("UPDATE boards SET updated = ? WHERE id = ?").run(ts, row.boardId);
  return getNode(row.boardId, nodeId) ?? null;
}

/** 按全局 nodeId 读节点（未转正卡轮询用）；不存在返回 undefined。 */
export function getNodeByGlobalId(nodeId: string): BoardNode | undefined {
  const row = getDb()
    .prepare("SELECT id, board_id AS boardId, kind, ref_id AS refId, x, y, w, h, expanded, props, created, updated FROM board_nodes WHERE id = ?")
    .get(nodeId) as BoardNodeRow | undefined;
  return row ? rowToNode(row) : undefined;
}

/** 按看板内 refId 查节点（任务卡 node 用：ref_id = cardId）；可选按 kind 过滤。 */
export function getNodeByRefId(
  boardId: string,
  refId: string,
  kind?: BoardNodeKind,
): BoardNode | undefined {
  const sql =
    "SELECT id, board_id AS boardId, kind, ref_id AS refId, x, y, w, h, expanded, props, created, updated FROM board_nodes " +
    (kind
      ? "WHERE board_id = ? AND ref_id = ? AND kind = ?"
      : "WHERE board_id = ? AND ref_id = ?");
  const row = kind
    ? getDb().prepare(sql).get(boardId, refId, kind)
    : getDb().prepare(sql).get(boardId, refId);
  return row ? rowToNode(row as unknown as BoardNodeRow) : undefined;
}

export interface PatchNodeInput {
  /** 会话卡绑定的会话 id（draft 转正时写入）。null 显式解绑；缺省不改。 */
  refId?: string | null;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  expanded?: boolean;
  props?: Record<string, unknown>;
}

/** 更新节点（移动/改尺寸/展开标记/refId/属性）。系统看板或节点不存在返回 null。 */
export function patchNode(boardId: string, nodeId: string, patch: PatchNodeInput): BoardNode | null {
  if (boardId === SYSTEM_RUNNING_BOARD_ID) return null;
  const db = getDb();
  const existing = getNode(boardId, nodeId);
  if (!existing) return null;
  const ts = now();
  const next = {
    refId: patch.refId !== undefined ? patch.refId : existing.refId,
    x: patch.x ?? existing.x,
    y: patch.y ?? existing.y,
    w: patch.w ?? existing.w,
    h: patch.h ?? existing.h,
    expanded: patch.expanded ?? existing.expanded,
    props: patch.props !== undefined ? { ...existing.props, ...patch.props } : existing.props,
  };
  db.prepare(
    "UPDATE board_nodes SET ref_id = ?, x = ?, y = ?, w = ?, h = ?, expanded = ?, props = ?, updated = ? WHERE board_id = ? AND id = ?",
  ).run(next.refId, next.x, next.y, next.w, next.h, next.expanded ? 1 : 0, JSON.stringify(next.props), ts, boardId, nodeId);
  db.prepare("UPDATE boards SET updated = ? WHERE id = ?").run(ts, boardId);
  return getNode(boardId, nodeId)!;
}

/** 删除节点（级联删以它为端点的边）。系统看板或节点不存在返回 false。 */
export function deleteNode(boardId: string, nodeId: string): boolean {
  if (boardId === SYSTEM_RUNNING_BOARD_ID) return false;
  const db = getDb();
  if (!getNode(boardId, nodeId)) return false;
  const ts = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM board_edges WHERE board_id = ? AND (from_id = ? OR to_id = ?)").run(boardId, nodeId, nodeId);
    db.prepare("DELETE FROM board_nodes WHERE board_id = ? AND id = ?").run(boardId, nodeId);
    db.prepare("UPDATE boards SET updated = ? WHERE id = ?").run(ts, boardId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return true;
}

/**
 * 批量删除节点（可跨看板）。级联删以任一被删节点为端点的边；bump 所属看板 updated。
 * 单事务内完成（SQLite 不支持嵌套 BEGIN，调用方须在自身事务之外调用）。
 * 返回删除的节点/边数量与受影响的看板 id 列表。系统看板节点不删。
 */
export function deleteNodesByIds(
  nodeIds: string[],
): { deletedNodes: number; deletedEdges: number; boards: string[] } {
  if (nodeIds.length === 0) return { deletedNodes: 0, deletedEdges: 0, boards: [] };
  const db = getDb();
  const placeholders = nodeIds.map(() => "?").join(",");
  // 过滤系统看板（running 只读）节点
  const rows = db
    .prepare(`SELECT id, board_id AS boardId FROM board_nodes WHERE id IN (${placeholders}) AND board_id != ?`)
    .all(...nodeIds, SYSTEM_RUNNING_BOARD_ID) as Array<{ id: string; boardId: string }>;
  if (rows.length === 0) return { deletedNodes: 0, deletedEdges: 0, boards: [] };
  const ids = rows.map((r) => r.id);
  const idPlaceholders = ids.map(() => "?").join(",");
  const boardIds = [...new Set(rows.map((r) => r.boardId))];
  const ts = now();
  db.exec("BEGIN");
  try {
    // 级联删边：以任一被删节点为端点（一条边两端都在删除集时只命中一次删除）
    const edgeResult = db
      .prepare(`DELETE FROM board_edges WHERE from_id IN (${idPlaceholders}) OR to_id IN (${idPlaceholders})`)
      .run(...ids, ...ids);
    const nodeResult = db
      .prepare(`DELETE FROM board_nodes WHERE id IN (${idPlaceholders})`)
      .run(...ids);
    // bump 受影响看板 updated（乐观锁基线，防迟到全量保存覆盖）
    for (const bid of boardIds) {
      db.prepare("UPDATE boards SET updated = ? WHERE id = ?").run(ts, bid);
    }
    db.exec("COMMIT");
    return { deletedNodes: Number(nodeResult.changes), deletedEdges: Number(edgeResult.changes), boards: boardIds };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface CreateEdgeInput {
  fromId: string;
  toId: string;
  label?: string | null;
  color?: string | null;
  dashed?: boolean;
}

/** 加连线（两端节点必须属于该看板）。系统看板或看板不存在返回 null。 */
export function addEdge(boardId: string, input: CreateEdgeInput): BoardEdge | null {
  if (boardId === SYSTEM_RUNNING_BOARD_ID) return null;
  if (!getBoardRow(boardId)) return null;
  const db = getDb();
  const from = getNode(boardId, input.fromId);
  const to = getNode(boardId, input.toId);
  if (!from || !to) return null;
  if (input.fromId === input.toId) return null;
  const id = randomUUID();
  const ts = now();
  db.prepare(
    "INSERT INTO board_edges (id, board_id, from_id, to_id, label, color, dashed, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, boardId, input.fromId, input.toId, input.label ?? null, input.color ?? null, input.dashed ? 1 : 0, ts, ts);
  db.prepare("UPDATE boards SET updated = ? WHERE id = ?").run(ts, boardId);
  return getEdge(boardId, id) ?? null;
}

function getEdge(boardId: string, edgeId: string): BoardEdge | undefined {
  const row = getDb()
    .prepare("SELECT id, board_id AS boardId, from_id AS fromId, to_id AS toId, label, color, dashed, created, updated FROM board_edges WHERE board_id = ? AND id = ?")
    .get(boardId, edgeId) as BoardEdgeRow | undefined;
  return row ? rowToEdge(row) : undefined;
}

/** 删除连线。系统看板或连线不存在返回 false。 */
export function deleteEdge(boardId: string, edgeId: string): boolean {
  if (boardId === SYSTEM_RUNNING_BOARD_ID) return false;
  const db = getDb();
  if (!getEdge(boardId, edgeId)) return false;
  const ts = now();
  db.prepare("DELETE FROM board_edges WHERE board_id = ? AND id = ?").run(boardId, edgeId);
  db.prepare("UPDATE boards SET updated = ? WHERE id = ?").run(ts, boardId);
  return true;
}


/**
 * 按任务卡的依赖关系 reconcile 画布自动连线（label=kind 识别，禁删语义）。
 * 真相源是 task_card_links：缺失的依赖边补回、多余的自动边删除。
 * 只 reconcile 本卡的「出边」（from=本卡 node），避免双向 reconcile 打架。
 * 本函数不包事务（内部多次 addEdge/deleteEdge 无事务），由调用方包事务。
 */
export function syncCardEdges(cardId: string): void {
  const card = getCard(cardId);
  if (!card) return;
  const db = getDb();
  const node = getNodeByRefId(card.boardId, cardId, "taskcard");
  if (!node) return;

  const existing = db
    .prepare(
      "SELECT id, from_id AS fromId, to_id AS toId, label FROM board_edges " +
        "WHERE board_id = ? AND from_id = ? AND label IN ('prerequisite', 'related')",
    )
    .all(card.boardId, node.id) as Array<{ id: string; fromId: string; toId: string; label: string | null }>;

  const wanted = listLinks(cardId)
    .map((link) => {
      const targetNode = getNodeByRefId(card.boardId, link.targetCardId, "taskcard");
      return targetNode ? { toId: targetNode.id, label: link.kind } : null;
    })
    .filter((x): x is { toId: string; label: LinkKind } => x !== null);

  const keyOf = (toId: string, label: string) => `${toId}:${label}`;
  const wantedKeys = new Set(wanted.map((w) => keyOf(w.toId, w.label)));
  const existingKeys = new Set(existing.map((e) => keyOf(e.toId, e.label ?? "")));

  for (const e of existing) {
    if (!wantedKeys.has(keyOf(e.toId, e.label ?? ""))) {
      deleteEdge(card.boardId, e.id);
    }
  }
  for (const w of wanted) {
    if (!existingKeys.has(keyOf(w.toId, w.label))) {
      addEdge(card.boardId, { fromId: node.id, toId: w.toId, label: w.label });
    }
  }
}

/**
 * 任务卡执行会话线 reconcile：真相源 task_cards.session_id。
 * 期望 = 一条 label='exec' 的边（from=本卡 taskcard 节点 → to=session 节点），
 * 原子-链接语义：任务卡通过这条边引用画布上独立存在的执行会话卡。
 * 任一端节点缺失 → 不建线、清掉残留 exec 边（节点后补由 reconcile 兜底）。
 * 禁删语义：手动删 exec 边会被本函数补回；真正的删除 = 清 session_id 或删任务卡。
 * 本函数不包事务（内部多次 addEdge/deleteEdge 无事务），由调用方包事务。
 */
export function syncExecEdge(cardId: string): void {
  const card = getCard(cardId);
  if (!card) return;
  const db = getDb();
  const node = getNodeByRefId(card.boardId, cardId, "taskcard");
  if (!node) return;

  const existing = db
    .prepare("SELECT id, to_id AS toId FROM board_edges WHERE board_id = ? AND from_id = ? AND label = 'exec'")
    .all(card.boardId, node.id) as Array<{ id: string; toId: string }>;

  // 期望目标：有 sessionId 且会话节点存在 → 该节点
  let wantedTo: string | null = null;
  if (card.sessionId) {
    const sessionNode = getNodeByRefId(card.boardId, card.sessionId, "session");
    if (sessionNode) wantedTo = sessionNode.id;
  }

  for (const e of existing) {
    if (e.toId !== wantedTo) deleteEdge(card.boardId, e.id);
  }
  if (wantedTo && !existing.some((e) => e.toId === wantedTo)) {
    // exec 线虚线（区别于依赖线/用户画的实线，见 task-cards.md）
    addEdge(card.boardId, { fromId: node.id, toId: wantedTo, label: "exec", dashed: true });
  }
}

/**
 * 删会话前清理所有看板上的引用（单事务，不留孤儿）：
 * 1. 清掉引用该会话的任务卡 `session_id`（原子-链接：会话被删，任务卡回到无关联）；
 * 2. 删除指向该会话节点的 exec 线；
 * 3. 删除画布上该会话的全部 session 节点（级联删边）并 bump 受影响看板 updated。
 * 返回清理的节点数；无引用返回 0，幂等。
 * 供删会话流程调用（会话文件删除在事务外，由调用方负责）。
 */
export interface RemoveSessionFromBoardsResult {
  /** 清理的画布节点数 */
  removedNodes: number;
  /** 受影响看板及其最新 updated（前端刷新乐观锁基线，防删除后防抖保存 409） */
  boards: Array<{ boardId: string; updated: number }>;
}

export function removeSessionFromBoards(sessionId: string): RemoveSessionFromBoardsResult {
  const db = getDb();
  const sessionNodes = db
    .prepare("SELECT id, board_id AS boardId FROM board_nodes WHERE kind = 'session' AND ref_id = ?")
    .all(sessionId) as Array<{ id: string; boardId: string }>;
  if (sessionNodes.length === 0) return { removedNodes: 0, boards: [] };

  const ts = now();
  const touched = new Map<string, number>();
  db.exec("BEGIN");
  try {
    // 1. 任务卡解绑：所有 session_id 引用该会话的卡置空
    db.prepare("UPDATE task_cards SET session_id = NULL, updated = ? WHERE session_id = ?").run(ts, sessionId);
    for (const n of sessionNodes) {
      // 2. 删指向该会话节点的 exec 线（from=taskcard node → to=会话节点）
      db.prepare("DELETE FROM board_edges WHERE board_id = ? AND to_id = ? AND label = 'exec'").run(n.boardId, n.id);
      // 3. 删会话节点 + 关联边
      db.prepare("DELETE FROM board_edges WHERE board_id = ? AND (from_id = ? OR to_id = ?)").run(n.boardId, n.id, n.id);
      db.prepare("DELETE FROM board_nodes WHERE board_id = ? AND id = ?").run(n.boardId, n.id);
      db.prepare("UPDATE boards SET updated = ? WHERE id = ?").run(ts, n.boardId);
      touched.set(n.boardId, ts);
    }
    db.exec("COMMIT");
    return {
      removedNodes: sessionNodes.length,
      boards: [...touched.entries()].map(([boardId, updated]) => ({ boardId, updated })),
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** 该看板全部任务卡（供派生边兜底 reconcile） */
function listBoardTaskCards(boardId: string): Array<{ id: string }> {
  return getDb()
    .prepare("SELECT id FROM task_cards WHERE board_id = ?")
    .all(boardId) as Array<{ id: string }>;
}

/**
 * 画布加载后兜底：对该看板所有任务卡 reconcile 派生边（依赖线 syncCardEdges + 执行会话线 syncExecEdge）。
 * 幂等（只补缺失边）；供进入看板/重载后调一次，之后由真相源写入点（建卡/改依赖/绑 sessionId/删卡）各自触发。
 * 不包事务，由调用方包。
 */
export function reconcileBoardTaskEdges(boardId: string): void {
  const cards = listBoardTaskCards(boardId);
  for (const card of cards) {
    syncCardEdges(card.id);
    syncExecEdge(card.id);
  }
}

/**
 * 任务卡画布节点 upsert：nodeId 存在 → 绑定 ref_id=cardId（转正）；
 * 不存在 → 新建 taskcard node（id=nodeId，与 tldraw shape.id 对齐，后续全量保存覆盖不重复）。
 * 无事务（单语句 + bump），由调用方包事务。
 */
export function upsertTaskCardNode(
  nodeId: string,
  boardId: string,
  card: { id: string; number: number; name: string; readyStatus: string; execStatus: string; priority: number; due: number | null },
  x: number,
  y: number,
): BoardNode | null {
  const db = getDb();
  if (boardId === SYSTEM_RUNNING_BOARD_ID) return null;
  if (!getBoardRow(boardId)) return null;
  const ts = now();
  // 完整 shapeProps 落库：hydrate 恢复 task-card shape 依赖它（建卡时 node 可能不存在）
  const shapeProps = {
    cardId: card.id,
    number: card.number,
    name: card.name,
    readyStatus: card.readyStatus,
    execStatus: card.execStatus,
    priority: card.priority,
    due: card.due ?? undefined,
    expanded: false,
    w: 220,
    h: 120,
  };
  const props = JSON.stringify({ parentId: null, shapeProps });
  const existing = db.prepare("SELECT id FROM board_nodes WHERE id = ?").get(nodeId);
  if (existing) {
    db.prepare("UPDATE board_nodes SET ref_id = ?, props = ?, updated = ? WHERE id = ?").run(card.id, props, ts, nodeId);
    db.prepare("UPDATE boards SET updated = ? WHERE id = ?").run(ts, boardId);
  } else {
    db.prepare(
      "INSERT INTO board_nodes (id, board_id, kind, ref_id, x, y, w, h, expanded, props, created, updated) " +
        "VALUES (?, ?, 'taskcard', ?, ?, ?, 220, 120, 0, ?, ?, ?)",
    ).run(nodeId, boardId, card.id, x, y, props, ts, ts);
    db.prepare("UPDATE boards SET updated = ? WHERE id = ?").run(ts, boardId);
  }
  return getNode(boardId, nodeId) ?? null;
}
