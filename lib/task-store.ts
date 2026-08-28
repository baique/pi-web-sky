import { randomUUID } from "crypto";
import { getDb } from "./sqlite-db";

export interface Task {
  id: string;
  projectKey: string;
  name: string;
  created: number;
  updated: number;
  pinned: boolean;
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
}

const now = () => Date.now();

function listTaskSessionIds(taskId: string): string[] {
  // Order here is a fallback only: the sidebar re-sorts group contents by
  // session modified-time (desc) + pinned segment, so this must stay in sync
  // directionally (pinned first, then descending recency).
  return getDb()
    .prepare("SELECT session_id FROM session_meta WHERE task_id = ? ORDER BY pinned DESC, updated DESC, rowid DESC")
    .all(taskId)
    .map((r) => (r as { session_id: string }).session_id);
}

function getTaskRow(id: string): TaskRow | undefined {
  return getDb()
    .prepare(
      "SELECT id, project_key AS projectKey, name, created, updated, pinned FROM tasks WHERE id = ?",
    )
    .get(id) as TaskRow | undefined;
}

function listPinnedTaskSessionIds(taskId: string): string[] {
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

/** All tasks of one project, pinned first then newest-updated. */
export function listTasks(projectKey: string): Task[] {
  const rows = getDb()
    .prepare(
      "SELECT id, project_key AS projectKey, name, created, updated, pinned FROM tasks WHERE project_key = ? ORDER BY pinned DESC, updated DESC, created DESC",
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
  getDb()
    .prepare("INSERT INTO tasks (id, project_key, name, created, updated) VALUES (?, ?, ?, ?, ?)")
    .run(id, projectKey, trimmed, ts, ts);
  return { id, projectKey: projectKey, name: trimmed, created: ts, updated: ts, pinned: false, sessionIds: [], pinnedSessionIds: [] };
}

/**
 * Rename and/or replace task membership. `sessionIds` is a full-replace list:
 * the diff only touches this task's members — added ids get task_id set (or
 * moved from another task), removed ids fall back to temp (NULL), members of
 * other tasks are never modified. Returns null when the task does not exist.
 */
export function updateTask(
  id: string,
  patch: { name?: string; sessionIds?: string[]; pinned?: boolean },
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
    }
    if (patch.pinned !== undefined) {
      db.prepare("UPDATE tasks SET pinned = ?, updated = ? WHERE id = ?").run(
        patch.pinned ? 1 : 0,
        now(),
        id,
      );
    }
    if (patch.sessionIds !== undefined) {
      const current = new Set(listTaskSessionIds(id));
      const next = new Set(patch.sessionIds);
      const ts = now();
      const assign = db.prepare(
        "INSERT INTO session_meta (session_id, task_id, updated) VALUES (?, ?, ?) " +
          "ON CONFLICT(session_id) DO UPDATE SET task_id = excluded.task_id, updated = excluded.updated",
      );
      const unassign = db.prepare(
        "UPDATE session_meta SET task_id = NULL, updated = ? WHERE session_id = ?",
      );
      for (const sessionId of patch.sessionIds) {
        if (!current.has(sessionId)) assign.run(sessionId, id, ts);
      }
      for (const sessionId of current) {
        if (!next.has(sessionId)) unassign.run(ts, sessionId);
      }
      db.prepare("UPDATE tasks SET updated = ? WHERE id = ?").run(ts, id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return rowToTask(getTaskRow(id)!);
}

/** Delete the task; all its sessions fall back to temp (task_id = NULL). */
export function deleteTask(id: string): void {
  const db = getDb();
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE session_meta SET task_id = NULL, updated = ? WHERE task_id = ?").run(
      now(),
      id,
    );
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Session's current task id, or null when it is a temp session. */
export function taskForSession(sessionId: string): string | null {
  const row = getDb()
    .prepare("SELECT task_id FROM session_meta WHERE session_id = ?")
    .get(sessionId) as { task_id: string | null } | undefined;
  return row?.task_id ?? null;
}

/**
 * 把一个会话原子归属到任务（任务不存在返回 false）。会刷新任务的 updated
 * 使置顶/最近排序生效；会话原本在其他任务下则移动（ON CONFLICT 更新）。
 * 会话创建完成时由服务端调用，避免前端两跳 PATCH 造成的“先临时区后任务”窗口。
 */
export function assignSessionToTask(sessionId: string, taskId: string): boolean {
  const db = getDb();
  const task = getTaskRow(taskId);
  if (!task) return false;
  const ts = now();
  db.exec("BEGIN");
  try {
    db.prepare(
      "INSERT INTO session_meta (session_id, task_id, updated) VALUES (?, ?, ?) " +
        "ON CONFLICT(session_id) DO UPDATE SET task_id = excluded.task_id, updated = excluded.updated",
    ).run(sessionId, taskId, ts);
    db.prepare("UPDATE tasks SET updated = ? WHERE id = ?").run(ts, taskId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return true;
}

/** Pin / unpin a session (region-relative: inside its task group, or in chat). */
export function setSessionPinned(sessionId: string, pinned: boolean): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO session_meta (session_id, task_id, updated, pinned) VALUES (?, NULL, ?, ?) " +
      "ON CONFLICT(session_id) DO UPDATE SET pinned = excluded.pinned",
  ).run(sessionId, now(), pinned ? 1 : 0);
}

/** Drop all task/meta bookkeeping for a session (used on session delete). */
export function unassignSession(sessionId: string): void {
  getDb().prepare("DELETE FROM session_meta WHERE session_id = ?").run(sessionId);
}