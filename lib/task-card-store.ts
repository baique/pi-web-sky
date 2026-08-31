import { randomUUID } from "crypto";
import { getDb } from "./sqlite-db";

// ============================================================================
// 任务卡（工作项卡）元数据 —— SDK-free，参照 task-store 模式。
// 业务字段真相源；画布布局走 board_nodes（kind=taskcard, ref_id=cardId）。
// ============================================================================

export type ReadyStatus = "draft" | "todo";
export type ExecStatus =
  | "not_started"
  | "running"
  | "review"
  | "done"
  | "failed"
  | "abandoned"
  | "waiting_reply";
export type LinkKind = "prerequisite" | "related";

export interface TaskCard {
  id: string;
  boardId: string;
  projectKey: string;
  /** 项目内自增编号（#N，跨看板统一） */
  number: number;
  name: string;
  description: string;
  readyStatus: ReadyStatus;
  execStatus: ExecStatus;
  /** 高1 / 中0 / 低-1 */
  priority: number;
  /** ms epoch；null = 无截止 */
  due: number | null;
  /** 引用文件路径数组 */
  attachments: string[];
  /** 执行工作目录；null = 项目根 */
  cwd: string | null;
  useWorktree: boolean;
  maxRetries: number;
  retryCount: number;
  /** 专属执行会话 id（调度器派发后写入） */
  sessionId: string | null;
  created: number;
  updated: number;
}

export interface TaskCardLink {
  id: string;
  cardId: string;
  targetCardId: string;
  kind: LinkKind;
  created: number;
}

interface TaskCardRow {
  id: string;
  boardId: string;
  projectKey: string;
  number: number;
  name: string;
  description: string;
  readyStatus: ReadyStatus;
  execStatus: ExecStatus;
  priority: number;
  due: number | null;
  attachments: string;
  cwd: string | null;
  useWorktree: number;
  maxRetries: number;
  retryCount: number;
  sessionId: string | null;
  created: number;
  updated: number;
}

const now = () => Date.now();

function rowToCard(row: TaskCardRow): TaskCard {
  return {
    ...row,
    useWorktree: row.useWorktree === 1,
    attachments: JSON.parse(row.attachments) as string[],
  };
}

const CARD_COLUMNS =
  "id, board_id AS boardId, project_key AS projectKey, number, name, description, ready_status AS readyStatus, exec_status AS execStatus, priority, due, attachments, cwd, use_worktree AS useWorktree, max_retries AS maxRetries, retry_count AS retryCount, session_id AS sessionId, created, updated";

function getCardRow(id: string): TaskCardRow | undefined {
  return getDb()
    .prepare(`SELECT ${CARD_COLUMNS} FROM task_cards WHERE id = ?`)
    .get(id) as TaskCardRow | undefined;
}

/** 单张任务卡，或 undefined。 */
export function getCard(id: string): TaskCard | undefined {
  const row = getCardRow(id);
  return row ? rowToCard(row) : undefined;
}

/** 某看板的全部任务卡，按编号升序。 */
export function listCards(boardId: string): TaskCard[] {
  const rows = getDb()
    .prepare(`SELECT ${CARD_COLUMNS} FROM task_cards WHERE board_id = ? ORDER BY number`)
    .all(boardId) as unknown as TaskCardRow[];
  return rows.map(rowToCard);
}

/** 项目内下一编号（MAX(number)+1；空表从 1 起）。 */
function nextCardNumber(projectKey: string): number {
  const row = getDb()
    .prepare("SELECT COALESCE(MAX(number), 0) AS maxNumber FROM task_cards WHERE project_key = ?")
    .get(projectKey) as { maxNumber: number };
  return row.maxNumber + 1;
}

