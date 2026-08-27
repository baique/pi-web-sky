"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { Task } from "@/lib/task-store";

const SESSION_MIME = "text/session-id";

interface TaskGroup {
  task: Task;
  content: ReactNode;
}

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  groups: TaskGroup[];
  /** Total sessions across tasks (current project) for the header badge. */
  sessionCount: number;
  onNewTask: (name: string) => void;
  onRenameTask: (taskId: string, name: string) => void;
  onDeleteTask: (taskId: string) => void;
  onNewSessionFromTask: (taskId: string) => void;
  /** Drop target: assign the dragged session to this task. */
  onDropSessionToTask: (taskId: string, sessionId: string) => void;
}

function IconButton({
  title,
  onClick,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 22, height: 22, padding: 0, flexShrink: 0,
        background: "transparent", border: "1px solid transparent", borderRadius: 5,
        color: "var(--text-muted)", cursor: "pointer",
        transition: "background 0.12s, color 0.12s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = danger ? "rgba(239,68,68,0.12)" : "var(--side-active)";
        e.currentTarget.style.color = danger ? "#ef4444" : "var(--text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--text-muted)";
      }}
    >
      {children}
    </button>
  );
}

const pencilIcon = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
  </svg>
);
const trashIcon = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>
);
const plusIcon = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <line x1="5" y1="1" x2="5" y2="9" />
    <line x1="1" y1="5" x2="9" y2="5" />
  </svg>
);

/**
 * Collapsible task area: task groups (name + member sessions) plus an inline
 * "new task" row. Task rows are HTML5 drag-drop targets for session rows;
 * dropping assigns the dragged session to that task.
 */
