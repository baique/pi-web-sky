"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { BoardInfo, BoardCanvas, RunningSnapshot } from "@/lib/board-types";
import { SYSTEM_RUNNING_BOARD_ID } from "@/lib/board-types";
import { BoardToolbar } from "./BoardToolbar";

/**
 * 看板模式容器：主区域整体替换为画布（侧栏保留）。
 * M2 起内嵌 tldraw 无限画布；此文件保持布局壳 + 看板栏 + 工具行 + 数据加载。
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
  const [board, setBoard] = useState<BoardInfo | null>(null);
  const [canvas, setCanvas] = useState<BoardCanvas | null>(null);
  const [running, setRunning] = useState<RunningSnapshot | null>(null);
  const [boards, setBoards] = useState<BoardInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [boardListOpen, setBoardListOpen] = useState(false);

  const loadBoard = useCallback(async () => {
    try {
      setLoading(true);
      const [boardRes, canvasRes] = await Promise.all([
        fetch(`/api/boards/${encodeURIComponent(boardId)}`, { cache: "no-store" }),
        fetch(`/api/boards/${encodeURIComponent(boardId)}/canvas`, { cache: "no-store" }),
      ]);
      if (!boardRes.ok || !canvasRes.ok) {
        setError(`HTTP ${boardRes.status ?? canvasRes.status}`);
        return;
      }
      const b = (await boardRes.json()) as { board: BoardInfo };
      const c = (await canvasRes.json()) as BoardCanvas;
      setBoard(b.board);
      setCanvas(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [boardId]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  // 看板列表（看板栏下拉切换）
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

  // 运行中快照轮询（看板聚合态 + 状态徽标）—— 沿用 2.5s + 后台 tab 暂停策略
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/agent/running", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as RunningSnapshot;
        if (stopped) return;
        setRunning(data);
        onRunningSessionIdsChange?.(new Set(data.runningSessionIds));
      } catch {
        // keep last
      }
    };
    const loop = () => {
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(async () => {
        await poll();
        loop();
      }, 2500);
    };
    void poll();
    loop();
    const onVis = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [onRunningSessionIdsChange]);

  const runningCount = running?.runningSessionIds.length ?? 0;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)" }}>
      <BoardToolbar
        board={board}
        boards={boards}
        runningCount={runningCount}
        boardListOpen={boardListOpen}
        onToggleBoardList={() => setBoardListOpen((v) => !v)}
        onSelectBoard={(id) => {
          setBoardListOpen(false);
          onExit(); // AppShell 用 key 重挂载新看板
        }}
        onExit={onExit}
        projectKey={projectKey ?? null}
      />
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {loading ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
            {t("boards.loadingCanvas")}
          </div>
        ) : error ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: 13 }}>
            {error}
          </div>
        ) : (
          <BoardCanvasView
            boardId={boardId}
            canvas={canvas}
            board={board}
            onOpenSession={onOpenSession}
          />
        )}
      </div>
    </div>
  );
}

import type { SessionInfo } from "@/lib/types";

/** 占位画布视图：M2 替换为 tldraw 引擎。 */
function BoardCanvasView({
  boardId,
  canvas,
  board,
  onOpenSession,
}: {
  boardId: string;
  canvas: BoardCanvas | null;
  board: BoardInfo | null;
  onOpenSession: (session: SessionInfo, isRestore?: boolean) => void;
}) {
  const { t } = useI18n();
  if (boardId === SYSTEM_RUNNING_BOARD_ID) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
        {t("boards.runningEmpty")}
      </div>
    );
  }
  const nodes = canvas?.nodes ?? [];
  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
      {t("boards.emptyCanvas", { count: nodes.length })}
    </div>
  );
}
