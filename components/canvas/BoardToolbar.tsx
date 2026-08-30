"use client";

import { useI18n } from "@/hooks/useI18n";
import type { BoardInfo } from "@/lib/board-types";

/**
 * 看板栏（chrome 材质）：返回 / 看板名下拉切换 / 运行数徽标 / 新建改名删除。
 * 工具行（添加会话/连线/自动布局/清理失效）由 SessionCanvas 内嵌，M2 接入。
 */
export function BoardToolbar({
  board,
  boards,
  runningCount,
  boardListOpen,
  onToggleBoardList,
  onSelectBoard,
  onExit,
  projectKey,
}: {
  board: BoardInfo | null;
  boards: BoardInfo[];
  runningCount: number;
  boardListOpen: boolean;
  onToggleBoardList: () => void;
  onSelectBoard: (id: string) => void;
  onExit: () => void;
  projectKey: string | null;
}) {
  const { t } = useI18n();

  const chromeStyle: React.CSSProperties = {
    // 看板栏在父层玻璃之上，自身透明（玻璃由 SessionCanvas 提供）
    background: "transparent",
    borderBottom: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
  };

  return (
    <div style={{ flexShrink: 0, ...chromeStyle }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", minHeight: 40 }}>
        {/* 返回 */}
        <button
          type="button"
          onClick={onExit}
          title={t("boards.back")}
          aria-label={t("boards.back")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "4px 10px",
            border: "none",
            background: "none",
            color: "var(--text)",
            cursor: "pointer",
            fontSize: 12.5,
            borderRadius: 7,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
          {t("boards.back")}
        </button>

        {/* 看板名下拉 */}
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <button
            type="button"
            onClick={onToggleBoardList}
            title={t("boards.switchBoard")}
            aria-expanded={boardListOpen}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
              background: "var(--glass-bg-input)",
              color: "var(--text)",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 600,
              borderRadius: 7,
              maxWidth: 260,
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {board?.name ?? ""}
            </span>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" style={{ flexShrink: 0, transform: boardListOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
              <polyline points="2 3.5 5 6.5 8 3.5" />
            </svg>
          </button>

          {/* 运行数徽标（系统看板专属，跨项目计数） */}
          {board?.isSystem && runningCount > 0 && (
            <span
              title={t("boards.runningDesc")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                marginLeft: 8,
                padding: "2px 8px",
                borderRadius: 999,
                background: "color-mix(in srgb, var(--accent) 18%, transparent)",
                color: "var(--accent)",
                fontSize: 11.5,
                fontWeight: 700,
                whiteSpace: "nowrap",
              }}
            >
              <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)" }} />
              {runningCount}
            </span>
          )}

          {boardListOpen && (
            <div
              className="glass-popover"
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                left: 0,
                zIndex: 1100,
                minWidth: 220,
                maxHeight: 320,
                overflowY: "auto",
                padding: 4,
                borderRadius: 10,
                border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
                boxShadow: "0 8px 24px -8px rgba(0,0,0,0.25)",
              }}
            >
              {boards.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => onSelectBoard(b.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    padding: "6px 10px",
                    border: "none",
                    background: board?.id === b.id ? "var(--side-active)" : "none",
                    color: "var(--text)",
                    cursor: "pointer",
                    fontSize: 12.5,
                    textAlign: "left",
                    borderRadius: 6,
                  }}
                  onMouseEnter={(e) => { if (board?.id !== b.id) e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = board?.id === b.id ? "var(--side-active)" : "none"; }}
                >
                  {b.isSystem && (
                    <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }} />
                  )}
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {b.isSystem ? t("boards.running") : b.name}
                  </span>
                  {b.isSystem && runningCount > 0 && (
                    <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10.5 }}>{runningCount}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{ flex: 1 }} />

        {/* 工具按钮组（M2 接入：新建/改名/删除在侧栏 BoardList，画布工具行在下方） */}
        {projectKey && !board?.isSystem && (
          <span style={{ color: "var(--text-dim)", fontSize: 11.5 }}>{projectKey}</span>
        )}
      </div>
    </div>
  );
}