export function TaskArea({
  collapsed,
  onToggle,
  groups,
  sessionCount,
  onNewTask,
  onRenameTask,
  onDeleteTask,
  onNewSessionFromTask,
  onDropSessionToTask,
}: Props) {
  const { t } = useI18n();
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskName, setNewTaskName] = useState("");
  const newTaskRef = useRef<HTMLInputElement>(null);
  const [renameTaskId, setRenameTaskId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [dragOverTaskId, setDragOverTaskId] = useState<string | null>(null);

  // Select-all once edits mount/expand so retyping the name is instant.
  useEffect(() => {
    if (newTaskOpen) newTaskRef.current?.focus();
  }, [newTaskOpen]);
  useEffect(() => {
    if (renameTaskId) {
      const id = requestAnimationFrame(() => renameRef.current?.select());
      return () => cancelAnimationFrame(id);
    }
  }, [renameTaskId]);

  const commitNewTask = useCallback(() => {
    const name = newTaskName.trim();
    if (!name) return;
    onNewTask(name);
    setNewTaskName("");
    setNewTaskOpen(false);
  }, [newTaskName, onNewTask]);

  const commitRename = useCallback(() => {
    if (!renameTaskId) return;
    const name = renameValue.trim();
    if (name) onRenameTask(renameTaskId, name);
    setRenameTaskId(null);
  }, [renameTaskId, renameValue, onRenameTask]);

  const handleDragOver = useCallback((e: React.DragEvent, taskId: string) => {
    if (!e.dataTransfer.types.includes(SESSION_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverTaskId(taskId);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, taskId: string) => {
    e.preventDefault();
    setDragOverTaskId(null);
    const sessionId = e.dataTransfer.getData(SESSION_MIME);
    if (sessionId) onDropSessionToTask(taskId, sessionId);
  }, [onDropSessionToTask]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        borderBottom: "1px solid var(--border)",
        maxHeight: collapsed ? undefined : "min(46vh, 340px)",
      }}
    >
      {/* Header toggle */}
      <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            flex: 1, minWidth: 0,
            padding: "6px 10px",
            background: "none", border: "none",
            color: "var(--text-muted)", cursor: "pointer",
            fontSize: 11, fontWeight: 600, letterSpacing: "0.05em",
            textTransform: "uppercase", textAlign: "left",
          }}
        >
          <svg
            width="9" height="9" viewBox="0 0 10 10" fill="none"
            stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: collapsed ? "none" : "rotate(90deg)", transition: "transform 0.15s" }}
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("sidebar.tasks")}
          </span>
          <span
            aria-hidden="true"
            style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)" }}
          >
            {groups.length}
          </span>
        </button>
      </div>

      {!collapsed && (
        <div style={{ overflowY: "auto", flexShrink: 1, minHeight: 0, paddingBottom: 4 }}>
          {groups.map(({ task, content }) => (
            <div
              key={task.id}
              onDragOver={(e) => handleDragOver(e, task.id)}
              onDragLeave={() => setDragOverTaskId((cur) => (cur === task.id ? null : cur))}
              onDrop={(e) => handleDrop(e, task.id)}
              style={{
                position: "relative",
                margin: "0 6px 2px",
                borderRadius: 6,
                border: "1px solid transparent",
                background: dragOverTaskId === task.id
                  ? "color-mix(in srgb, var(--accent) 8%, transparent)"
                  : "transparent",
                outline: "none",
              }}
            >
              {/* Top insertion line on drag-over */}
              {dragOverTaskId === task.id && (
                <div
                  aria-hidden="true"
                  style={{
                    position: "absolute", top: -1, left: 4, right: 4, height: 2.5,
                    background: "var(--accent)", borderRadius: 2, pointerEvents: "none",
                  }}
                />
              )}

              {/* Task header row */}
              <div
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  padding: "4px 6px 4px 8px",
                }}
              >
                {confirmDeleteId === task.id ? (
                  <>
                    <span
                      style={{
                        flex: 1, minWidth: 0, fontSize: 11, color: "var(--text)",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}
                    >
                      {t("sidebar.deleteTaskConfirm", { name: task.name })}
                    </span>
                    <button
                      type="button"
                      onClick={() => { onDeleteTask(task.id); setConfirmDeleteId(null); }}
                      style={{
                        height: 22, padding: "0 8px", flexShrink: 0,
                        background: "#ef4444", border: "none", borderRadius: 5,
                        color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer",
                      }}
                    >
                      {t("sidebar.delete")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(null)}
                      style={{
                        height: 22, padding: "0 8px", flexShrink: 0,
                        background: "var(--side-input)", border: "1px solid var(--border)", borderRadius: 5,
                        color: "var(--text-muted)", fontSize: 11, cursor: "pointer",
                      }}
                    >
                      {t("sidebar.cancel")}
                    </button>
                  </>
                ) : renameTaskId === task.id ? (
                  <input
                    ref={renameRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRenameTaskId(null);
                    }}
                    onBlur={commitRename}
                    autoFocus
                    style={{
                      flex: 1, minWidth: 0,
                      fontSize: 11, padding: "3px 6px",
                      border: "1px solid var(--accent)", borderRadius: 5,
                      outline: "none", background: "var(--side-input)", color: "var(--text)",
                    }}
                  />
                ) : (
                  <>
                    <svg
                      width="11" height="11" viewBox="0 0 24 24" fill="none"
                      stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                      style={{ flexShrink: 0 }}
                    >
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span
                      title={task.name}
                      style={{
                        flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: 500,
                        color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}
                    >
                      {task.name}
                    </span>
                    <span
                      aria-hidden="true"
                      style={{
                        flexShrink: 0, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)",
                      }}
                    >
                      {task.sessionIds.length}
                    </span>
                    <IconButton
                      title={t("sidebar.newTaskSession")}
                      onClick={() => onNewSessionFromTask(task.id)}
                    >
                      {plusIcon}
                    </IconButton>
                    <IconButton
                      title={t("sidebar.rename")}
                      onClick={() => {
                        setRenameTaskId(task.id);
                        setRenameValue(task.name);
                      }}
                    >
                      {pencilIcon}
                    </IconButton>
                    <IconButton
                      title={t("sidebar.deleteTask")}
                      danger
                      onClick={() => setConfirmDeleteId(task.id)}
                    >
                      {trashIcon}
                    </IconButton>
                  </>
                )}
              </div>

              {/* Task sessions */}
              <div style={{ paddingBottom: 2 }}>{content}</div>
            </div>
          ))}

          {/* New task row */}
          <div style={{ padding: "0 10px 6px" }}>
            {newTaskOpen ? (
              <div style={{ display: "flex", gap: 5 }}>
                <input
                  ref={newTaskRef}
                  value={newTaskName}
                  onChange={(e) => setNewTaskName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitNewTask();
                    if (e.key === "Escape") { setNewTaskOpen(false); setNewTaskName(""); }
                  }}
                  onBlur={() => { setNewTaskOpen(false); setNewTaskName(""); }}
                  placeholder={t("sidebar.taskName")}
                  style={{
                    flex: 1, minWidth: 0,
                    fontSize: 11, padding: "4px 7px",
                    border: "1px solid var(--accent)", borderRadius: 5,
                    outline: "none", background: "var(--side-input)", color: "var(--text)",
                  }}
                />
                <button
                  type="button"
                  disabled={!newTaskName.trim()}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={commitNewTask}
                  style={{
                    padding: "0 10px", flexShrink: 0,
                    background: "var(--accent)", border: "none", borderRadius: 5,
                    color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer",
                    opacity: newTaskName.trim() ? 1 : 0.5,
                  }}
                >
                  {t("sidebar.create")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setNewTaskOpen(true)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  width: "100%", padding: "4px 6px",
                  background: "none", border: "none", borderRadius: 5,
                  color: "var(--text-dim)", cursor: "pointer", fontSize: 11, textAlign: "left",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "none";
                  e.currentTarget.style.color = "var(--text-dim)";
                }}
              >
                {plusIcon}
                {t("sidebar.newTask")}
                {sessionCount > 0 && (
                  <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                    · {sessionCount}
                  </span>
                )}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}