"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { useBoardCanvas, CARD_W, CARD_H } from "@/hooks/useBoardCanvas";
import type { BoardInfo } from "@/lib/board-types";
import { SYSTEM_RUNNING_BOARD_ID } from "@/lib/board-types";
import { BoardToolbar } from "./BoardToolbar";
import type { SessionInfo } from "@/lib/types";

// ssr:false — tldraw 依赖浏览器环境，仅进入看板模式时下载（~1MB）。
const CanvasStage = dynamic(() => import("./CanvasStage").then((m) => m.CanvasStage), {
  ssr: false,
  loading: () => (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
      Loading canvas…
    </div>
  ),
});

/**
 * 看板模式容器：主区域整体替换为画布（侧栏保留）。
 * - 看板栏（返回 / 看板名下拉 / 运行徽标）+ 工具行（添加会话 / 连线 / 清理失效）
 * - 画布（tldraw）：无限画布 / 缩放 / 平移 / 拖拽 / 框选
 * - 展开工作台浮层（portal，M3）
 */
export function SessionCanvas({
  boardId,
  projectKey,
  onExit,
  onOpenSession,
  onRunningSessionIdsChange,
}: {
  boardId: string;
  projectKey?: string;
  onExit: () => void;
  onOpenSession: (session: SessionInfo, isRestore?: boolean) => void;
  onRunningSessionIdsChange?: (ids: Set<string>) => void;
}) {
  const { t } = useI18n();
  const { isDark } = useTheme();
  const board = useBoardCanvas({ boardId, projectKey, onOpenSession: (sid) => onOpenSession({ id: sid } as SessionInfo, false) });
  const [boards, setBoards] = useState<BoardInfo[]>([]);
  const [boardListOpen, setBoardListOpen] = useState(false);

  const loadBoards = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (projectKey) params.set("projectKey", projectKey);
      const res = await fetch(`/api/boards?${params.toString()}`, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { boards: BoardInfo[] };
        setBoards(data.boards);
      }
    } catch {
      // ignore
    }
  }, [projectKey]);

  useEffect(() => {
    void loadBoards();
  }, [loadBoards]);

  // 运行中集合上报给 AppShell（顶部会话运行状态保持一致）
  useEffect(() => {
    onRunningSessionIdsChange?.(new Set(board.running?.runningSessionIds ?? []));
  }, [board.running, onRunningSessionIdsChange]);

  const handleSelectBoard = useCallback((id: string) => {
    setBoardListOpen(false);
    if (id !== boardId) onExit();
  }, [boardId, onExit]);

  return (
    // 看板模式容器：父层做与 AI 消息气泡完全相同的玻璃（--assistant-card-glass + 气泡 blur），
    // 子层（CanvasStage/工具行/画布）全部透明，玻璃只挂这一层，避免嵌套 backdrop-filter 重复模糊。
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "var(--assistant-card-glass)",
        backdropFilter: "blur(var(--glass-blur-bubble)) saturate(var(--glass-saturate))",
        WebkitBackdropFilter: "blur(var(--glass-blur-bubble)) saturate(var(--glass-saturate))",
      }}
    >
      <BoardToolbar
        board={board.board}
        boards={boards}
        runningCount={board.runningCount}
        boardListOpen={boardListOpen}
        onToggleBoardList={() => setBoardListOpen((v) => !v)}
        onSelectBoard={handleSelectBoard}
        onExit={onExit}
        projectKey={projectKey ?? null}
      />
      <CanvasStage
        board={board}
        isDark={isDark}
      />
    </div>
  );
}
