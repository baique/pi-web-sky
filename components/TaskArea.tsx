"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { FolderIcon } from "./FileIcons";
import { AnimatedDropdown } from "./AnimatedDropdown";

/** Local mirror of lib/task-store's Task — keeps the client bundle free of
 *  server-only modules (node:sqlite). */
export interface TaskGroupUi {
  id: string;
  name: string;
  created: number;
  sessionIds: string[];
  pinned?: boolean;
  pinnedSessionIds?: string[];
}

interface TaskGroup {
  task: TaskGroupUi;
  content: ReactNode;
}

interface Props {
  groups: TaskGroup[];
  newTaskOpen: boolean;
  onNewTaskOpenChange: (open: boolean) => void;
  onNewTask: (name: string) => void;
  onRenameTask: (taskId: string, name: string) => void;
  onDeleteTask: (taskId: string) => void;
  onNewSessionFromTask: (taskId: string, projectKey?: string) => void;
  /** Toggle the task-level "pinned to the top of its region" flag. */
  onToggleTaskPin: (taskId: string) => void;
  /** Drop target: assign the dragged session to this task. */
  onDropSessionToTask: (taskId: string, sessionId: string) => void;
}

const SESSION_MIME = "text/session-id";

/** Compact relative time — card tooltip only (the row hides the timestamp). */
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

const bubbleIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);
const pinIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
  </svg>
);

