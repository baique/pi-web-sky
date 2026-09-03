"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ReactFlowProvider } from "@xyflow/react";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { useBoardCanvas, TaskCardStatusProvider, type TaskCardStatusValue } from "@/hooks/useBoardCanvas";
import type { WallpaperSettings } from "@/lib/wallpaper-settings";
import { BoardSearchProvider } from "./BoardSearchContext";
import { GlassScopeProvider } from "./GlassScopeContext";
import { BoardLoading } from "./BoardLoading";
import { BoardIdContext } from "@/components/board/BoardIdContext";
import { confirm } from "./ConfirmDialog";
import { BoardSearch } from "./BoardSearch";
import { BoardTopbar } from "./BoardTopbar";
import { SchedulerPanel } from "./SchedulerPanel";

// ssr:false — 画布依赖浏览器环境，仅进入看板模式时下载。
// 加载占位样式与 CanvasStage 数据同步段完全一致（深色半透明 + 浅字 + spinner），
// 与 AppShell 外层 loading 也用同一个 BoardLoading —— 观感上合并成一段连续加载。
const CanvasStage = dynamic(() => import("./CanvasStage").then((m) => m.CanvasStage), {
  ssr: false,
  loading: () => <BoardLoading label="正在加载画布…" />,
});

/**
 * 看板模式容器：主区域整体替换为画布（侧栏保留）。
 * - 无顶部栏：切换看板走侧栏 BoardList；拖入会话、连线走画布自身交互
 * - 画布（tldraw）：无限画布 / 缩放 / 平移 / 拖拽 / 框选；底部工具条含清理失效按钮
 * - 会话卡：双击展开工作台（复用 ChatWindow，嵌卡片内）
 */
export function SessionCanvas({
  boardId,
  taskId,
  newSessionCwd,
  onRunningSessionIdsChange,
  wallSettings,
  updateWallSettings,
}: {
  boardId: string;
  /** 任务看板模式：非空时按任务内会话自动补卡（任务即看板） */
  taskId?: string;
  /** 看板新建会话绑定的工作目录（来自左侧栏 activeCwd） */
  newSessionCwd?: string;
  onExit: () => void;
  onRunningSessionIdsChange?: (ids: Set<string>) => void;
  // 复用 AppShell 同一个 useWallpaperSettings 实例：scrim 滑块与气泡滑块
  // 完全同机制（同 localStorage、同 apply 写 CSS 变量），仅独立变量。
  wallSettings: WallpaperSettings;
  updateWallSettings: (patch: Partial<WallpaperSettings>) => void;
}) {
  const { t } = useI18n();
  const { isDark } = useTheme();
  const board = useBoardCanvas({ boardId, taskId, newSessionCwd });
  // 任务看板：卡片由任务会话驱动（自动补卡/随任务变化），会话卡不可从看板移除；
  // 但清空允许——仅作用于非会话元素（连线/便笺/文本），会话卡片保留。
  const isTaskBoard = Boolean(board.board?.taskId ?? taskId);
  // 任务卡状态上下文值：getStatus 读 running 轮询维护的状态镜像（每次 taskCardStatus 变化重建，
  // 订阅节点随之更新徽章）；register/unregister 稳定引用（TaskCardNode mount/unmount 调用）。
  const taskCardStatusValue = useMemo<TaskCardStatusValue>(
    () => ({
      getStatus: (cardId) => board.taskCardStatus[cardId],
      register: board.registerVisibleTaskCard,
      unregister: board.unregisterVisibleTaskCard,
    }),
    [board.taskCardStatus, board.registerVisibleTaskCard, board.unregisterVisibleTaskCard],
  );
  // 看板搜索框 input ref：Ctrl+F 聚焦目标（仅看板模式生效）
  const searchBoxRef = useRef<HTMLInputElement>(null);
  // Ctrl+F / Cmd+F：聚焦看板搜索框（preventDefault 拦浏览器查找栏）。
  // 捕获阶段挂载，确保先于画布拿到事件；仅看板模式（本组件挂载期间）生效。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "f") return;
      const ae = document.activeElement as HTMLElement | null;
      // 其他输入框（侧栏搜索等）不拦截；看板搜索框已聚焦时保持焦点不打扰
      if (ae && ae !== searchBoxRef.current) {
        const tag = ae.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || ae.isContentEditable) return;
      }
      e.preventDefault();
      searchBoxRef.current?.focus();
      searchBoxRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
  // 手动重载按钮：转圈反馈 + 防重复点击。
  // 同时刷新会话摘要（标题/最后回复）与画布数据——reloadCanvas 内部重拉服务器数据、
  // 清空现有 shapes 并复用物化 effect 重新 hydrate（含复位视角），即「彻底刷新重载」。
  const [reloading, setReloading] = useState(false);
  const reloadBoard = useCallback(async () => {
    if (reloading) return;
    setReloading(true);
    try {
      void board.loadSessionSummaries();
      await board.reloadCanvas();
    } finally {
      // 重物化在 effect 中异步完成，给转圈留一点稳定时间再复位（避免闪烁）
      setTimeout(() => setReloading(false), 800);
    }
  }, [board, reloading]);
  // 运行中集合上报给 AppShell（顶部会话运行状态保持一致）
  useEffect(() => {
    onRunningSessionIdsChange?.(new Set(board.running?.runningSessionIds ?? []));
  }, [board.running, onRunningSessionIdsChange]);

  return (
    // 看板模式容器：完全透明，壁纸/页面背景直接透出。玻璃只挂在卡片上（--board-card-glass），
    // 不整块涂气泡白玻璃——看板底与壁纸不冲突。
    <div
      data-glass-scope="board"
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* 搜索高亮 context：shape 组件（会话卡/便笺）读它渲染 accent 描边。
          必须包住 CanvasStage（RF），让自定义节点能读到 context。 */}
      <GlassScopeProvider value="board">
      <BoardIdContext.Provider value={{ boardId: board.board?.id ?? null, defaultCwd: newSessionCwd ?? null }}>
      <BoardSearchProvider>
      <ReactFlowProvider>
      <TaskCardStatusProvider value={taskCardStatusValue}>
      {!board.loading && (
        <BoardTopbar
          boardName={board.board?.name ?? ""}
          isTaskBoard={isTaskBoard}
          reloading={reloading}
          onReload={() => void reloadBoard()}
          onClear={() => {
            void confirm({
              message: isTaskBoard ? t("boards.clearTaskConfirm") : t("boards.clearConfirm"),
              confirmText: t("boards.clear"),
            }).then((ok) => {
              if (ok) void board.clearBoard();
            });
          }}
          onAddSessionCard={(pos) => board.addNewSessionCard(pos)}
          wallSettings={wallSettings}
          updateWallSettings={updateWallSettings}
          nodes={board.nodes as never}
        />
      )}
      <SchedulerPanel nodes={board.nodes as never} />
      {!board.loading && (
        <div
          style={{
            position: "absolute",
            top: 12,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 40,
          }}
        >
          <BoardSearch inputRef={searchBoxRef} nodes={board.nodes as never} />
        </div>
      )}
      <CanvasStage
        board={board}
        isDark={isDark}
      />
      </TaskCardStatusProvider>
      </ReactFlowProvider>
      </BoardSearchProvider>
      </BoardIdContext.Provider>
      </GlassScopeProvider>
    </div>
  );
}
