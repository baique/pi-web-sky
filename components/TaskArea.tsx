"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { FolderIcon } from "./FileIcons";
import { AnimatedDropdown } from "./AnimatedDropdown";
import { dropdownDirection } from "@/lib/dropdown-direction";

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

/**
 * 任务卡片默认展开的会话数：全部置顶会话 + 最近 N 个非置顶会话。
 * 超出的部分折叠，由卡片底部的“加载更多”按钮展开。
 */
export const TASK_SESSION_PREVIEW_LIMIT = 5;

interface TaskGroup {
  task: TaskGroupUi;
  /** 会话列表渲染器：showAll=true 时渲染任务下全部会话。 */
  content: (showAll: boolean) => ReactNode;
  /** 任务下会话根节点总数（含分叉子树），用于“加载更多”计数。 */
  sessionCount: number;
  /** 置顶会话根节点数（默认全部展示）。 */
  pinnedCount: number;
  /** 任务下全部会话数（含 fork 子树），用于删除确认文案。 */
  sessionTotal: number;
}

interface Props {
  groups: TaskGroup[];
  /** 当前选中的会话 id：选中会话属于某个任务时自动展开该任务卡片。 */
  selectedSessionId?: string | null;
  /** 运行中会话 id 集合：任务行显示蓝色数字徽记（任务内运行中会话数）。 */
  runningSessionIds?: Set<string>;
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
  /** 任务卡片拖拽排序：上报一个区内完整的新顺序（置顶/非置顶分别调用）。 */
  onReorderTasks: (orderedIds: string[]) => void;
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

const TASK_MIME = "application/x-task-id";

function TaskCard({
  task,
  content,
  sessionCount,
  pinnedCount,
  sessionTotal,
  runningCount,
  activeSessionId,
  onDropAssign,
  onRename,
  onDelete,
  onNewSession,
  onTogglePin,
  onDragStartTask,
  onDragOverTask,
  onDropTask,
  onDragEndTask,
  isDragging,
  dropBefore,
  dropAfter,
}: {
  task: TaskGroupUi;
  content: (showAll: boolean) => ReactNode;
  sessionCount: number;
  pinnedCount: number;
  sessionTotal: number;
  /** 任务内运行中会话数（>0 时行前显示蓝色数字徽记）。 */
  runningCount?: number;
  /** 当前选中的会话 id；属于本任务时自动展开卡片。 */
  activeSessionId?: string | null;
  onDropAssign: (taskId: string, sessionId: string) => void;
  onRename: (taskId: string, name: string) => void;
  onDelete: (taskId: string) => void;
  onNewSession: (taskId: string, projectKey?: string) => void;
  onTogglePin: (taskId: string) => void;
  onDragStartTask: (task: TaskGroupUi) => void;
  /** 返回是否允许落位（同区）；true 时 TaskArea 记录插入位置。 */
  onDragOverTask: (targetId: string, before: boolean) => boolean;
  /** 任务拖拽落位到本卡片（同区，由 TaskArea 计算新顺序并上报）。 */
  onDropTask: (targetId: string) => void;
  onDragEndTask: () => void;
  isDragging: boolean;
  /** 落点指示：插到本卡片上方/下方（排序语义，用横线表示）。 */
  dropBefore: boolean;
  dropAfter: boolean;
}) {
  const { t } = useI18n();
  /** 任务卡片默认收起：用户创建的任务默认折叠，点击展开；
   *  选中会话属于本任务时自动展开（会话切换后卡片保持展开）。 */
  const [collapsed, setCollapsed] = useState(true);
  /** 选中会话属于本任务时自动展开（会话切换后卡片保持展开）。 */
  const sessionActive = activeSessionId != null && task.sessionIds.includes(activeSessionId);
  useEffect(() => {
    if (sessionActive) setCollapsed(false);
  }, [sessionActive]);
  /** 任务会话默认只展示置顶 + 最近 5 个；点击“加载更多”后展示全部。 */
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 删除确认气泡方向：下方空间不足时向上展开（防滚动容器边缘被 overflow 裁剪）。 */
  const [confirmUp, setConfirmUp] = useState(false);
  /** 更多（⋮）下拉：打开态 + 展开方向（下方空间不足时向上） */
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreUp, setMoreUp] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  /** 删除确认气泡容器（点击气泡内部不关闭）。 */
  const confirmRef = useRef<HTMLDivElement>(null);

