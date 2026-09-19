import { randomUUID } from "crypto";
import { getDb } from "./sqlite-db";
import { deleteBoardCascade, renameTaskBoard } from "./board-store";
import { projectIdentityKey } from "./project-identity";
import { scanOneSessionHead } from "./session-scanner";
import { resolveProject } from "./worktree";

export interface Task {
  id: string;
  projectKey: string;
  name: string;
  created: number;
  updated: number;
  pinned: boolean;
  sortOrder: number;
  sessionIds: string[];
  pinnedSessionIds: string[];
}

interface TaskRow {
  id: string;
  projectKey: string;
  name: string;
  created: number;
  updated: number;
  pinned: number;
  sortOrder: number;
}

const now = () => Date.now();

/**
 * 归属写入后失效 /api/sessions 列表缓存（惰性 require 避开 session-reader ↔ task-store 循环）。
 * 归属（assign/unassign/移动/pin）变化时，会话列表必须反映最新 taskId，
 * 否则前端任务分组基于过期的 /api/sessions 快照，新会话会落聊天区。
 */
function invalidateSessionListCache(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./session-reader").invalidateSessionListCache();
  } catch {
    // 循环加载/不可用时忽略——下一次 force 刷新会重建缓存
  }
}

/** 任务下根会话 id（不含 fork 子树，子树由树结构隐含归属）。 */
export function listTaskSessionIds(taskId: string): string[] {
  // Order here is a fallback only: the sidebar re-sorts group contents by
  // session modified-time (desc) + pinned segment, so this must stay in sync
  // directionally (pinned first, then descending recency).
  return getDb()
    .prepare("SELECT session_id FROM session_meta WHERE task_id = ? ORDER BY pinned DESC, updated DESC, rowid DESC")
    .all(taskId)
    .map((r) => (r as { session_id: string }).session_id);
}

/** 全量归属任务会话 id 集合（session_meta.task_id 非空）。
 *  供 /api/sessions 阶段一过滤用——聊天区只返回未归属会话，一次查询无 N+1。 */
export function listAllTaskSessionIds(): Set<string> {
  const rows = getDb()
    .prepare("SELECT session_id FROM session_meta WHERE task_id IS NOT NULL")
    .all() as Array<{ session_id: string }>;
  return new Set(rows.map((r) => r.session_id));
}

/** 一次全表读出的父子链（parentOf 上溯、childrenOf 下探）。
 *  updateTask 的多个根共用同一份快照——否则每个入参 id 都调一次 listDescendantIds，
 *  每次一条全表 SELECT（O(成员数 × 全表)）。 */
function readParentLinks(): { parentOf: Map<string, string | null>; childrenOf: Map<string, string[]> } {
  const parentOf = new Map<string, string | null>();
  const childrenOf = new Map<string, string[]>();
  for (const r of getDb().prepare("SELECT session_id, parent_id FROM session_meta").all() as Array<{ session_id: string; parent_id: string | null }>) {
    parentOf.set(r.session_id, r.parent_id);
    if (r.parent_id !== null) {
      const arr = childrenOf.get(r.parent_id) ?? [];
      arr.push(r.session_id);
      childrenOf.set(r.parent_id, arr);
    }
  }
  return { parentOf, childrenOf };
}

/** 按 childrenOf 递归收集后代 id（不含自身）。广度优先、visited 去重防环。 */
function collectDescendants(childrenOf: Map<string, string[]>, sessionId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([sessionId]);
  const queue = [...(childrenOf.get(sessionId) ?? [])];
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    queue.push(...(childrenOf.get(cur) ?? []));
  }
  return out;
}

/** 按 parent_id 递归收集后代 id（不含自身）。 */
export function listDescendantIds(sessionId: string): string[] {
  return collectDescendants(readParentLinks().childrenOf, sessionId);
}

/** 成员集合归一化：若某成员在库里还有祖先、而该祖先不在集合里，则它也不能留
 *  （归属按整棵子树存，父子不跨任务）。循环到不动点，兼容多层子树。
 *  祖先行已不存在（外部删除留下的悬空 parent_id）不算「祖先在库内」——此时它
 *  就是本任务的根，剪掉会把合法成员误踢出任务。就地修改传入的集合。 */
