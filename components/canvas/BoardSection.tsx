"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { BoardInfo } from "@/lib/board-types";
import { BOARD_CANVAS_CHANGED_EVENT } from "@/lib/board-events";

/**
 * 侧栏「看板」栏目：位于会话 tab 内、任务区上方，样式与任务条目一致。
 * - 展开/收起（持久化）
 * - 系统「运行中」看板恒置顶（不可改名/删除/拖拽）
 * - 项目看板行：点击进入看板模式；悬停 [改名] [删除]；拖拽排序（与任务一致）
 * - 新建看板 = 新建任务样式（标题行 + 内联输入）
 */
export function BoardSection({
  projectKey,
  activeBoardId,
  collapsed,
  onToggleCollapsed,
  onOpenBoard,
  refreshKey,
}: {
  projectKey: string | null;
  activeBoardId: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenBoard: (boardId: string) => void;
  /** 外部刷新信号（与任务/会话同源）：变化时重新拉取看板列表 */
  refreshKey?: number;
}) {
  const { t } = useI18n();
  const [boards, setBoards] = useState<BoardInfo[]>([]);
  const [, setLoading] = useState(true);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingName, setRenamingName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 拖拽排序：{ id, pinned 恒 false }（项目看板不分置顶段） */
  const [dragBoard, setDragBoard] = useState<{ id: string } | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ targetId: string; before: boolean } | null>(null);
  const newInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (projectKey) params.set("projectKey", projectKey);
      const res = await fetch(`/api/boards?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { boards: BoardInfo[] };
      setBoards(data.boards);
    } catch {
      // keep last list
    } finally {
      setLoading(false);
    }
  }, [projectKey]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // 画布结构变化（清空/清理失效）→ 刷新节点计数
  useEffect(() => {
    const onChange = () => void load();
    window.addEventListener(BOARD_CANVAS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(BOARD_CANVAS_CHANGED_EVENT, onChange);
  }, [load]);

  useEffect(() => {
    if (newOpen) newInputRef.current?.focus();
  }, [newOpen]);

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  const create = async () => {
    const name = newName.trim();
    if (!name || !projectKey || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectKey, name }),
      });
      if (res.ok) {
        const data = (await res.json()) as { board: BoardInfo };
        setNewName("");
        setNewOpen(false);
        await load();
        onOpenBoard(data.board.id);
      }
    } finally {
      setBusy(false);
    }
  };

  const rename = async (id: string) => {
    if (busy) return;
    const name = renamingName.trim();
    if (!name) {
      // 空名/纯空格：丢弃改名，直接退出重命名态
      setRenamingId(null);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/boards/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        setRenamingId(null);
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/boards/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.ok) {
        setConfirmDeleteId(null);
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  // ---- 拖拽排序（与 TaskArea 相同模式） ----
  const handleDragStart = useCallback((boardId: string) => (e: React.DragEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button, input, textarea")) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData("application/x-board-id", boardId);
    e.dataTransfer.effectAllowed = "move";
    setDragBoard({ id: boardId });
    setDropIndicator(null);
  }, []);

  const handleDragOver = useCallback((targetId: string) => (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("application/x-board-id")) return;
    if (!dragBoard || dragBoard.id === targetId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropIndicator({ targetId, before });
  }, [dragBoard]);

  const handleDrop = useCallback((targetId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    const pos = dropIndicator;
    const fromId = e.dataTransfer.getData("application/x-board-id") || dragBoard?.id;
    if (!fromId || !pos || pos.targetId !== targetId) {
      setDragBoard(null);
      setDropIndicator(null);
      return;
    }
    const ids = boards.filter((b) => !b.isSystem && b.taskId == null).map((b) => b.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(targetId);
    setDragBoard(null);
    setDropIndicator(null);
    if (from === -1 || to === -1 || !projectKey) return;
    const next = [...ids];
    next.splice(from, 1);
    const insertAt = next.indexOf(targetId) + (pos.before ? 0 : 1);
    next.splice(insertAt, 0, fromId);
    void fetch("/api/boards/reorder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectKey, orderedIds: next }),
    }).then((r) => { if (r.ok) return load(); return undefined; }).catch(() => {});
  }, [boards, dropIndicator, dragBoard, projectKey, load]);

  // 任务型看板不混入手动看板列表（任务行本身即入口）；仅展示手动看板。
  const projectBoards = boards.filter((b) => !b.isSystem && b.taskId == null);

  return (
    <div style={{ display: "flex", flexDirection: "column", flexShrink: 0 }}>
      {/* 标题行（样式与任务标题一致） */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 6px 3px 10px" }}>
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0, background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer", color: "var(--text-dim)" }}
        >
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.02em" }}>{t("boards.title")}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform 0.15s" }} aria-hidden="true">
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => setNewOpen((v) => !v)}
          title={t("boards.new")}
          aria-label={t("boards.new")}
          style={{ width: 24, height: 24, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", borderRadius: 5, color: "var(--text-dim)", cursor: "pointer" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--side-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "transparent"; }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <line x1="6" y1="1" x2="6" y2="11" />
            <line x1="1" y1="6" x2="11" y2="6" />
          </svg>
        </button>
      </div>

      {!collapsed && (
        <div style={{ paddingBottom: 4 }}>
          {/* 新建看板（样式同新建任务） */}
          {newOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                margin: "0 4px 4px",
                padding: "0 8px 0 5px",
                height: 32,
                boxSizing: "border-box",
                background: "var(--side-input)",
                border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
                borderRadius: 6,
              }}
            >
              {/* 图标槽：与看板行图标同尺寸同起点，保持文字对齐 */}
              <span aria-hidden style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, color: "var(--text-dim)", cursor: "default", pointerEvents: "none" }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M3 9h18" />
                  <path d="M9 21V9" />
                </svg>
              </span>
              <input
                ref={newInputRef}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void create();
                  if (e.key === "Escape") { setNewOpen(false); setNewName(""); }
                }}
                onBlur={() => {
                  if (newName.trim()) void create();
                  setNewOpen(false);
                  setNewName("");
                }}
                placeholder={t("boards.namePlaceholder")}
                style={{
                  flex: 1, minWidth: 0,
                  height: "100%", padding: 0,
                  border: "none", outline: "none",
                  background: "transparent", color: "var(--text)", fontSize: 12,
                }}
              />
              <button
                type="button"
                title={t("boards.create")}
                aria-label={t("boards.create")}
                disabled={!newName.trim()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void create()}
                style={{
                  flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                  width: 22, height: 22, padding: 0,
                  background: "transparent", border: "none", borderRadius: 5,
                  color: newName.trim() ? "var(--accent)" : "var(--text-dim)",
                  cursor: newName.trim() ? "pointer" : "default",
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </button>
              <button
                type="button"
                title={t("boards.cancel")}
                aria-label={t("boards.cancel")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setNewOpen(false); setNewName(""); }}
                style={{
                  flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                  width: 22, height: 22, padding: 0,
                  background: "transparent", border: "none", borderRadius: 5,
                  color: "var(--text-dim)", cursor: "pointer",
                }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                  <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
                </svg>
              </button>
            </div>
          )}

          {/* 项目看板 */}
          {projectBoards.length === 0 && (
            <div style={{ padding: "6px 10px", color: "var(--text-muted)", fontSize: 11.5, fontStyle: "italic" }}>
              {t("boards.empty")}
            </div>
          )}
          {projectBoards.map((board) => (
            <BoardRow
              key={board.id}
              board={board}
              isActive={activeBoardId === board.id}
              isDragging={dragBoard?.id === board.id}
              dropBefore={dropIndicator?.targetId === board.id && dropIndicator.before}
              dropAfter={dropIndicator?.targetId === board.id && !dropIndicator.before}
              renaming={renamingId === board.id}
              renameValue={renamingName}
              renameInputRef={renameInputRef}
              onRenameValueChange={setRenamingName}
              onStartRename={() => { setRenamingId(board.id); setRenamingName(board.name); }}
              onCommitRename={() => void rename(board.id)}
              onCancelRename={() => setRenamingId(null)}
              onDelete={() => setConfirmDeleteId(board.id)}
              onDragStart={handleDragStart(board.id)}
              onDragEnd={() => { setDragBoard(null); setDropIndicator(null); }}
              onDragOver={handleDragOver(board.id)}
              onDrop={handleDrop(board.id)}
              onOpenBoard={() => onOpenBoard(board.id)}
            />
          ))}
        </div>
      )}

      {/* 删除确认 */}
      {confirmDeleteId && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)" }}
          onClick={() => setConfirmDeleteId(null)}
        >
          <div
            className="glass-panel"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 300,
              padding: 16,
              borderRadius: 12,
              border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
              boxShadow: "0 8px 30px rgba(0,0,0,0.3)",
              color: "var(--text)",
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{t("boards.deleteConfirmTitle")}</div>
            <div style={{ color: "var(--text-muted)", marginBottom: 14 }}>{t("boards.deleteConfirm")}</div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={() => setConfirmDeleteId(null)}
                style={{ padding: "5px 12px", border: "1px solid var(--border)", borderRadius: 6, background: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}
              >
                {t("boards.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void remove(confirmDeleteId)}
                disabled={busy}
                style={{ padding: "5px 12px", border: "none", borderRadius: 6, background: "#dc2626", color: "#fff", cursor: busy ? "default" : "pointer", fontSize: 12, opacity: busy ? 0.6 : 1 }}
              >
                {t("boards.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 单个项目看板行（样式与任务条目完全一致：38px 高、FolderIcon 槽 20px、悬浮操作按钮） */
function BoardRow({
  board,
  isActive,
  isDragging,
  dropBefore,
  dropAfter,
  renaming,
  renameValue,
  renameInputRef,
  onRenameValueChange,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onOpenBoard,
}: {
  board: BoardInfo;
  isActive: boolean;
  isDragging: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  renaming: boolean;
  renameValue: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  onRenameValueChange: (v: string) => void;
  onStartRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onDelete: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onOpenBoard: () => void;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);

  const boardIcon = (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M9 21V9" />
    </svg>
  );

  const boardIconStyle: React.CSSProperties = {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    padding: 0,
    background: "transparent",
    border: "1px solid transparent",
    borderRadius: 7,
    color: "var(--text-muted)",
    cursor: "pointer",
    transition: "background 0.12s, color 0.12s",
  };

  return (
    <div
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{
        margin: "0 4px 2px",
        borderRadius: 6,
        borderTop: dropBefore ? "2px solid var(--accent)" : "none",
        borderBottom: dropAfter ? "2px solid var(--accent)" : "none",
        opacity: isDragging ? 0.4 : 1,
      }}
    >
      {renaming ? (
        <span
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          style={{ display: "flex", alignItems: "center", gap: 4, margin: "3px 6px", padding: "0 0 0 5px", width: "calc(100% - 12px)", boxSizing: "border-box" }}
        >
          {/* 图标槽：与看板行图标同尺寸同起点，保持文字对齐 */}
          <span aria-hidden style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, color: "var(--text-dim)", cursor: "default", pointerEvents: "none" }}>
            {boardIcon}
          </span>
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => onRenameValueChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommitRename();
              if (e.key === "Escape") onCancelRename();
            }}
            onBlur={onCommitRename}
            autoFocus
            placeholder={t("boards.namePlaceholder")}
            style={{ flex: 1, minWidth: 0, fontSize: 12, padding: "5px 8px", border: "1px solid var(--accent)", borderRadius: 5, outline: "none", background: "var(--side-input)", color: "var(--text)", height: 30 }}
          />
        </span>
      ) : (
        <div
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onClick={onOpenBoard}
          data-board-row={board.id}
          title={board.name}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            minHeight: 38,
            padding: "3px 8px 3px 5px",
            borderRadius: 6,
            background: isActive ? "var(--side-active)" : hovered ? "var(--side-hover)" : "transparent",
            cursor: "pointer",
            transition: "background 0.12s",
          }}
        >
          {/* 图标槽：与任务 FolderIcon 同尺寸同起点（20px 槽 + 13px 图标） */}
          <span aria-hidden style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, color: "var(--text-dim)", cursor: "default", pointerEvents: "none" }}>
            {boardIcon}
          </span>
          <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {board.name}
          </span>
          {board.nodeCount > 0 && (
            <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10.5 }}>{board.nodeCount}</span>
          )}
          {hovered && (
            <span style={{ position: "relative", display: "flex", gap: 3, flexShrink: 0, alignItems: "center" }}>
              <button
                type="button"
                title={t("boards.rename")}
                aria-label={t("boards.rename")}
                onClick={(e) => { e.stopPropagation(); onStartRename(); }}
                style={boardIconStyle}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--side-active)"; e.currentTarget.style.color = "var(--accent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              <button
                type="button"
                title={t("boards.delete")}
                aria-label={t("boards.delete")}
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                style={boardIconStyle}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--side-active)"; e.currentTarget.style.color = "#ef4444"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