  // 菜单/确认气泡打开时：点击它们外任意处 / Escape 关闭（捕获阶段监听，避免被 stopPropagation 拦掉）。
  useEffect(() => {
    if (!moreOpen && !confirmDelete) return;
    const onPointerDown = (ev: PointerEvent) => {
      const t = ev.target as Node;
      if (actionsRef.current?.contains(t) || confirmRef.current?.contains(t)) return;
      setMoreOpen(false);
      setConfirmDelete(false);
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setMoreOpen(false);
        setConfirmDelete(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreOpen, confirmDelete]);

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
    // 任务拖拽（排序）：同区才允许落位。视觉用上/下边框线（dropBefore/dropAfter），
    // 不设背景高亮——背景 + 左侧竖线是“会话拖入任务”的分配语义。
    if (e.dataTransfer.types.includes(TASK_MIME)) {
      const rect = e.currentTarget.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      const allowed = onDragOverTask(task.id, before);
      setDragOver(false);
      if (allowed) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }
      return;
    }
    // 会话拖拽：分配到此任务。
    if (!e.dataTransfer.types.includes(SESSION_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(true);
  }, [onDragOverTask, task.id]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const sessionId = e.dataTransfer.getData(SESSION_MIME);
    if (sessionId) {
      onDropAssign(task.id, sessionId);
      return;
    }
    // 任务拖拽落位（同区才走到这；跨区 dragover 已禁止）。
    if (e.dataTransfer.types.includes(TASK_MIME)) {
      onDropTask(task.id);
    }
  }, [onDropAssign, task.id, onDropTask]);