function TaskCard({
  task,
  content,
  onDropAssign,
  onRename,
  onDelete,
  onNewSession,
  onTogglePin,
}: {
  task: TaskGroupUi;
  content: ReactNode;
  onDropAssign: (taskId: string, sessionId: string) => void;
  onRename: (taskId: string, name: string) => void;
  onDelete: (taskId: string) => void;
  onNewSession: (taskId: string, projectKey?: string) => void;
  onTogglePin: (taskId: string) => void;
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 更多（⋮）下拉：打开态 + 展开方向（下方空间不足时向上） */
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreUp, setMoreUp] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  // 菜单打开时：点击菜单外任意处 / Escape 关闭（捕获阶段监听，避免被 stopPropagation 拦掉）。
  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (ev: PointerEvent) => {
      if (actionsRef.current && !actionsRef.current.contains(ev.target as Node)) {
        setMoreOpen(false);
      }
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreOpen]);

  // 打开菜单前测可用空间：按钮下方放不下菜单则向上展开。
  const handleMoreClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (moreOpen) {
      setMoreOpen(false);
      return;
    }
    const btn = (e.currentTarget as HTMLElement).getBoundingClientRect();
    let node = (e.currentTarget as HTMLElement).parentElement;
    let container: Element | null = null;
    while (node) {
      const st = getComputedStyle(node);
      if (st.overflowY === "auto" || st.overflowY === "scroll" || st.overflowY === "overlay") {
        container = node;
        break;
      }
      node = node.parentElement;
    }
    const cRect = container
      ? container.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight };
    const MENU_HEIGHT_EST = 3 * 34 + 12; // 菜单三项估算高 + 内边距
    const spaceBelow = cRect.bottom - btn.bottom;
    const spaceAbove = btn.top - cRect.top;
    const fitsBelow = spaceBelow >= MENU_HEIGHT_EST;
    const fitsAbove = spaceAbove >= MENU_HEIGHT_EST;
    setMoreUp(!fitsBelow && (fitsAbove || spaceAbove > spaceBelow));
    setMoreOpen(true);
  }, [moreOpen]);

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

  const iconStyle = { flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, padding: 0, background: "transparent", border: "1px solid transparent", borderRadius: 7, color: "var(--text-muted)", cursor: "pointer", transition: "background 0.12s, color 0.12s" };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      style={{
        position: "relative",
        margin: "0 4px 2px",
        borderRadius: 6,
        background: dragOver
          ? "color-mix(in srgb, var(--accent) 8%, transparent)"
          : "transparent",
        border: "none",
        boxShadow: dragOver ? "inset 2px 0 0 var(--accent)" : "none",
        transition: "background 0.12s, box-shadow 0.12s",
      }}
    >
      {/* Group header — whole row toggles the task body (only meaningful when
          the task has members). React-state hover, no manual style writes. */}
      <div
        role={task.sessionIds.length > 0 ? "button" : undefined}
        aria-expanded={task.sessionIds.length > 0 ? !collapsed : undefined}
        tabIndex={task.sessionIds.length > 0 ? 0 : undefined}
        onClick={() => { if (task.sessionIds.length > 0) setCollapsed((v) => !v); }}
        onKeyDown={(e) => {
          if (task.sessionIds.length === 0) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setCollapsed((v) => !v);
          }
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: "flex", alignItems: "center", gap: 4, minHeight: 38,
          padding: "3px 8px 3px 5px",
          borderRadius: 6,
          background: hovered ? "var(--side-hover)" : "transparent",
          cursor: task.sessionIds.length > 0 ? "pointer" : "default",
          transition: "background 0.12s",
        }}
      >
        {confirmDelete ? (
          <>
            <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {t("sidebar.deleteTaskConfirm", { name: task.name })}
            </span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete(task.id); setConfirmDelete(false); }}
              onMouseDown={(e) => e.stopPropagation()}
              style={{ height: 22, padding: "0 8px", flexShrink: 0, background: "color-mix(in srgb, #ef4444 12%, transparent)", border: "none", borderRadius: 5, color: "#ef4444", fontSize: 11, fontWeight: 600, cursor: "pointer" }}
            >
              {t("sidebar.delete")}
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
              onMouseDown={(e) => e.stopPropagation()}
              style={{ height: 22, padding: "0 8px", flexShrink: 0, background: "var(--side-input)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer" }}
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
            onMouseDown={(e) => e.stopPropagation()}
            autoFocus
            style={{ flex: 1, minWidth: 0, fontSize: 12, padding: "5px 8px", border: "1px solid var(--accent)", borderRadius: 5, outline: "none", background: "var(--side-input)", color: "var(--text)", height: 30 }}
          />
        ) : (
          <>
            {task.sessionIds.length > 0 ? (
              <span
                aria-hidden="true"
                style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, color: "var(--text-dim)", cursor: "default", pointerEvents: "none" }}
              >
                <FolderIcon size={13} open={!collapsed} />
              </span>
            ) : (
              <span style={{ width: 20, flexShrink: 0 }} />
            )}
            <span title={`${task.name} · ${formatRelativeTime(task.created)}`} style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {task.name}
            </span>
            {task.pinned && !renaming && !confirmDelete && (
              <span title={t("sidebar.pinned")} style={{ display: "inline-flex", flexShrink: 0, color: "var(--accent)" }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 17v5" />
                  <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
                </svg>
              </span>
            )}
            {(hovered || moreOpen) && !renaming && !confirmDelete && (
              <span ref={actionsRef} style={{ position: "relative", display: "flex", gap: 3, flexShrink: 0, alignItems: "center" }}>
                <button
                  type="button"
                  title={t("sidebar.newTaskSession")}
                  onClick={(e) => { e.stopPropagation(); onNewSession(task.id); }}
                  style={{ ...iconStyle, width: 28, height: 28 }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--side-active)"; e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
                >
                  {bubbleIcon}
                </button>
                <button type="button" title={t("sidebar.rename")} onClick={(e) => { e.stopPropagation(); setRenameValue(task.name); setRenaming(true); setMoreOpen(false); }} style={{ ...iconStyle, width: 28, height: 28 }} onMouseEnter={(e) => { e.currentTarget.style.background = "var(--side-active)"; e.currentTarget.style.color = "var(--accent)"; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}>
                  {pencilIcon}
                </button>
                <button
                  type="button"
                  title={t("sidebar.moreActions")}
                  aria-expanded={moreOpen}
                  aria-haspopup="menu"
                  onClick={handleMoreClick}
                  style={{ ...iconStyle, width: 28, height: 28, background: moreOpen ? "var(--side-active)" : "transparent", color: moreOpen ? "var(--accent)" : "var(--text-muted)" }}
                  onMouseEnter={(e) => { if (moreOpen) return; e.currentTarget.style.background = "var(--side-active)"; e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(e) => { if (moreOpen) return; e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="5" r="1.4" fill="currentColor" />
                    <circle cx="12" cy="12" r="1.4" fill="currentColor" />
                    <circle cx="12" cy="19" r="1.4" fill="currentColor" />
                  </svg>
                </button>

                <AnimatedDropdown
                  open={moreOpen}
                  up={moreUp}
                  style={{
                    position: "absolute",
                    top: moreUp ? "auto" : "calc(100% + 4px)",
                    bottom: moreUp ? "calc(100% + 4px)" : "auto",
                    right: 0,
                    zIndex: 120,
                    minWidth: 148,
                    background: "var(--panel-glass)",
                    backdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
                    WebkitBackdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
                    border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
                    borderRadius: 9,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
                    padding: 4,
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 1 }} role="menu">
                    <button
                      role="menuitem"
                      onClick={(e) => { e.stopPropagation(); setMoreOpen(false); onTogglePin(task.id); }}
                      style={{
                        display: "flex", alignItems: "center", gap: 8, width: "100%",
                        padding: "7px 10px", border: "none", borderRadius: 6,
                        background: "transparent", color: task.pinned ? "var(--accent)" : "var(--text)",
                        cursor: "pointer", fontSize: 12, textAlign: "left",
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--side-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                    >
                      <span style={{ flexShrink: 0, display: "inline-flex" }}>{pinIcon}</span>
                      {task.pinned ? t("sidebar.unpinTask") : t("sidebar.pinTask")}
                    </button>
                    <button
                      role="menuitem"
                      onClick={(e) => { e.stopPropagation(); setMoreOpen(false); setRenameValue(task.name); setRenaming(true); }}
                      style={{
                        display: "flex", alignItems: "center", gap: 8, width: "100%",
                        padding: "7px 10px", border: "none", borderRadius: 6,
                        background: "transparent", color: "var(--text)",
                        cursor: "pointer", fontSize: 12, textAlign: "left",
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--side-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                    >
                      <span style={{ flexShrink: 0, display: "inline-flex" }}>{pencilIcon}</span>
                      {t("sidebar.rename")}
                    </button>
                    <button
                      role="menuitem"
                      onClick={(e) => { e.stopPropagation(); setMoreOpen(false); setConfirmDelete(true); }}
                      style={{
                        display: "flex", alignItems: "center", gap: 8, width: "100%",
                        padding: "7px 10px", border: "none", borderRadius: 6,
                        background: "transparent", color: "#ef4444",
                        cursor: "pointer", fontSize: 12, textAlign: "left",
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.10)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                    >
                      <span style={{ flexShrink: 0, display: "inline-flex" }}>{trashIcon}</span>
                      {t("sidebar.deleteTask")}
                    </button>
                  </div>
                </AnimatedDropdown>
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
 * Tasks section header: a section label row with an always-visible "+" that
 * opens an inline create row right below the label (so the entry point never
 * scrolls away no matter how many tasks exist). New tasks appear at the top
 * of the group list.
 */
export function TaskArea({
  groups,
  newTaskOpen,
  onNewTaskOpenChange,
  onNewTask,
  onRenameTask,
  onDeleteTask,
  onNewSessionFromTask,
  onToggleTaskPin,
  onDropSessionToTask,
}: Props) {
  const { t } = useI18n();
  const [newTaskName, setNewTaskName] = useState("");
  const [createHovered, setCreateHovered] = useState(false);
  const [cancelHovered, setCancelHovered] = useState(false);
  const newTaskRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (newTaskOpen) newTaskRef.current?.focus();
  }, [newTaskOpen]);

  const commitNewTask = useCallback(() => {
    const name = newTaskName.trim();
    if (!name) return;
    onNewTask(name);
    setNewTaskName("");
    onNewTaskOpenChange(false);
  }, [newTaskName, onNewTask, onNewTaskOpenChange]);

  return (
    <div style={{ paddingBottom: 4 }}>
      {newTaskOpen && (
        <div
          style={{
            display: "flex", alignItems: "center", gap: 4,
            margin: "0 4px 4px",
            padding: "0 8px",
            height: 32,
            boxSizing: "border-box",
            background: "var(--side-input)",
            border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
            borderRadius: 6,
          }}
        >
          <input
            ref={newTaskRef}
            value={newTaskName}
            onChange={(e) => setNewTaskName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitNewTask();
              if (e.key === "Escape") { onNewTaskOpenChange(false); setNewTaskName(""); }
            }}
            onBlur={() => { onNewTaskOpenChange(false); setNewTaskName(""); }}
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
            title={t("sidebar.create")}
            aria-label={t("sidebar.create")}
            disabled={!newTaskName.trim()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={commitNewTask}
            onMouseEnter={() => setCreateHovered(true)}
            onMouseLeave={() => setCreateHovered(false)}
            style={{
              flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
              width: 22, height: 22, padding: 0,
              background: createHovered && newTaskName.trim() ? "var(--side-hover)" : "transparent",
              border: "none", borderRadius: 5,
              color: newTaskName.trim() ? "var(--accent)" : "var(--text-dim)",
              cursor: newTaskName.trim() ? "pointer" : "default",
              transition: "background 0.12s",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </button>
          <button
            type="button"
            title={t("sidebar.cancel")}
            aria-label={t("sidebar.cancel")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { onNewTaskOpenChange(false); setNewTaskName(""); }}
            onMouseEnter={() => setCancelHovered(true)}
            onMouseLeave={() => setCancelHovered(false)}
            style={{
              flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
              width: 22, height: 22, padding: 0,
              background: cancelHovered ? "var(--side-hover)" : "transparent",
              border: "none", borderRadius: 5,
              color: cancelHovered ? "var(--text-muted)" : "var(--text-dim)",
              cursor: "pointer",
              transition: "background 0.12s, color 0.12s",
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
            </svg>
          </button>
        </div>
      )}

      {groups.map(({ task, content }, index) => {
        const prev = index > 0 ? groups[index - 1].task : null;
        const divider = prev?.pinned && !task.pinned;
        return (
          <Fragment key={task.id}>
            {divider && (
              <div style={{ height: 1, margin: "3px 6px", background: "color-mix(in srgb, var(--border) 55%, transparent)" }} />
            )}
            <TaskCard
              task={task}
              content={content}
              onDropAssign={onDropSessionToTask}
              onRename={(id, name) => void onRenameTask(id, name)}
              onDelete={(id) => void onDeleteTask(id)}
              onNewSession={(id, projectKey) => onNewSessionFromTask(id, projectKey)}
              onTogglePin={onToggleTaskPin}
            />
          </Fragment>
        );
      })}
    </div>
  );
}