function normalizeMemberSet(members: Set<string>, parentOf: Map<string, string | null>): void {
  let pruned = true;
  while (pruned) {
    pruned = false;
    for (const sessionId of members) {
      const parent = parentOf.get(sessionId);
      if (!parent || members.has(parent) || !parentOf.has(parent)) continue;
      members.delete(sessionId);
      pruned = true;
    }
  }
}

function getTaskRow(id: string): TaskRow | undefined {
  return getDb()
    .prepare(
      "SELECT id, project_key AS projectKey, name, created, updated, pinned, sort_order AS sortOrder FROM tasks WHERE id = ?",
    )
    .get(id) as TaskRow | undefined;
}

export function listPinnedTaskSessionIds(taskId: string): string[] {
  return getDb()
    .prepare("SELECT session_id FROM session_meta WHERE task_id = ? AND pinned = 1")
    .all(taskId)
    .map((r) => (r as { session_id: string }).session_id);
}

function rowToTask(row: TaskRow): Task {
  return {
    ...row,
    pinned: row.pinned === 1,
    sessionIds: listTaskSessionIds(row.id),
    pinnedSessionIds: listPinnedTaskSessionIds(row.id),
  };
}

/** A single task by id, or undefined. */
export function getTask(id: string): Task | undefined {
  const row = getTaskRow(id);
  return row ? rowToTask(row) : undefined;
}

/** All tasks of one project: pinned segment first, then manual order
 *  (sort_order), then creation time as a stable fallback. */
export function listTasks(projectKey: string): Task[] {
  const rows = getDb()
    .prepare(
      "SELECT id, project_key AS projectKey, name, created, updated, pinned, sort_order AS sortOrder FROM tasks WHERE project_key = ? ORDER BY pinned DESC, sort_order, created, rowid",
    )
    .all(projectKey) as unknown as TaskRow[];
  return rows.map(rowToTask);
}

