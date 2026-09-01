import { randomUUID } from "crypto";
import { getDb } from "./sqlite-db";
import { SYSTEM_RUNNING_BOARD_ID } from "./board-types";

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

const READY_STATUSES = new Set<ReadyStatus>(["draft", "todo"]);
const EXEC_STATUSES = new Set<ExecStatus>([
  "not_started",
  "running",
  "review",
  "done",
  "failed",
  "abandoned",
  "waiting_reply",
]);

function assertReadyStatus(v: ReadyStatus | undefined): void {
  if (v !== undefined && !READY_STATUSES.has(v)) throw new Error(`invalid readyStatus: ${String(v)}`);
}
function assertExecStatus(v: ExecStatus | undefined): void {
  if (v !== undefined && !EXEC_STATUSES.has(v)) throw new Error(`invalid execStatus: ${String(v)}`);
}

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
  assertReadyStatus(input.readyStatus);

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
      input.readyStatus ?? "todo",
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
  if (patch.readyStatus !== undefined) { assertReadyStatus(patch.readyStatus); bump("ready_status", patch.readyStatus); }
  if (patch.execStatus !== undefined) { assertExecStatus(patch.execStatus); bump("exec_status", patch.execStatus); }
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

    // 找该卡的 taskcard 画布节点（可能多个/可能没有；排除只读系统看板）
    const nodes = db
      .prepare("SELECT id, board_id AS boardId FROM board_nodes WHERE kind = 'taskcard' AND ref_id = ? AND board_id != ?")
      .all(id, SYSTEM_RUNNING_BOARD_ID) as Array<{ id: string; boardId: string }>;
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

// ============================================================================
// 依赖（前置/关联）—— 同看板，真相源在 task_card_links，画布边由 syncCardEdges 派生
// ============================================================================

const LINK_COLUMNS =
  "id, card_id AS cardId, target_card_id AS targetCardId, kind, created";

/** 本卡作为依赖方（出边）的全部依赖，按创建序。 */
export function listLinks(cardId: string): TaskCardLink[] {
  return getDb()
    .prepare(`SELECT ${LINK_COLUMNS} FROM task_card_links WHERE card_id = ? ORDER BY created, rowid`)
    .all(cardId) as unknown as TaskCardLink[];
}

/** 其他卡引用本卡（入边：被依赖方视角），按创建序。 */
export function listInboundLinks(cardId: string): TaskCardLink[] {
  return getDb()
    .prepare(`SELECT ${LINK_COLUMNS} FROM task_card_links WHERE target_card_id = ? ORDER BY created, rowid`)
    .all(cardId) as unknown as TaskCardLink[];
}

function assertLinkKind(kind: LinkKind): void {
  if (kind !== "prerequisite" && kind !== "related") {
    throw new Error(`invalid link kind: ${String(kind)}`);
  }
}

/**
 * 加依赖边。跨看板 / 自环 / 目标卡不存在返回 null；重复（UNIQUE 冲突）幂等返回已有行。
 */
export function addLink(
  cardId: string,
  targetCardId: string,
  kind: LinkKind,
): TaskCardLink | null {
  assertLinkKind(kind);
  if (cardId === targetCardId) return null;
  const card = getCard(cardId);
  const target = getCard(targetCardId);
  if (!card || !target) return null;
  if (card.boardId !== target.boardId) return null; // 任务以看板为界，不允许跨看板

  getDb()
    .prepare(
      "INSERT OR IGNORE INTO task_card_links (id, card_id, target_card_id, kind, created) VALUES (?, ?, ?, ?, ?)",
    )
    .run(randomUUID(), cardId, targetCardId, kind, now());
  return getDb()
    .prepare(`SELECT ${LINK_COLUMNS} FROM task_card_links WHERE card_id = ? AND target_card_id = ? AND kind = ?`)
    .get(cardId, targetCardId, kind) as TaskCardLink | undefined ?? null;
}

/** 删依赖边。 */
export function removeLink(id: string): void {
  getDb().prepare("DELETE FROM task_card_links WHERE id = ?").run(id);
}

