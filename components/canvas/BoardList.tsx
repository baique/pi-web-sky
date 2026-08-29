"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { BoardInfo } from "@/lib/board-types";
import { SYSTEM_RUNNING_BOARD_ID } from "@/lib/board-types";

/**
 * 侧栏「看板」段：系统「运行中」看板 + 当前项目看板列表 + 新建/改名/删除。
 * 点击看板行 → onOpenBoard(id) 进入看板模式（主区域替换为画布）。
 */
export function BoardList({
  projectKey,
  runningCount,
  activeBoardId,
  onOpenBoard,
}: {
  /** 当前项目 key（看板按 projectKey 隔离；空时只显示系统看板） */
  projectKey: string | null;
  /** 全局运行中会话数（系统看板徽标） */
  runningCount: number;
  activeBoardId: string | null;
  onOpenBoard: (boardId: string) => void;
}) {
  const { t } = useI18n();
  const [boards, setBoards] = useState<BoardInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingName, setRenamingName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    const name = renamingName.trim();
    if (!name || busy) return;
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

  const rowStyle = (active: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "5px 10px",
    border: "none",
    background: active ? "var(--side-active)" : "transparent",
    color: "var(--text)",
    cursor: "pointer",
    fontSize: 12.5,
    textAlign: "left",
    borderRadius: 6,
  });

  const iconBtnStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 20,
    height: 20,
    padding: 0,
    border: "none",
    background: "none",
    color: "var(--text-dim)",
    cursor: "pointer",
    borderRadius: 4,
    fontSize: 11,
    flexShrink: 0,
  };

  const system = boards.find((b) => b.isSystem) ?? {
    id: SYSTEM_RUNNING_BOARD_ID,
    projectKey: "",
    name: "running",
    isSystem: true,
    created: 0,
    updated: 0,
    nodeCount: 0,
  };
  const projectBoards = boards.filter((b) => !b.isSystem);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, overflowY: "auto", padding: "4px 6px 10px" }}>
      {loading ? (
        <div style={{ padding: "12px 10px", color: "var(--text-muted)", fontSize: 12 }}>{t("sidebar.loading")}</div>
      ) : (
        <>
          {/* 系统看板 */}
          <div style={{ padding: "6px 8px 2px", fontSize: 10.5, fontWeight: 600, letterSpacing: "0.03em", color: "var(--text-dim)" }}>
            {t("boards.system")}
          </div>
          <button
            type="button"
            onClick={() => onOpenBoard(system.id)}
            style={rowStyle(activeBoardId === system.id)}
            title={t("boards.runningDesc")}
          >
            <span aria-hidden style={{ flexShrink: 0, width: 7, height: 7, borderRadius: "50%", background: runningCount > 0 ? "var(--accent)" : "var(--text-dim)" }} />
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {t("boards.running")}
            </span>
            {runningCount > 0 && (
              <span
                style={{
                  flexShrink: 0,
                  minWidth: 16,
                  height: 16,
                  padding: "0 4px",
                  borderRadius: 999,
                  background: "var(--accent)",
                  color: "#fff",
                  fontSize: 10,
                  fontWeight: 700,
                  lineHeight: "16px",
                  textAlign: "center",
                }}
              >
                {runningCount}
              </span>
            )}
          </button>

          {/* 项目看板 */}
          <div style={{ padding: "10px 8px 2px", fontSize: 10.5, fontWeight: 600, letterSpacing: "0.03em", color: "var(--text-dim)" }}>
            {t("boards.project")}
          </div>
          {projectBoards.length === 0 && (
            <div style={{ padding: "8px 10px", color: "var(--text-muted)", fontSize: 11.5, fontStyle: "italic" }}>
              {t("boards.empty")}
            </div>
          )}
          {projectBoards.map((board) => (
            <div key={board.id} style={{ display: "flex", alignItems: "center", gap: 2 }}>
              {renamingId === board.id ? (
                <input
                  ref={renameInputRef}
                  value={renamingName}
                  onChange={(e) => setRenamingName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void rename(board.id);
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  onBlur={() => void rename(board.id)}
                  placeholder={t("boards.namePlaceholder")}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    margin: "2px 6px",
                    padding: "3px 8px",
                    background: "var(--glass-bg-input)",
                    border: "1px solid var(--accent)",
                    borderRadius: 6,
                    color: "var(--text)",
                    fontSize: 12.5,
                    outline: "none",
                  }}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => onOpenBoard(board.id)}
                  style={rowStyle(activeBoardId === board.id)}
                  title={board.name}
                >
                  <span aria-hidden style={{ flexShrink: 0, width: 7, height: 7, borderRadius: "50%", background: "var(--text-dim)", opacity: 0.6 }} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {board.name}
                  </span>
                  {board.nodeCount > 0 && (
                    <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10.5 }}>{board.nodeCount}</span>
                  )}
                </button>
              )}
              {renamingId !== board.id && (
                <>
                  <button
                    type="button"
                    title={t("boards.rename")}
                    aria-label={t("boards.rename")}
                    onClick={() => { setRenamingId(board.id); setRenamingName(board.name); }}
                    style={iconBtnStyle}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    title={t("boards.delete")}
                    aria-label={t("boards.delete")}
                    onClick={() => setConfirmDeleteId(board.id)}
                    style={iconBtnStyle}
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          ))}

          {/* 新建 */}
          {newOpen ? (
            <input
              ref={newInputRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void create();
                if (e.key === "Escape") setNewOpen(false);
              }}
              onBlur={() => void create()}
              placeholder={t("boards.namePlaceholder")}
              style={{
                margin: "4px 8px",
                padding: "4px 10px",
                background: "var(--glass-bg-input)",
                border: "1px solid var(--accent)",
                borderRadius: 6,
                color: "var(--text)",
                fontSize: 12.5,
                outline: "none",
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => { setNewOpen(true); setNewName(""); }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                margin: "4px 8px",
                padding: "5px 8px",
                border: "none",
                background: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
                borderRadius: 6,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <span style={{ fontSize: 13, lineHeight: 1 }}>+</span>
              {t("boards.new")}
            </button>
          )}

          {/* 删除确认 */}
          {confirmDeleteId && (
            <div
              style={{
                position: "fixed",
                inset: 0,
                zIndex: 1200,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(0,0,0,0.35)",
              }}
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
                <div style={{ color: "var(--text-muted)", marginBottom: 14 }}>
                  {t("boards.deleteConfirm")}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(null)}
                    style={{
                      padding: "5px 12px",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      background: "none",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    {t("boards.cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(confirmDeleteId)}
                    disabled={busy}
                    style={{
                      padding: "5px 12px",
                      border: "none",
                      borderRadius: 6,
                      background: "#dc2626",
                      color: "#fff",
                      cursor: busy ? "default" : "pointer",
                      fontSize: 12,
                      opacity: busy ? 0.6 : 1,
                    }}
                  >
                    {t("boards.delete")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