export function createTask(projectKey: string, name: string): Task {
  const trimmed = name.trim();
  if (!projectKey) throw new Error("projectKey is required");
  if (!trimmed) throw new Error("name must not be empty");
  const id = randomUUID();
  const ts = now();
  // 新任务置顶：sort_order 取当前项目最小值 - 1（与看板 createBoard 一致），
  // 保证新建任务出现在任务区最上方。
  const minRow = getDb()
    .prepare("SELECT MIN(sort_order) AS minOrder FROM tasks WHERE project_key = ?")
    .get(projectKey) as { minOrder: number | null };
  const sortOrder = minRow.minOrder === null ? 0 : minRow.minOrder - 1;
  getDb()
    .prepare("INSERT INTO tasks (id, project_key, name, created, updated, sort_order) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, projectKey, trimmed, ts, ts, sortOrder);
  return { id, projectKey: projectKey, name: trimmed, created: ts, updated: ts, pinned: false, sortOrder, sessionIds: [], pinnedSessionIds: [] };
}

/**
 * Rename and/or replace task membership. `sessionIds` is a full-replace list of
 * subtree roots: each id and all of its descendants (session_meta.parent_id) are
 * added; members whose ancestor falls outside that closure fall back to temp
 * (NULL). Membership is stored per subtree, so a PATCH whose roots close over
 * another task's nodes moves them here (子树压过单节点归属)：两个任务的闭包重叠时，
 * 以最后一个 PATCH 的闭包为准，而不是「永不碰其它任务」。
 *
 * 不变量：子会话不能单独移出任务——祖先仍是本任务成员时，子会话就保持在任务内
 * （提交 [根] 时闭包会连带子孙；宁可不对「单独移出子会话」作出响应，也不让聊天区
 * 出现父不在、子单飞的孤儿根）。
 *
 * 「移出任务」由这里的成员规范化承担：提交的剩余成员列表里，祖先已不在集合的成员
 * 一律被剪掉（整棵子树一起走），不需要单独的 unassign 子树入口。
 * Returns null when the task does not exist.
 */
export function updateTask(
  id: string,
  patch: { name?: string; sessionIds?: string[]; pinned?: boolean; sortOrder?: number },
): Task | null {
  const db = getDb();
  const existing = getTaskRow(id);
  if (!existing) return null;

  db.exec("BEGIN");
  try {
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (!trimmed) throw new Error("name must not be empty");
      db.prepare("UPDATE tasks SET name = ?, updated = ? WHERE id = ?").run(trimmed, now(), id);
      // 任务型看板名随任务同步（看板未创建则 0 行无害）
      renameTaskBoard(id, trimmed);
    }
    if (patch.pinned !== undefined) {
      db.prepare("UPDATE tasks SET pinned = ?, updated = ? WHERE id = ?").run(
        patch.pinned ? 1 : 0,
        now(),
        id,
      );
    }
    if (patch.sortOrder !== undefined) {
      db.prepare("UPDATE tasks SET sort_order = ?, updated = ? WHERE id = ?").run(
        patch.sortOrder,
        now(),
        id,
      );
    }
    if (patch.sessionIds !== undefined) {
      // 入参是「根 id 列表」的闭包视图：加/减都以整棵子树为单位，避免子会话留在任务里当孤儿根。
      // 父子链只读一次（多个根的展开 + 归一化共用同一份快照）。
      const { parentOf, childrenOf } = readParentLinks();
      const next = new Set<string>();
      for (const sessionId of patch.sessionIds) {
        next.add(sessionId);
        for (const d of collectDescendants(childrenOf, sessionId)) next.add(d);
      }
      // 归一化：入参里「祖先已被剔除」的成员不能留。前端拖出父会话时提交的是
      // flat 剩余成员列表（仍含子会话 id），不归一化就会父走子留、子会话在任务区当根。
      normalizeMemberSet(next, parentOf);
      const current = new Set(listTaskSessionIds(id));
      const ts = now();
      // 加侧只 UPDATE：行由创建链路（ensureSessionMetaRow）/扫描器/路由层
      // （ensureSessionRows）建全列行。此处不能 INSERT——同步事务里 await 不了文件 I/O，
      // 而插缺列局部行（缺 path/project_key/created）会让会话从聊天区消失、任务区显示 1970。
      const assign = db.prepare("UPDATE session_meta SET task_id = ?, updated = ? WHERE session_id = ?");
      const unassign = db.prepare("UPDATE session_meta SET task_id = NULL, updated = ? WHERE session_id = ?");
      for (const sessionId of next) if (!current.has(sessionId)) assign.run(id, ts, sessionId);
      for (const sessionId of current) if (!next.has(sessionId)) unassign.run(ts, sessionId);
      db.prepare("UPDATE tasks SET updated = ? WHERE id = ?").run(ts, id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (patch.sessionIds !== undefined) invalidateSessionListCache();
  return rowToTask(getTaskRow(id)!);
}

/**
 * Bulk-reorder tasks within one project. `orderedIds` is the full ordered
 * list of task ids for one pinned segment (caller splits pinned/unpinned);
 * each id must belong to the project. sort_order values are written as the
 * array position (0-based), preserving relative order.
 */
export function reorderTasks(projectKey: string, orderedIds: string[]): Task[] {
  const db = getDb();
  if (orderedIds.length === 0) return listTasks(projectKey);
  db.exec("BEGIN");
  try {
    const stmt = db.prepare("UPDATE tasks SET sort_order = ?, updated = ? WHERE id = ? AND project_key = ?");
    orderedIds.forEach((id, index) => {
      const res = stmt.run(index, now(), id, projectKey);
      if (res.changes === 0) {
        throw new Error(`task ${id} does not belong to project ${projectKey}`);
      }
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return listTasks(projectKey);
}

/** Delete the task; all its sessions fall back to temp (task_id = NULL).
 *  任务型看板（boards.task_id = 任务 id）连带级联删除。 */
export function deleteTask(id: string): void {
  const db = getDb();
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE session_meta SET task_id = NULL, updated = ? WHERE task_id = ?").run(
      now(),
      id,
    );
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    // 任务卡级联：该任务看板（board_id = 任务 id）下的任务卡 + 依赖线 + 待答问题清掉，
    // 防孤儿任务卡（任务卡节点/边已由 deleteBoardCascade 删，这里清业务表）。
    db.prepare(
      "DELETE FROM task_card_links WHERE card_id IN (SELECT id FROM task_cards WHERE board_id = ?) OR target_card_id IN (SELECT id FROM task_cards WHERE board_id = ?)",
    ).run(id, id);
    db.prepare("DELETE FROM task_card_questions WHERE card_id IN (SELECT id FROM task_cards WHERE board_id = ?)").run(id);
    db.prepare("DELETE FROM task_cards WHERE board_id = ?").run(id);
    // 任务即看板：删任务连带删其看板（含 nodes/edges/view）
    deleteBoardCascade(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  invalidateSessionListCache();
}

/** Session's current task id, or null when it is a temp session. */
export function taskForSession(sessionId: string): string | null {
  const row = getDb()
    .prepare("SELECT task_id FROM session_meta WHERE session_id = ?")
    .get(sessionId) as { task_id: string | null } | undefined;
  return row?.task_id ?? null;
}

/** Session's current task name, or null when it is a temp session. */
export function taskNameForSession(sessionId: string): string | null {
  const row = getDb()
    .prepare(
      "SELECT t.name FROM session_meta m JOIN tasks t ON t.id = m.task_id WHERE m.session_id = ?",
    )
    .get(sessionId) as { name: string } | undefined;
  return row?.name ?? null;
}

/** 新建会话落盘即建全列索引行（先于会话真正运行）。
 *  调用方拿到的 path/cwd/project_key/parent 等此时全部已知——会话从出生就是
 *  完整索引行，读取（列表/任务区/看板）不再依赖扫描器补列，也不退化扫盘。
 *  ON CONFLICT 只补索引列、不碰 task_id/pinned/title（归属/置顶/改名各自管）；
 *  `first_message` 只补空（COALESCE）——调用方不传就保留库里已有的首条消息。
 *  `taskId` 只在 INSERT 时写入（归属继承用）：已存在的行归属各自管，upsert 不覆盖。
 *  INSERT 列清单显式列全 13 列（`last_reply` 显式 NULL）——不依赖建表默认值。 */
export function ensureSessionMetaRow(sessionId: string, row: {
  path: string;
  cwd: string;
  projectKey: string;
  parentId?: string;
  firstMessage?: string;
  title?: string;
  taskId?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO session_meta
         (session_id, task_id, updated, pinned, path, cwd, project_key, title, first_message, parent_id, created, modified, last_reply)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(session_id) DO UPDATE SET
         path = excluded.path,
         cwd = excluded.cwd,
         project_key = excluded.project_key,
         -- first_message 只补空：调用方不传（undefined）时不再把已有的首条消息擦成 NULL。
         first_message = COALESCE(session_meta.first_message, excluded.first_message),
         parent_id = excluded.parent_id,
         created = excluded.created,
         modified = excluded.modified`,
    )
    .run(
      sessionId,
      row.taskId ?? null,
      now(),
      row.path,
      row.cwd,
      row.projectKey,
      row.title ?? null,
      row.firstMessage ?? null,
      row.parentId ?? null,
      now(),
      now(),
    );
  invalidateSessionListCache();
}

/**
 * 给「会话已经在磁盘上、库里却还没行」的场景补一条**全列**行：定位文件 → 读 header → upsert。
 * 先查行（有行直接返回，完全不碰文件）；无行才按 id 解析文件。
 *
 * 为什么不能退回插「局部行」：只写 session_id/updated/title(pinned) 的行缺 path/project_key/created，
 * 会被聊天区的 `project_key = ?` 过滤掉（会话消失到下一轮扫描）、任务区显示 1970-01-01（V4）。
 * 同时补 `parent_id`（磁盘 header.parentSession 反查）：归属守卫（hasForeignTaskAncestor）
 * 只看库内 parent_id——补行时不写父，「库里还没行」的会话在守卫眼里就是无祖先的顶层行
 * （带上跨任务祖先拖入别的任务会被错误放行）。反查不到父（父行未建/父文件已消失）则留空。
 * 文件也找不到时返回 false 且报错可见——调用方保持原语义（不抛错），但绝不写半行。
 */
async function ensureRowForSession(sessionId: string): Promise<boolean> {
  if (getDb().prepare("SELECT 1 FROM session_meta WHERE session_id = ?").get(sessionId)) return true;
  // 动态导入避开 session-reader ↔ task-store 的循环加载（session-reader 反向动态引本模块）。
  const { resolveSessionPath, resolveSessionIdByPath } = await import("./session-reader");
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) {
    console.error(`[pi-web] 会话行补建失败：找不到会话文件 session=${sessionId}`);
    return false;
  }
  const head = scanOneSessionHead(filePath);
  if (!head) {
    console.error(`[pi-web] 会话行补建失败：会话文件无有效 header session=${sessionId} path=${filePath}`);
    return false;
  }
  const project = await resolveProject(head.cwd);
  const parentId = head.parentSessionPath
    ? ((await resolveSessionIdByPath(head.parentSessionPath)) ?? undefined)
    : undefined;
  ensureSessionMetaRow(sessionId, {
    path: filePath,
    cwd: head.cwd,
    projectKey: projectIdentityKey(project?.projectRoot ?? head.cwd),
    parentId,
    firstMessage: head.firstMessage || undefined,
  });
  return true;
}

/** 批量为「库内无行」的会话补全列行（PATCH 全量替换前由路由层调用）。
 *  为什么在事务外：建行要读会话文件（`resolveSessionPath` miss 时会目录扫描），
 *  在 `updateTask` 的事务里 await 文件 I/O 会长时间持写锁。
 *  单个 id 失败不抛错也不阻塞其余 id（失败已由 ensureRowForSession 报错可见）。 */
export async function ensureSessionRows(sessionIds: string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    try {
      await ensureRowForSession(sessionId);
    } catch (error) {
      console.error(
        `[pi-web] 会话行补建异常 session=${sessionId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/** 归属写入前的祖先守卫：该会话沿 session_meta.parent_id 上溯的任一祖先，是否带着
 *  **非空且不属于 taskId** 的归属。
 *
 *  为什么归属入口必须查：「归属按整棵子树存」是写库侧的不变量，但把「父在任务 A 的
 *  会话」归到任务 B 会造出跨任务父子——而 updateTask 的成员规范化与扫描器的归属收敛
 *  会反过来把它剪掉/拉回，两个方向互相纠正、永不收敛（看板画布落点、聊天区拖拽都是
 *  可达入口）。上溯时用 visited 防脏环；祖先行不在库里（悬空 parent_id）不算冲突，
 *  它就是本任务的根。
 *  导出供路由在 assign* 拒绝后给出准确的状态码/原因（409 vs 404）。 */
export function hasForeignTaskAncestor(sessionId: string, taskId: string): boolean {
  // 一次全表读同时拿 parent 链与归属（本函数在每次归属写入前跑，别读两遍库）。
  const parentOf = new Map<string, string | null>();
  const taskOf = new Map<string, string | null>();
  for (const r of getDb().prepare("SELECT session_id, parent_id, task_id FROM session_meta").all() as Array<{ session_id: string; parent_id: string | null; task_id: string | null }>) {
    parentOf.set(r.session_id, r.parent_id);
    taskOf.set(r.session_id, r.task_id);
  }
  const seen = new Set<string>([sessionId]);
  let current = parentOf.get(sessionId) ?? null;
  while (current && !seen.has(current)) {
    seen.add(current);
    const ancestorTask = taskOf.get(current) ?? null;
    if (ancestorTask !== null && ancestorTask !== taskId) return true;
    current = parentOf.get(current) ?? null;
  }
  return false;
}

/**
 * 把一个会话原子归属到任务（任务不存在返回 false）。会刷新任务的 updated
 * 使置顶/最近排序生效；会话原本在其他任务下则移动。
 * 会话创建完成时由服务端调用，避免前端两跳 PATCH 造成的“先临时区后任务”窗口。
 *
 * 无行会话先在**同一调用内**补全列行再归属（见 ensureRowForSession）；补不出行返回 false，
 * 保证「返回 true」永远等价于「归属已落库」。
 * 祖先已属于其它任务时拒绝（返回 false + console.error，不写任何行）：见 hasForeignTaskAncestor。
 * 补行**先于**守卫：库里原本没行的会话，其父链只能靠补行（读磁盘 header）写进 parent_id，
 * 顺序反了守卫就是盲的（无行会话会被当成无祖先的顶层行放行）。
 */
export async function assignSessionToTask(sessionId: string, taskId: string): Promise<boolean> {
  const db = getDb();
  const task = getTaskRow(taskId);
  if (!task) return false;
  // 归属不能靠「先插行为空、等扫描补列」：那正是 V4 的缺列局部行，也是 V1 的病灶。
  if (!(await ensureRowForSession(sessionId))) return false;
  if (hasForeignTaskAncestor(sessionId, taskId)) {
    console.error(
      `[pi-web] 归属被拒绝：祖先属于其它任务 session=${sessionId} task=${taskId}`,
    );
    return false;
  }
  const ts = now();
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE session_meta SET task_id = ?, updated = ? WHERE session_id = ?").run(
      taskId,
      ts,
      sessionId,
    );
    db.prepare("UPDATE tasks SET updated = ? WHERE id = ?").run(ts, taskId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  invalidateSessionListCache();
  return true;
}

/** 归属一条会话及其整棵子树（写库先于任何 UI 刷新；一次事务）。
 *  子孙一律跟随父：否则「父在任务、子 task_id 为空」会让子会话同时出现在
 *  任务区（按树渲染）与聊天区（按 task_id 过滤），即 V1 的两区重复。
 *  根会话无行时同样先补全列行（UPDATE 对无行会话影响 0 行 = 静默写 0 行）。
 *  根的祖先已属于其它任务时拒绝（返回 false + console.error，不写任何行）：否则会造出
 *  跨任务父子，被规范化/收敛反向拉回。补行先于守卫（与 assignSessionToTask 同规则）：
 *  无行会话的父链只能靠补行写进 parent_id，守卫才有得看。 */
export async function assignSessionSubtreeToTask(sessionId: string, taskId: string): Promise<boolean> {
  if (!getTaskRow(taskId)) return false;
  if (!(await ensureRowForSession(sessionId))) return false;
  if (hasForeignTaskAncestor(sessionId, taskId)) {
    console.error(
      `[pi-web] 子树归属被拒绝：祖先属于其它任务 session=${sessionId} task=${taskId}`,
    );
    return false;
  }
  const ts = now();
  const db = getDb();
  db.exec("BEGIN");
  try {
    const stmt = db.prepare("UPDATE session_meta SET task_id = ?, updated = ? WHERE session_id = ?");
    for (const id of [sessionId, ...listDescendantIds(sessionId)]) stmt.run(taskId, ts, id);
    db.prepare("UPDATE tasks SET updated = ? WHERE id = ?").run(ts, taskId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  invalidateSessionListCache();
  return true;
}

/** 库内直接子行在磁盘上的文件路径（只用非空 path）。
 *  给「删父会话时同步改写子行磁盘 header」用：子会话文件可能在子目录里
 *  （`<proj>/<session>/forks/*.jsonl` 等），只平铺一层 `readdirSync(dirname(父文件))`
 *  会漏掉它们，漏斗就会「库已写祖父、磁盘仍指已删父」——下一轮扫描按磁盘把它改回 NULL。
 *  库里有父链与 path，路径就是事实（不新写目录递归）。 */
export function listChildPaths(sessionId: string): string[] {
  const rows = getDb()
    .prepare("SELECT path FROM session_meta WHERE parent_id = ? AND path IS NOT NULL AND path != ''")
    .all(sessionId) as Array<{ path: string }>;
  return rows.map((row) => row.path);
}

/** 会话被删除时，把库内直接子行的 parent_id 改写为祖父（拿不到写入 NULL）。
 *  为什么必须同请求写库：T5 之后「根」判定全来自 session_meta.parent_id——只管磁盘
 *  header 的话，库里子行仍指向已删 id，子会话会以根行呈现（≤30s 的窗口期）。 */
export function reparentSessionChildren(sessionId: string, newParentId: string | null): void {
  getDb()
    .prepare("UPDATE session_meta SET parent_id = ? WHERE parent_id = ?")
    .run(newParentId, sessionId);
  invalidateSessionListCache();
}

/** Pin / unpin a session (region-relative: inside its task group, or in chat).
 *  无行老会话先补全列行（缺列行会被聊天区 project_key 过滤掉），补不出行则不写。 */
export async function setSessionPinned(sessionId: string, pinned: boolean): Promise<void> {
  if (!(await ensureRowForSession(sessionId))) return;
  // 只写 pinned，不刷 updated——与原先 ON CONFLICT SET pinned 的语义一致
  // （updated 是扫描器「年轻行保护」的依据，置顶不该给幽灵行续命）。
  getDb()
    .prepare("UPDATE session_meta SET pinned = ? WHERE session_id = ?")
    .run(pinned ? 1 : 0, sessionId);
  invalidateSessionListCache();
}

/** 改名同步写 session_meta.title（列表索引的标题源）。无行老会话先补全列行
 *  （path/project_key/created 齐全），补不出行则只报错不写半行。 */
export async function setSessionTitle(sessionId: string, title: string): Promise<void> {
  if (!(await ensureRowForSession(sessionId))) return;
  getDb()
    .prepare("UPDATE session_meta SET title = ?, updated = ? WHERE session_id = ?")
    .run(title, now(), sessionId);
  invalidateSessionListCache();
}

/** Drop all task/meta bookkeeping for a session (used on session delete). */
export function unassignSession(sessionId: string): void {
  getDb().prepare("DELETE FROM session_meta WHERE session_id = ?").run(sessionId);
  invalidateSessionListCache();
}

// ── 事件链路写入（agent_start / agent_settled）───────────────────────────────
// 三个函数都**只 UPDATE、不 INSERT**：会话行由创建链路（ensureSessionMetaRow）
// 或扫描器建立，事件不负责补行——否则会留下缺列局部行（path/project_key 为空的
// 1970 行），读取期就得再回退扫盘。库里没行时静默 no-op（UPDATE 影响 0 行）。

/** last_reply 入库上限（与 types.ts 的「截断」语义一致，防大消息撑爆行）。 */
export const LAST_REPLY_MAX = 4000;

/** 会话活跃时间前移（agent_start：运行中会话立刻浮顶）。 */
export function touchSessionActivity(sessionId: string, at: number = now()): void {
  getDb().prepare("UPDATE session_meta SET modified = ? WHERE session_id = ?").run(at, sessionId);
  invalidateSessionListCache();
}

/**
 * 一轮循环真正结束（agent_settled，含用户取消）时落最后一条 assistant 文本 + 活跃时间。
 * 空文本（本轮只有工具调用 / 刚发出就被取消）**不清库**：退化为只刷 modified，
 * 保留库里已有的 last_reply——空字符串不是「一条消息」。
 */
export function recordSessionOutcome(sessionId: string, outcome: { lastReply: string; at: number }): void {
  const text = outcome.lastReply.trim();
  if (!text) {
    touchSessionActivity(sessionId, outcome.at);
    return;
  }
  const stored = text.length > LAST_REPLY_MAX ? text.slice(0, LAST_REPLY_MAX) : text;
  getDb()
    .prepare("UPDATE session_meta SET last_reply = ?, modified = ? WHERE session_id = ?")
    .run(stored, outcome.at, sessionId);
  invalidateSessionListCache();
}

/** 首条用户消息回填（读取路径不再读文件，改由事件补齐；只补空行）。 */
export function fillFirstMessageIfEmpty(sessionId: string, firstMessage: string): void {
  const text = firstMessage.trim();
  if (!text) return;
  getDb()
    .prepare(
      "UPDATE session_meta SET first_message = ? WHERE session_id = ? AND (first_message IS NULL OR first_message = '')",
    )
    .run(text, sessionId);
  invalidateSessionListCache();
}