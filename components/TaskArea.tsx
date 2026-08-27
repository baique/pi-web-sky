"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";

/** Local mirror of lib/task-store's Task — keeps the client bundle free of
 *  server-only modules (node:sqlite). */
export interface TaskGroupUi {
  id: string;
  name: string;
  created: number;
  sessionIds: string[];
}

interface TaskGroup {
  task: TaskGroupUi;
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

const SESSION_MIME = "text/session-id";

/** Compact relative time ("3m" / "2h" / "4d") — matches the session list. */
function formatRelativeTime(ts: number): string {
  if (!ts) return "";
  const ms = Date.now() - ts;
  const min = Math.floor(ms / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d` : new Date(ts).toLocaleDateString();
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
const folderIcon = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);

function TaskCard({
  task,
  content,
  onDropAssign,
  onRename,
  onDelete,
  onNewSession,
}: {
  task: TaskGroupUi;
  content: ReactNode;
  onDropAssign: (taskId: string, sessionId: string) => void;
  onRename: (taskId: string, name: string) => void;
  onDelete: (taskId: string) => void;
  onNewSession: (taskId: string) => void;
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) {
      const id = requestAnimationFrame(() => renameRef.current?.select());
      return () => cancelAnimationFrame(id);
    }
  }, [renaming]);

  const commitRename = useCallback(() => {
    const name = renameValue.trim();
    if (name) onRename(task.id, name);
    setRenaming(false);
  }, [renameValue, onRename, task.id]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(SESSION_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(true);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const sessionId = e.dataTransfer.getData(SESSION_MIME);
    if (sessionId) onDropAssign(task.id, sessionId);
  }, [onDropAssign, task.id]);

  const iconStyle = { flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, background: "transparent", border: "1px solid transparent", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", transition: "background 0.12s, color 0.12s" };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        margin: "2px 8px 6px",
        borderRadius: 8,
        background: dragOver
          ? "color-mix(in srgb, var(--accent) 12%, transparent)"
          : "var(--tool-bg-glass)",
        border: `1px solid ${dragOver ? "var(--accent)" : "var(--border)"}`,
        borderLeft: dragOver ? "3px solid var(--accent)" : "1px solid var(--border)",
        boxShadow: "0 1px 2px color-mix(in srgb, var(--text) 7%, transparent)",
        overflow: "hidden",
        transition: "border-color 0.12s, background 0.12s, border-left-width 0.12s",
      }}
    >
      {/* Card header */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 8px 7px 5px" }}>
        {confirmDelete ? (
          <>
            <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {t("sidebar.deleteTaskConfirm", { name: task.name })}
            </span>
            <button
              type="button"
              onClick={() => { onDelete(task.id); setConfirmDelete(false); }}
              style={{ height: 22, padding: "0 8px", flexShrink: 0, background: "#ef4444", border: "none", borderRadius: 5, color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer" }}
            >
              {t("sidebar.delete")}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              style={{ height: 22, padding: "0 8px", flexShrink: 0, background: "var(--side-input)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer" }}
            >
              {t("sidebar.cancel")}
            </button>
          </>
        ) : renaming ? (
          <input
            ref={renameRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setRenaming(false);
            }}
            onBlur={commitRename}
            autoFocus
            style={{ flex: 1, minWidth: 0, fontSize: 11, padding: "3px 6px", border: "1px solid var(--accent)", borderRadius: 5, outline: "none", background: "var(--side-input)", color: "var(--text)" }}
          />
        ) : (
          <>
            {task.sessionIds.length > 0 && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setCollapsed((v) => !v); }}
                title={collapsed ? t("sidebar.expandForks") : t("sidebar.collapseForks")}
                aria-expanded={!collapsed}
                style={{ ...iconStyle, width: 16, height: 16, color: "var(--text-dim)" }}
              >
                <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ transform: collapsed ? "none" : "rotate(90deg)", transition: "transform 0.15s" }}>
                  <polyline points="3 2 7 5 3 8" />
                </svg>
              </button>
            )}
            {task.sessionIds.length === 0 && <span style={{ width: 14, flexShrink: 0 }} />}
            <span style={{ color: "var(--text-dim)", display: "inline-flex", flexShrink: 0 }}>{folderIcon}</span>
            <span title={task.name} style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {task.name}
            </span>
            <span title={new Date(task.created).toLocaleString()} style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
              {formatRelativeTime(task.created)}
            </span>
            <span aria-hidden="true" style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
              {task.sessionIds.length}
            </span>
            {hovered && !renaming && !confirmDelete && (
              <span style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                <button type="button" title={t("sidebar.newTaskSession")} onClick={() => onNewSession(task.id)} style={iconStyle}>
                  {plusIcon}
                </button>
                <button type="button" title={t("sidebar.rename")} onClick={() => { setRenameValue(task.name); setRenaming(true); }} style={iconStyle}>
                  {pencilIcon}
                </button>
                <button type="button" title={t("sidebar.deleteTask")} onClick={() => setConfirmDelete(true)} onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.background = "rgba(239,68,68,0.12)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "transparent"; }} style={iconStyle}>
                  {trashIcon}
                </button>
              </span>
            )}
          </>
        )}
      </div>

      {/* Task sessions */}
      {!collapsed && <div style={{ paddingBottom: 3 }}>{content}</div>}
    </div>
  );
}

/**
 * Collapsible task area: task cards (name + created + member sessions) with an
 * inline "new task" row right below the header. Task cards are HTML5 drag-drop
 * targets; dropping a session row assigns it to that task.
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

  useEffect(() => {
    if (newTaskOpen) newTaskRef.current?.focus();
  }, [newTaskOpen]);

  const commitNewTask = useCallback(() => {
    const name = newTaskName.trim();
    if (!name) return;
    onNewTask(name);
    setNewTaskName("");
    setNewTaskOpen(false);
  }, [newTaskName, onNewTask]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        maxHeight: collapsed ? undefined : "min(46vh, 340px)",
        boxShadow: "0 2px 6px -3px color-mix(in srgb, var(--text) 16%, transparent)",
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
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ transform: collapsed ? "none" : "rotate(90deg)", transition: "transform 0.15s" }}>
            <polyline points="3 2 7 5 3 8" />
          </svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("sidebar.tasks")}
          </span>
          <span aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)" }}>
            {groups.length}
          </span>
        </button>
      </div>

      {!collapsed && (
        <div style={{ overflowY: "auto", flexShrink: 1, minHeight: 0, paddingBottom: 4 }}>
          {/* New task row — sits right under the header, above the task cards */}
          {newTaskOpen ? (
            <div
              style={{
                display: "flex", alignItems: "center", gap: 6,
                margin: "2px 10px 8px",
                padding: "0 10px",
                height: 28,
                background: "var(--glass-bg-input)",
                border: "1px solid var(--accent)",
                borderRadius: 7,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" style={{ flexShrink: 0 }}>
                <line x1="5" y1="1" x2="5" y2="9" />
                <line x1="1" y1="5" x2="9" y2="5" />
              </svg>
              <input
                ref={newTaskRef}
                value={newTaskName}
                onChange={(e) => setNewTaskName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitNewTask();
                  if (e.key === "Escape") { setNewTaskOpen(false); setNewTaskName(""); }
                }}
                placeholder={t("sidebar.taskName")}
                style={{
                  flex: 1, minWidth: 0,
                  height: "100%", padding: 0,
                  border: "none", outline: "none",
                  background: "transparent", color: "var(--text)", fontSize: 12,
                }}
              />
              <button
                type="button"
                disabled={!newTaskName.trim()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={commitNewTask}
                style={{
                  flexShrink: 0,
                  background: "none", border: "none", padding: "0 2px",
                  color: newTaskName.trim() ? "var(--accent)" : "var(--text-dim)",
                  fontSize: 11, fontWeight: 600, cursor: newTaskName.trim() ? "pointer" : "default",
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
                width: "100%", padding: "4px 12px",
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

          {groups.map(({ task, content }) => (
            <TaskCard
              key={task.id}
              task={task}
              content={content}
              onDropAssign={onDropSessionToTask}
              onRename={(id, name) => void onRenameTask(id, name)}
              onDelete={(id) => void onDeleteTask(id)}
              onNewSession={(id) => onNewSessionFromTask(id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}