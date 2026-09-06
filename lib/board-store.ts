import { randomUUID } from "crypto";
import { getDb } from "./sqlite-db";
import {
  SYSTEM_RUNNING_BOARD_ID,
  type BoardInfo,
} from "./board-types";

const now = () => Date.now();

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

function rowToBoard(row: BoardRow): BoardInfo {
  return {
    id: row.id,
    projectKey: row.projectKey,
    name: row.name,
    isSystem: row.isSystem === 1,
    taskId: row.taskId,
    sortOrder: row.sortOrder,
    created: row.created,
    updated: row.updated,
  };
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
  };
}

/** 单看板（含系统看板）；不存在返回 undefined。 */
export function getBoard(id: string): BoardInfo | undefined {
  if (id === SYSTEM_RUNNING_BOARD_ID) return getSystemRunningBoard();
  const row = getBoardRow(id);
  return row ? rowToBoard(row) : undefined;
}

/** 某项目的全部看板（不含系统看板，系统看板由调用方前置插入）。
 *  含任务型看板（taskId 非空）；展示层自行决定是否过滤。 */
export function listBoards(projectKey: string): BoardInfo[] {
  const rows = getDb()
    .prepare(
      "SELECT id, project_key AS projectKey, name, is_system AS isSystem, task_id AS taskId, sort_order AS sortOrder, created, updated FROM boards WHERE project_key = ? ORDER BY sort_order, created, rowid",
    )
    .all(projectKey) as unknown as BoardRow[];
  return rows.map((row) => rowToBoard(row));
}

/**
 * 全部看板（不含系统看板，系统看板由调用方前置插入）。全局共享视图：
 * 不看 project_key，所有手动看板 + 任务型看板一起返回（展示层自行过滤 taskId）。
 */
export function listAllBoards(): BoardInfo[] {
  const rows = getDb()
    .prepare(
      "SELECT id, project_key AS projectKey, name, is_system AS isSystem, task_id AS taskId, sort_order AS sortOrder, created, updated FROM boards WHERE is_system = 0 ORDER BY sort_order, created, rowid",
    )
    .all() as unknown as BoardRow[];
  return rows.map((row) => rowToBoard(row));
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

/**
 * 全局看板批量排序（完整有序 id 列表，手动看板范围：非系统、非任务型）。
 * id 必须都存在且属于手动看板，否则事务回滚。
 */
export function reorderAllBoards(orderedIds: string[]): BoardInfo[] {
  const db = getDb();
  if (orderedIds.length === 0) return listAllBoards();
  db.exec("BEGIN");
  try {
    const stmt = db.prepare("UPDATE boards SET sort_order = ?, updated = ? WHERE id = ? AND is_system = 0 AND task_id IS NULL");
    orderedIds.forEach((id, index) => {
      const res = stmt.run(index, now(), id);
      if (res.changes === 0) {
        throw new Error(`board ${id} does not belong to global manual scope`);
      }
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return listAllBoards();
}

/** 创建看板。空 projectKey 表示全局共享看板（跨项目聚合，与系统看板同层）。
 *  空名抛错。taskId 可选：非空时看板为任务型（id = taskId）。 */
export function createBoard(projectKey: string, name: string, taskId?: string): BoardInfo {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("name must not be empty");
  const id = taskId ?? randomUUID();
  const ts = now();
  const global = !projectKey;
  // 新看板置顶：全局看板取全部手动看板最小 - 1；项目看板取项目内最小 - 1
  const minRow = global
    ? (getDb().prepare("SELECT MIN(sort_order) AS minOrder FROM boards WHERE is_system = 0 AND task_id IS NULL").get() as { minOrder: number | null })
    : (getDb().prepare("SELECT MIN(sort_order) AS minOrder FROM boards WHERE project_key = ?").get(projectKey) as { minOrder: number | null });
  const sortOrder = minRow.minOrder === null ? 0 : minRow.minOrder - 1;
  getDb()
    .prepare("INSERT INTO boards (id, project_key, name, is_system, task_id, sort_order, created, updated) VALUES (?, ?, ?, 0, ?, ?, ?, ?)")
    .run(id, projectKey, trimmed, taskId ?? null, sortOrder, ts, ts);
  return { id, projectKey, name: trimmed, isSystem: false, taskId: taskId ?? null, sortOrder, created: ts, updated: ts };
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
  if (existing) return rowToBoard(existing);

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
  return rowToBoard(row);
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
  return rowToBoard({ ...row, name: trimmed, updated: ts });
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
// 会话清理（仅业务表；RF+yjs 画布由 removeSessionsFromYjsBoards 处理）
// ---------------------------------------------------------------------------

export interface RemoveSessionFromBoardsResult {
  /** 清理的画布节点数（RF+yjs 架构恒 0，保留字段兼容调用方） */
  removedNodes: number;
  /** 受影响看板及其最新 updated（RF+yjs 架构恒空，保留字段兼容调用方） */
  boards: Array<{ boardId: string; updated: number }>;
}

/**
 * 删会话的业务表闭环：任务卡解绑 + 待答记录失效。幂等，无条件执行。
 * 注意：RF+yjs 架构下画布（Y.Doc）不在此清理——删卡由 removeSessionsFromYjsBoards
 * （枚举 yjs 文档删会话卡/占位卡）负责；board_nodes/edges 表为 tldraw 遗留，无生产写入。
 */
export function removeSessionFromBoards(sessionId: string): RemoveSessionFromBoardsResult {
  const ts = now();
  getDb().prepare("UPDATE task_cards SET session_id = NULL, updated = ? WHERE session_id = ?").run(ts, sessionId);
  getDb().prepare("DELETE FROM task_card_questions WHERE session_id = ?").run(sessionId);
  return { removedNodes: 0, boards: [] };
}