  const handleDragStartTask = useCallback((e: React.DragEvent) => {
    // 排除按钮/输入等交互元素：只有卡片空白区域可拖拽排序。
    const t = e.target as HTMLElement;
    if (t.closest("button, input, textarea, a, [role=menuitem]")) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData(TASK_MIME, task.id);
    e.dataTransfer.effectAllowed = "move";
    onDragStartTask(task);
  }, [task, onDragStartTask]);

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
        // 会话拖入任务（分配语义）：左侧竖线亮起。
        background: dragOver
          ? "color-mix(in srgb, var(--accent) 8%, transparent)"
          : "transparent",
        border: "none",
        boxShadow: dragOver ? "inset 2px 0 0 var(--accent)" : "none",
        // 任务排序（排序语义）：上/下边框横线指示插入位置。
        borderTop: dropBefore ? "2px solid var(--accent)" : "none",
        borderBottom: dropAfter ? "2px solid var(--accent)" : "none",
        opacity: isDragging ? 0.4 : 1,
        transition: "background 0.12s, box-shadow 0.12s",
      }}
    >
      {/* Group header — whole row toggles the task body (only meaningful when
          the task has members). React-state hover, no manual style writes.
          Draggable: only the header row is the drag source (so the drag ghost
          carries the task, not its sessions). */}
      <div
        draggable
        onDragStart={handleDragStartTask}
        onDragEnd={onDragEndTask}
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
        {renaming ? (
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
            <span
              aria-hidden="true"
              style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, color: "var(--text-dim)", cursor: "default", pointerEvents: "none" }}
            >
              <FolderIcon size={13} open={!collapsed} />
            </span>
            <span title={`${task.name} · ${formatRelativeTime(task.created)}`} style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {task.name}
            </span>
            {runningCount != null && runningCount > 0 && (
              <span
                title={t("sidebar.taskRunning", { count: runningCount })}
                style={{
                  flexShrink: 0,
                  minWidth: 16,
                  height: 16,
                  padding: "0 5px",
                  borderRadius: 999,
                  background: "var(--accent)",
                  color: "#fff",
                  fontSize: 10,
                  fontWeight: 700,
                  lineHeight: "16px",
                  textAlign: "center",
                  boxSizing: "border-box",
                }}
              >
                {runningCount}
              </span>
            )}
            {task.pinned && !renaming && !confirmDelete && (
              <span title={t("sidebar.pinned")} style={{ display: "inline-flex", flexShrink: 0, color: "var(--accent)" }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 17v5" />
                  <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
                </svg>
              </span>
            )}
            {(hovered || moreOpen || confirmDelete) && !renaming && (
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
                    background: "var(--popover-glass)",
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
                      onClick={(e) => {
                        e.stopPropagation();
                        setMoreOpen(false);
                        setConfirmUp(actionsRef.current ? dropdownDirection(actionsRef.current, 96) : false);
                        setConfirmDelete(true);
                      }}
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

      {/* 删除确认气泡 —— 挂在操作区容器内（见 actionsRef），方向自适应防 overflow 裁剪 */}
      {confirmDelete && (
        <div
          ref={confirmRef}
          role="alertdialog"
          style={{
            position: "absolute",
            ...(confirmUp
              ? { bottom: "calc(100% + 4px)" }
              : { top: "calc(100% + 4px)" }),
            right: 0,
            zIndex: 121,
            width: 236,
            boxSizing: "border-box",
            padding: 10,
            display: "flex", flexDirection: "column", gap: 8,
            background: "var(--popover-glass)",
            backdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
            WebkitBackdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
            border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
            borderRadius: 9,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
          }}
        >
          <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--text)" }}>
            {t("sidebar.deleteTaskConfirm", { name: task.name, count: sessionTotal })}
          </div>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete(task.id); setConfirmDelete(false); }}
              style={{ height: 24, padding: "0 10px", background: "color-mix(in srgb, #ef4444 12%, transparent)", border: "none", borderRadius: 5, color: "#ef4444", fontSize: 11, fontWeight: 600, cursor: "pointer" }}
            >
              {t("sidebar.delete")}
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
              style={{ height: 24, padding: "0 10px", background: "var(--side-input)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer" }}
            >
              {t("sidebar.cancel")}
            </button>
          </div>
        </div>
      )}

              </span>
            )}
          </>
        )}
      </div>

      {/* Task sessions */}
      {!collapsed && (
        <>
          <div style={{ paddingBottom: 3 }}>{content(showAllSessions)}</div>
          {!showAllSessions && sessionCount > pinnedCount + TASK_SESSION_PREVIEW_LIMIT && (
            <button
              type="button"
              onClick={() => setShowAllSessions(true)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: "100%", boxSizing: "border-box",
                margin: "2px 0", padding: 0,
                background: "transparent", border: "none",
                color: "var(--text-dim)", fontSize: 11, cursor: "pointer",
                transition: "color 0.12s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              {t("sidebar.loadMoreSessions", { count: sessionCount - pinnedCount - TASK_SESSION_PREVIEW_LIMIT })}
            </button>
          )}
        </>
      )}

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
  selectedSessionId,
  runningSessionIds,
  newTaskOpen,
  onNewTaskOpenChange,
  onNewTask,
  onRenameTask,
  onDeleteTask,
  onNewSessionFromTask,
  onToggleTaskPin,
  onDropSessionToTask,
  onReorderTasks,
}: Props) {
  const { t } = useI18n();
  const [newTaskName, setNewTaskName] = useState("");
  const [createHovered, setCreateHovered] = useState(false);
  const [cancelHovered, setCancelHovered] = useState(false);
  const newTaskRef = useRef<HTMLInputElement>(null);
  /** 拖拽中的任务（整卡拖动）。{ id, pinned } 用于同区判断。 */
  const [dragTask, setDragTask] = useState<{ id: string; pinned: boolean } | null>(null);
  /** 当前 hover 的落点：{ targetId, before }（插到目标前/后）。state 用于渲染边框指示。 */
  const [dropIndicator, setDropIndicator] = useState<{ targetId: string; before: boolean } | null>(null);

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

  /** 拖拽开始：记录源任务（用于同区判断）。 */
  const handleDragStartTask = useCallback((task: TaskGroupUi) => {
    setDragTask({ id: task.id, pinned: Boolean(task.pinned) });
    setDropIndicator(null);
  }, []);

  /** 拖拽结束：清状态。落位已在 drop 时通过 onReorderTasks 上报。 */
  const handleDragEndTask = useCallback(() => {
    setDragTask(null);
    setDropIndicator(null);
  }, []);

  /**
   * dragover 到某张卡片：仅同区（pinned 一致）允许落位，记录插入位置。
   * 跨区返回 false（不 preventDefault → 浏览器显示禁止光标）。
   */
  const handleDragOverTask = useCallback(
    (targetId: string, before: boolean): boolean => {
      if (!dragTask || dragTask.id === targetId) return false;
      const target = groups.find((g) => g.task.id === targetId);
      if (!target) return false;
      if (Boolean(target.task.pinned) !== dragTask.pinned) return false;
      setDropIndicator({ targetId, before });
      return true;
    },
    [dragTask, groups],
  );

  /**
   * drop 到某张卡片（同区）：把拖拽源从原位置移除，插入到目标前/后，
   * 组装成完整新顺序上报。跨区 drop 不会走到这（dragover 已禁止）。
   */
  const handleDropTask = useCallback(
    (targetId: string) => {
      const pos = dropIndicator;
      if (!dragTask || !pos || pos.targetId !== targetId) {
        handleDragEndTask();
        return;
      }
      const ids = groups.map((g) => g.task.id);
      const from = ids.indexOf(dragTask.id);
      const to = ids.indexOf(targetId);
      if (from === -1 || to === -1) {
        handleDragEndTask();
        return;
      }
      const next = [...ids];
      next.splice(from, 1);
      const insertAt = next.indexOf(targetId) + (pos.before ? 0 : 1);
      next.splice(insertAt, 0, dragTask.id);
      handleDragEndTask();
      onReorderTasks(next);
    },
    [dragTask, groups, handleDragEndTask, onReorderTasks, dropIndicator],
  );

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

      {groups.map(({ task, content, sessionCount, pinnedCount, sessionTotal }, index) => {
        const prev = index > 0 ? groups[index - 1].task : null;
        const divider = prev?.pinned && !task.pinned;
        // 任务内运行中会话数（徽记）：任一关联会话在运行中即显示蓝色数字
        const runningCount = runningSessionIds
          ? task.sessionIds.filter((sid) => runningSessionIds.has(sid)).length
          : 0;
        return (
          <Fragment key={task.id}>
            {divider && (
              <div style={{ height: 1, margin: "3px 6px", background: "color-mix(in srgb, var(--border) 55%, transparent)" }} />
            )}
            <TaskCard
              task={task}
              content={content}
              sessionCount={sessionCount}
              pinnedCount={pinnedCount}
              sessionTotal={sessionTotal}
              runningCount={runningCount}
              activeSessionId={selectedSessionId}
              onDropAssign={onDropSessionToTask}
              onRename={(id, name) => void onRenameTask(id, name)}
              onDelete={(id) => void onDeleteTask(id)}
              onNewSession={(id, projectKey) => onNewSessionFromTask(id, projectKey)}
              onTogglePin={onToggleTaskPin}
              onDragStartTask={handleDragStartTask}
              onDragOverTask={handleDragOverTask}
              onDropTask={handleDropTask}
              onDragEndTask={handleDragEndTask}
              isDragging={dragTask?.id === task.id}
              dropBefore={dropIndicator?.targetId === task.id && dropIndicator.before}
              dropAfter={dropIndicator?.targetId === task.id && !dropIndicator.before}
            />
          </Fragment>
        );
      })}
    </div>
  );
}