"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ReactFlowProvider } from "@xyflow/react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { useBoardCanvas } from "@/hooks/useBoardCanvas";
import type { WallpaperSettings } from "@/lib/wallpaper-settings";
import { BoardSearchProvider } from "./BoardSearchContext";
import { GlassScopeProvider } from "./GlassScopeContext";
import { BoardIdContext } from "@/components/board/BoardIdContext";
import { confirm } from "./ConfirmDialog";
import { BoardSearch } from "./BoardSearch";

// ssr:false — tldraw 依赖浏览器环境，仅进入看板模式时下载（~1MB）。
// 加载占位样式与 CanvasStage 数据同步段完全一致（深色半透明 + 白字 + spinner）。
const CanvasStage = dynamic(() => import("./CanvasStage").then((m) => m.CanvasStage), {
  ssr: false,
  loading: () => (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(8, 14, 30, 0.85)",
        color: "rgba(255, 255, 255, 0.85)",
        fontSize: 13,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            border: "2px solid rgba(255, 255, 255, 0.18)",
            borderTopColor: "rgba(255, 255, 255, 0.9)",
            animation: "spin 0.8s linear infinite",
          }}
        />
        正在加载画布…
      </div>
    </div>
  ),
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
  // 看板搜索框 input ref：Ctrl+F 聚焦目标（仅看板模式生效）
  const searchBoxRef = useRef<HTMLInputElement>(null);
  // Ctrl+F / Cmd+F：聚焦看板搜索框（preventDefault 拦浏览器查找栏）。
  // 捕获阶段挂载，确保先于 tldraw 拿到事件；仅看板模式（本组件挂载期间）生效。
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
  const [scrimOpen, setScrimOpen] = useState(false);
  // 调度器状态（看板左上角展示：正在运行 xxx任务）——轮询，仅看板模式
  const [sched, setSched] = useState<{
    started: boolean;
    running: Array<{ number: number; name: string; execStatus: string }>;
    lastAction: { type: string; cardNumber?: number; cardName?: string; at: number };
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/task-scheduler/status", { cache: "no-store" });
        if (!res.ok) return;
        const d = (await res.json()) as { status: typeof sched };
        if (!cancelled) setSched(d.status);
      } catch {
        // 静默：调度器接口不可用时不显示状态
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(timer); };
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
      {/* 看板名称：左上角常驻（玻璃胶囊）。loading 期间不渲染。 */}
      {!board.loading && board.board?.name && (
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 12,
            zIndex: 40,
            display: "flex",
            alignItems: "center",
            gap: 6,
            maxWidth: 300,
            height: 34,
            padding: "0 8px 0 12px",
            borderRadius: 999,
            background: "var(--board-card-glass)",
            backdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
            WebkitBackdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
            border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
            boxShadow: "0 2px 12px -6px rgba(0,0,0,0.18)",
            color: "var(--text)",
          }}
          title={board.board.name}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.7 }}>
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
          </svg>
          <span style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {board.board.name}
          </span>
          <button
            type="button"
            onClick={() => void reloadBoard()}
            title={t("boards.reloadCanvas")}
            aria-label={t("boards.reloadCanvas")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              padding: 0,
              flexShrink: 0,
              border: "none",
              background: "transparent",
              color: "var(--text-muted)",
              cursor: reloading ? "default" : "pointer",
              borderRadius: 999,
              transition: "background 0.12s, color 0.12s",
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{ animation: reloading ? "spin 0.8s linear infinite" : undefined }}
            >
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </button>
        </div>
      )}
      {/* 调度器状态：有运行中的调度任务时，看板名下方淡一档小字提示“正在运行 xxx任务” */}
      {!board.loading && sched && sched.running.length > 0 && (
        <div
          title={`调度器正在执行 ${sched.running.length} 个任务`}
          style={{
            position: "absolute",
            top: 52,
            left: 12,
            zIndex: 40,
            display: "flex",
            alignItems: "center",
            gap: 6,
            maxWidth: 260,
            padding: "3px 10px",
            borderRadius: 999,
            background: "color-mix(in srgb, var(--board-card-glass) 85%, transparent)",
            border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)",
            color: "var(--text-muted)",
            fontSize: 10.5,
            lineHeight: 1.4,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          <span
            aria-hidden
            style={{
              flexShrink: 0,
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "#10b981",
              boxShadow: "0 0 6px 1px rgba(16,185,129,0.6)",
              animation: "pulse 1.6s ease-in-out infinite",
            }}
          />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            正在运行 {sched.running.map((r) => `#${r.number} ${r.name}`).join("、")}
          </span>
        </div>
      )}
      {/* 看板搜索框：常驻，画布顶部居中（玻璃胶囊）。loading 期间不渲染 */}
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
      {/* 顶部悬浮按钮组：清理失效 + 磨砂调节 */}
      <div
        style={{
          position: "absolute",
          top: 10,
          right: 10,
          zIndex: 30,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 6,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: 4,
            borderRadius: 10,
            background: "var(--board-card-glass)",
            backdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
            WebkitBackdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
            border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
            boxShadow: "0 2px 12px -6px rgba(0,0,0,0.18)",
          }}
        >
          <button
            type="button"
            onClick={() => board.addNewSessionCard()}
            title={t("boards.newSession")}
            style={{ ...floatingIconBtn, color: "var(--accent)" }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            type="button"
            disabled
            title={t("boards.autoLayoutDesc")}
            aria-label={t("boards.autoLayout")}
            style={{ ...floatingIconBtn, color: "var(--text-dim)", opacity: 0.55, cursor: "not-allowed" }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setScrimOpen((v) => !v)}
            title={t("boards.scrimTitle")}
            aria-expanded={scrimOpen}
            style={{
              ...floatingIconBtn,
              color: scrimOpen ? "var(--accent)" : "var(--text-muted)",
              background: scrimOpen ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3v2" />
              <path d="M12 19v2" />
              <path d="M5 7l1.5 1.5" />
              <path d="M17.5 15.5L19 17" />
              <path d="M3 12h2" />
              <path d="M19 12h2" />
              <path d="M5 17l1.5-1.5" />
              <path d="M17.5 8.5L19 7" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => {
              void confirm({
                message: isTaskBoard ? t("boards.clearTaskConfirm") : t("boards.clearConfirm"),
                confirmText: t("boards.clear"),
              }).then((ok) => {
                if (ok) void board.clearBoard();
              });
            }}
            title={isTaskBoard ? t("boards.clearTaskBoardDesc") : t("boards.clearDesc")}
            style={floatingIconBtn}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        {scrimOpen && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: "8px 10px",
              borderRadius: 10,
              background: "var(--board-card-glass)",
              backdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
              WebkitBackdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
              border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
              boxShadow: "0 2px 12px -6px rgba(0,0,0,0.18)",
              color: "var(--text)",
              fontSize: 12.5,
              whiteSpace: "nowrap",
            }}
          >
            {/* 透明度滑块暂注释：微调即对背景影响过大，固定保持 0。
                如需恢复，取消下面 div 注释即可（字段/逻辑仍在 wallpaper-settings）。
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 14, flexShrink: 0, textAlign: "center", fontSize: 12 }}>◐</span>
              <span style={{ flexShrink: 0 }}>{t("boards.scrimAlpha")}</span>
              <input
                type="range"
                min={0}
                max={100}
                value={wallSettings.scrimAlpha}
                onChange={(e) => updateWallSettings({ scrimAlpha: Number(e.target.value) })}
                style={{ flex: 1, minWidth: 120, accentColor: "var(--accent)", cursor: "pointer" }}
                aria-label={t("boards.scrimAlpha")}
              />
              <span style={{ width: 34, flexShrink: 0, textAlign: "right", fontSize: 11, color: "var(--text-dim)" }}>
                {wallSettings.scrimAlpha}%
              </span>
            </div>
            */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 14, flexShrink: 0, textAlign: "center", fontSize: 12 }}>❄</span>
              <span style={{ flexShrink: 0 }}>{t("boards.scrimBlur")}</span>
              <input
                type="range"
                min={0}
                max={30}
                value={wallSettings.scrimBlur}
                onChange={(e) => updateWallSettings({ scrimBlur: Number(e.target.value) })}
                style={{ flex: 1, minWidth: 120, accentColor: "var(--accent)", cursor: "pointer" }}
                aria-label={t("boards.scrimBlur")}
              />
              <span style={{ width: 30, flexShrink: 0, textAlign: "right", fontSize: 11, color: "var(--text)" }}>
                {wallSettings.scrimBlur}px
              </span>
            </div>
          </div>
        )}
      </div>
      <CanvasStage
        board={board}
        isDark={isDark}
      />
      </ReactFlowProvider>
      </BoardSearchProvider>
      </BoardIdContext.Provider>
      </GlassScopeProvider>
    </div>
  );
}

const floatingIconBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  padding: 0,
  border: "none",
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  borderRadius: 7,
  transition: "background 0.12s, color 0.12s",
};