/** 建卡。名称必填非空；编号项目内自增。 */
export function createCard(input: {
  boardId: string;
  projectKey: string;
  name: string;
  description?: string;
  readyStatus?: ReadyStatus;
  priority?: number;
  due?: number | null;
  attachments?: string[];
  cwd?: string | null;
  useWorktree?: boolean;
  maxRetries?: number;
}): TaskCard {
  const name = input.name.trim();
  if (!input.projectKey) throw new Error("projectKey is required");
  if (!input.boardId) throw new Error("boardId is required");
  if (!name) throw new Error("name must not be empty");

  const id = randomUUID();
  const ts = now();
  const number = nextCardNumber(input.projectKey);
  getDb()
    .prepare(
      "INSERT INTO task_cards (id, board_id, project_key, number, name, description, ready_status, exec_status, priority, due, attachments, cwd, use_worktree, max_retries, retry_count, created, updated) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      input.boardId,
      input.projectKey,
      number,
      name,
      input.description ?? "",
      input.readyStatus ?? "draft",
      "not_started",
      input.priority ?? 0,
      input.due ?? null,
      JSON.stringify(input.attachments ?? []),
      input.cwd ?? null,
      input.useWorktree ? 1 : 0,
      input.maxRetries ?? 3,
      0,
      ts,
      ts,
    );
  return rowToCard(getCardRow(id)!);
}

/** 改字段。返回更新后的卡；任务卡不存在返回 null。 */
export function updateCard(
  id: string,
  patch: {
    name?: string;
    description?: string;
    readyStatus?: ReadyStatus;
    execStatus?: ExecStatus;
    priority?: number;
    due?: number | null;
    attachments?: string[];
    cwd?: string | null;
    useWorktree?: boolean;
    maxRetries?: number;
    sessionId?: string | null;
    retryCount?: number;
  },
): TaskCard | null {
  const db = getDb();
  const existing = getCardRow(id);
  if (!existing) return null;

  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  const bump = (column: string, value: string | number | null) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed) throw new Error("name must not be empty");
    bump("name", trimmed);
  }
  if (patch.description !== undefined) bump("description", patch.description);
  if (patch.readyStatus !== undefined) bump("ready_status", patch.readyStatus);
  if (patch.execStatus !== undefined) bump("exec_status", patch.execStatus);
  if (patch.priority !== undefined) bump("priority", patch.priority);
  if (patch.due !== undefined) bump("due", patch.due);
  if (patch.attachments !== undefined) bump("attachments", JSON.stringify(patch.attachments));
  if (patch.cwd !== undefined) bump("cwd", patch.cwd);
  if (patch.useWorktree !== undefined) bump("use_worktree", patch.useWorktree ? 1 : 0);
  if (patch.maxRetries !== undefined) bump("max_retries", patch.maxRetries);
  if (patch.sessionId !== undefined) bump("session_id", patch.sessionId);
  if (patch.retryCount !== undefined) bump("retry_count", patch.retryCount);
  if (sets.length === 0) return rowToCard(existing);

  bump("updated", now());
  db.prepare(`UPDATE task_cards SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  return rowToCard(getCardRow(id)!);
}

/**
 * 删任务卡：事务内级联删 task_card_links / task_card_questions 与该卡的
 * taskcard 画布节点（含以它为端点的依赖边），bump 所属看板 updated。
 * node/边清理用内联 SQL（board-store.deleteNode 自开事务，不能嵌套调用）。
 */
export function deleteCard(id: string): void {
  const db = getDb();
  const card = getCardRow(id);
  if (!card) return;

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM task_card_links WHERE card_id = ? OR target_card_id = ?").run(id, id);
    db.prepare("DELETE FROM task_card_questions WHERE card_id = ?").run(id);

    // 找该卡的 taskcard 画布节点（可能多个/可能没有）
    const nodes = db
      .prepare("SELECT id, board_id AS boardId FROM board_nodes WHERE kind = 'taskcard' AND ref_id = ?")
      .all(id) as Array<{ id: string; boardId: string }>;
    for (const node of nodes) {
      db.prepare("DELETE FROM board_edges WHERE board_id = ? AND (from_id = ? OR to_id = ?)").run(
        node.boardId,
        node.id,
        node.id,
      );
      db.prepare("DELETE FROM board_nodes WHERE id = ?").run(node.id);
      db.prepare("UPDATE boards SET updated = ? WHERE id = ?").run(now(), node.boardId);
    }

    db.prepare("DELETE FROM task_cards WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
