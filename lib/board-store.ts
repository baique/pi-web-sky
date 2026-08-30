import { randomUUID } from "crypto";
import { getDb } from "./sqlite-db";
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
    .prepare("SELECT id, project_key AS projectKey, name, is_system AS isSystem, sort_order AS sortOrder, created, updated FROM boards WHERE id = ?")
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

/** 某项目的全部看板（不含系统看板，系统看板由调用方前置插入）。 */
export function listBoards(projectKey: string): BoardInfo[] {
  const rows = getDb()
    .prepare(
      "SELECT id, project_key AS projectKey, name, is_system AS isSystem, sort_order AS sortOrder, created, updated FROM boards WHERE project_key = ? ORDER BY sort_order, created, rowid",
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

/** 创建看板。空 projectKey / 空名抛错。 */
export function createBoard(projectKey: string, name: string): BoardInfo {
  const trimmed = name.trim();
  if (!projectKey) throw new Error("projectKey is required");
  if (!trimmed) throw new Error("name must not be empty");
  const id = randomUUID();
  const ts = now();
  // 新看板置顶：sort_order 取当前项目最小值 - 1
  const minRow = getDb()
    .prepare("SELECT MIN(sort_order) AS minOrder FROM boards WHERE project_key = ?")
    .get(projectKey) as { minOrder: number | null };
  const sortOrder = minRow.minOrder === null ? 0 : minRow.minOrder - 1;
  getDb()
    .prepare("INSERT INTO boards (id, project_key, name, is_system, sort_order, created, updated) VALUES (?, ?, ?, 0, ?, ?, ?)")
    .run(id, projectKey, trimmed, sortOrder, ts, ts);
  return { id, projectKey, name: trimmed, isSystem: false, sortOrder, created: ts, updated: ts, nodeCount: 0 };
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

/** 删除看板（级联删 nodes/edges/view）。系统看板 / 不存在返回 false。 */
export function deleteBoard(id: string): boolean {
  if (id === SYSTEM_RUNNING_BOARD_ID) return false;
  const db = getDb();
  if (!getBoardRow(id)) return false;
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM board_nodes WHERE board_id = ?").run(id);
    db.prepare("DELETE FROM board_edges WHERE board_id = ?").run(id);
    db.prepare("DELETE FROM board_view WHERE board_id = ?").run(id);
    db.prepare("DELETE FROM boards WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return true;
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
  opts?: { baseUpdated?: number },
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
  if (payload.nodes !== undefined && payload.nodes.length === 0) {
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

export interface PatchNodeInput {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  expanded?: boolean;
  props?: Record<string, unknown>;
}

/** 更新节点（移动/改尺寸/展开标记/属性）。系统看板或节点不存在返回 null。 */
export function patchNode(boardId: string, nodeId: string, patch: PatchNodeInput): BoardNode | null {
  if (boardId === SYSTEM_RUNNING_BOARD_ID) return null;
  const db = getDb();
  const existing = getNode(boardId, nodeId);
  if (!existing) return null;
  const ts = now();
  const next = {
    x: patch.x ?? existing.x,
    y: patch.y ?? existing.y,
    w: patch.w ?? existing.w,
    h: patch.h ?? existing.h,
    expanded: patch.expanded ?? existing.expanded,
    props: patch.props !== undefined ? { ...existing.props, ...patch.props } : existing.props,
  };
  db.prepare(
    "UPDATE board_nodes SET x = ?, y = ?, w = ?, h = ?, expanded = ?, props = ?, updated = ? WHERE board_id = ? AND id = ?",
  ).run(next.x, next.y, next.w, next.h, next.expanded ? 1 : 0, JSON.stringify(next.props), ts, boardId, nodeId);
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
 * 清理失效节点：kind=session 且 ref_id 对应的会话 .jsonl 已不存在。
 * 返回被移除的节点 id 列表。系统看板返回空（运行中看板不落库）。
 */
export function cleanupInvalidNodes(boardId: string, validSessionIds: () => Set<string>): string[] {
  if (boardId === SYSTEM_RUNNING_BOARD_ID) return [];
  const db = getDb();
  const nodes = getDb()
    .prepare("SELECT id, ref_id AS refId FROM board_nodes WHERE board_id = ?")
    .all(boardId) as unknown as { id: string; refId: string | null }[];
  const valid = validSessionIds();
  const invalid = nodes.filter((n) => n.refId !== null && !valid.has(n.refId)).map((n) => n.id);
  if (invalid.length === 0) return [];
  const ts = now();
  db.exec("BEGIN");
  try {
    const placeholders = invalid.map(() => "?").join(", ");
    db.prepare(`DELETE FROM board_edges WHERE board_id = ? AND (from_id IN (${placeholders}) OR to_id IN (${placeholders}))`)
      .run(boardId, ...invalid, ...invalid);
    db.prepare(`DELETE FROM board_nodes WHERE board_id = ? AND id IN (${placeholders})`).run(boardId, ...invalid);
    db.prepare("UPDATE boards SET updated = ? WHERE id = ?").run(ts, boardId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return invalid;
}