/**
 * 全量替换某卡的依赖（prerequisite + related）。事务内删旧插新。
 * 目标卡必须存在且同看板，否则抛错（防脏数据）。
 */
export function replaceLinks(
  cardId: string,
  prerequisites: string[],
  related: string[],
): void {
  const db = getDb();
  const card = getCard(cardId);
  if (!card) throw new Error(`task card not found: ${cardId}`);
  const validateTarget = (targetId: string, kind: LinkKind) => {
    if (targetId === cardId) throw new Error(`${kind} target 不能是自身`);
    const target = getCard(targetId);
    if (!target) throw new Error(`${kind} target not found: ${targetId}`);
    if (target.boardId !== card.boardId) {
      throw new Error(`${kind} target 不允许跨看板: ${targetId}`);
    }
  };
  for (const t of prerequisites) validateTarget(t, "prerequisite");
  for (const t of related) validateTarget(t, "related");

  const ts = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM task_card_links WHERE card_id = ?").run(cardId);
    const ins = db.prepare(
      "INSERT OR IGNORE INTO task_card_links (id, card_id, target_card_id, kind, created) VALUES (?, ?, ?, ?, ?)",
    );
    for (const t of prerequisites) ins.run(randomUUID(), cardId, t, "prerequisite", ts);
    for (const t of related) ins.run(randomUUID(), cardId, t, "related", ts);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// ============================================================================
// 派发查询（调度器用）
// ============================================================================

function prerequisitesDone(card: TaskCard): boolean {
  for (const link of listLinks(card.id)) {
    if (link.kind !== "prerequisite") continue;
    const target = getCard(link.targetCardId);
    // 前置卡已被删除视为依赖解除（容忍脏数据）
    if (target && target.execStatus !== "done") return false;
  }
  return true;
}

/**
 * 可派发卡：就绪=todo & (未开始 | 失败且重试未超上限) & 无前置或前置均 done。
 * 按优先级降序、编号升序（高优先级先调度）。
 */
export function listDispatchableCards(): TaskCard[] {
  const rows = getDb()
    .prepare(
      `SELECT ${CARD_COLUMNS} FROM task_cards
       WHERE ready_status = 'todo' AND (exec_status = 'not_started' OR (exec_status = 'failed' AND retry_count < max_retries))
       ORDER BY priority DESC, number`,
    )
    .all() as unknown as TaskCardRow[];
  return rows.map(rowToCard).filter(prerequisitesDone);
}

/** 调度器已派发且正在运行的任务卡数（全局并发闸门用）。 */
export function countRunningDispatched(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM task_cards WHERE exec_status = 'running'")
    .get() as { n: number };
  return row.n;
}

/** 调度器已派发且正在运行的任务卡列表（看板调度状态展示用），按编号升序。 */
export function listRunningDispatched(): TaskCard[] {
  const rows = getDb()
    .prepare(`SELECT ${CARD_COLUMNS} FROM task_cards WHERE exec_status = 'running' ORDER BY number`)
    .all() as unknown as TaskCardRow[];
  return rows.map(rowToCard);
}

/** 按执行状态枚举取卡列表（S3 审核/巡检用），按编号升序。 */
export function listCardsByExecStatus(statuses: ExecStatus[]): TaskCard[] {
  const placeholders = statuses.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT ${CARD_COLUMNS} FROM task_cards WHERE exec_status IN (${placeholders}) ORDER BY number`)
    .all(...statuses) as unknown as TaskCardRow[];
  return rows.map(rowToCard);
}

// ============================================================================
// 待回答队列（S3）—— task_card_questions 表
// ============================================================================

export type QuestionStatus = "pending" | "answered";

export interface TaskCardQuestion {
  id: string;
  cardId: string;
  sessionId: string;
  question: string;
  status: QuestionStatus;
  answer: string | null;
  created: number;
  answered: number | null;
}

interface TaskCardQuestionRow {
  id: string;
  cardId: string;
  sessionId: string;
  question: string;
  status: QuestionStatus;
  answer: string | null;
  created: number;
  answered: number | null;
}

const QUESTION_COLUMNS =
  "id, card_id AS cardId, session_id AS sessionId, question, status, answer, created, answered";

function rowToQuestion(row: TaskCardQuestionRow): TaskCardQuestion {
  return { ...row };
}

/** 建问答记录（AI 提问入队）。返回新记录。 */
export function createQuestion(
  cardId: string,
  sessionId: string,
  question: string,
): TaskCardQuestion {
  const id = randomUUID();
  const ts = Date.now();
  getDb()
    .prepare(
      "INSERT INTO task_card_questions (id, card_id, session_id, question, status, created) VALUES (?, ?, ?, ?, 'pending', ?)",
    )
    .run(id, cardId, sessionId, question, ts);
  return rowToQuestion(getDb().prepare(`SELECT ${QUESTION_COLUMNS} FROM task_card_questions WHERE id = ?`).get(id) as unknown as TaskCardQuestionRow);
}

/** 问答列表：status 过滤（pending/answered/全部），按创建序。 */
export function listQuestions(status?: QuestionStatus | "all"): TaskCardQuestion[] {
  const where = status && status !== "all" ? "WHERE status = ?" : "";
  const params = status && status !== "all" ? [status] : [];
  const rows = getDb()
    .prepare(`SELECT ${QUESTION_COLUMNS} FROM task_card_questions ${where} ORDER BY created`)
    .all(...params) as unknown as TaskCardQuestionRow[];
  return rows.map(rowToQuestion);
}

/** 某卡的全部问答，按创建序。 */
export function listCardQuestions(cardId: string): TaskCardQuestion[] {
  const rows = getDb()
    .prepare(`SELECT ${QUESTION_COLUMNS} FROM task_card_questions WHERE card_id = ? ORDER BY created`)
    .all(cardId) as unknown as TaskCardQuestionRow[];
  return rows.map(rowToQuestion);
}

/** 待回答数（侧栏/看板角标用）。 */
export function countPendingQuestions(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM task_card_questions WHERE status = 'pending'")
    .get() as { n: number };
  return row.n;
}

/** 用户回答：status→answered + answer 落库 + answered 时间。记录不存在返回 null。 */
export function answerQuestion(id: string, answer: string): TaskCardQuestion | null {
  const db = getDb();
  const existing = getDb().prepare(`SELECT ${QUESTION_COLUMNS} FROM task_card_questions WHERE id = ?`).get(id) as TaskCardQuestionRow | undefined;
  if (!existing) return null;
  if (existing.status === "answered") return rowToQuestion(existing);
  const ts = Date.now();
  db.prepare("UPDATE task_card_questions SET status = 'answered', answer = ?, answered = ? WHERE id = ?")
    .run(answer, ts, id);
  return rowToQuestion(getDb().prepare(`SELECT ${QUESTION_COLUMNS} FROM task_card_questions WHERE id = ?`).get(id) as unknown as TaskCardQuestionRow);
}

/** 取一张卡最新的待回答记录（回复队列续会话用），无则 null。 */
export function listAnswerableQuestions(): TaskCardQuestion[] {
  // 卡 exec_status='waiting_reply' 且其最新 answered 记录尚未续会话
  const rows = getDb()
    .prepare(
      `SELECT q.id, q.card_id AS cardId, q.session_id AS sessionId, q.question, q.status, q.answer, q.created, q.answered
       FROM task_card_questions q
       JOIN task_cards c ON c.id = q.card_id
       WHERE q.status = 'answered' AND c.exec_status = 'waiting_reply'
       AND q.id = (SELECT q2.id FROM task_card_questions q2 WHERE q2.card_id = q.card_id AND q2.status='answered' ORDER BY q2.answered DESC, q2.created DESC LIMIT 1)
       ORDER BY q.answered`,
    )
    .all() as unknown as TaskCardQuestionRow[];
  return rows.map(rowToQuestion);
}
