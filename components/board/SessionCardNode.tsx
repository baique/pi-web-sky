"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { NodeResizer, Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import { computeResizeSnap } from "@/lib/board-align";
import { SessionWorkbench } from "@/components/canvas/SessionWorkbench";
import { CARD_W, CARD_H } from "@/hooks/useBoardCanvas";
import type { SessionCardData } from "@/hooks/useBoardCanvas";
import { useCardGlass } from "@/hooks/useCardGlass";
import { useBoardCanvasOps } from "./BoardCanvasContext";
import { useSessionRunning, useSessionSummary } from "@/hooks/useBoardCanvas";
import { memoBoardNode } from "./memoNode";
import { dispatchBoardSessionRenamed, dispatchBoardCwdSwitch } from "@/lib/board-events";
import { EmojiPickerField } from "@/components/canvas/EmojiPickerField";
import { HIGHLIGHT_SHADOW, useBoardSearch } from "@/components/canvas/BoardSearchContext";

/**
 * 会话卡（RF 节点版，替代 tldraw session-card shape）。
 * - 收合 340×160 ↔ 展开 840×600（data.expanded 切换 + 尺寸切换，两态手动尺寸保留）
 * - 展开态嵌入 SessionWorkbench（ChatWindow 工作台）
 * - resize：NodeResizer（min 尺寸随态）
 * - 改名：内联输入 → PATCH /api/sessions/[id]
 * - 玻璃：useCardGlass 局部贴图
 */

/** 展开工作台默认尺寸 */
const EXPANDED_DEFAULT_W = 840;
const EXPANDED_DEFAULT_H = 600;

/** 工作台按需挂载：视口外扩缓冲（px）——卡片刚离开视口一点不卸载 */
const WORKBENCH_NEAR_MARGIN = 400;
/** 离开缓冲后延时卸载（防拖拽边缘横跳反复销毁重建） */
const WORKBENCH_UNMOUNT_DELAY_MS = 5000;

const phaseMeta: Record<string, { dot: string; label: string }> = {
  waiting_model: { dot: "var(--accent)", label: "thinking" },
  running_tools: { dot: "#f59e0b", label: "tools" },
  running_command: { dot: "#f59e0b", label: "command" },
  waiting_input: { dot: "var(--text)", label: "waiting" },
  idle: { dot: "var(--text-dim)", label: "idle" },
  "just-ended": { dot: "#10b981", label: "done" },
};

function SessionCardNodeImpl({ id, data, selected, width, height }: NodeProps & { data: SessionCardData }) {
  const { getNodes } = useReactFlow();
  const { updateNode, deleteNode, setSnapLines } = useBoardCanvasOps();
  const { highlightId } = useBoardSearch();
  const isHighlighted = highlightId === id;
  const w = width ?? data.w ?? CARD_W;
  const h = height ?? data.h ?? CARD_H;
  const expanded = Boolean(data.expanded);
  // 最新 data 镜像：回调（promote/resize）读 ref，不依赖渲染期 data 引用（引用随 yjs 回灌变化 → 回调每帧重建 → 工作台 memo 失效）
  const dataRef = useRef(data);
  dataRef.current = data;
  const { title, projectName, messageCount, lastActivityAt, stale, sessionId, lastReply, cwd, taskId } = data;
  // 运行态镜像优先（2.5s 轮询本地快照，不写 yjs）：命中则覆盖 data 旧值。
  // runningMs 高频变化 → 只镜像变化，不进 CRDT/undo 栈。
  const runningState = useSessionRunning(sessionId ?? null);
  const phase = runningState?.phase ?? data.phase;
  const runningMs = runningState?.runningMs ?? data.runningMs;
  // worktree 徽标数据源：会话信息摘要（/api/sessions 轮询，不写 yjs）。
  // 派生展示字段不入 CRDT（铁律：派生元素后端 reconcile 权威 / UI 态不进 yjs）。
  const summary = useSessionSummary(sessionId ?? null);
  const worktreeBranch = summary?.worktreeBranch ?? data.worktreeBranch;
  const isWorktree = summary?.isWorktree ?? data.isWorktree;
  const isNewSession = Boolean(cwd);
  const { setContainer } = useCardGlass("var(--board-card-glass)");

  // ---- 展开态工作台按需挂载（离屏缓冲）----
  // 卡片外壳（标题栏/Handle/边框）常驻 DOM，重量级 SessionWorkbench 仅在
  // 「视口 + WORKBENCH_NEAR_MARGIN」内挂载；离开缓冲后延时 WORKBENCH_UNMOUNT_DELAY_MS
  // 再卸载——拖出视口不会瞬间销毁重建（事件阻塞假卡顿），边缘横跳也不反复重建。
  // 新会话卡（等待输入）恒挂载：卸载会丢输入。
  const cardRootRef = useRef<HTMLDivElement | null>(null);
  // 初始 true：视口内展开卡首帧即挂载（IO 回调异步，避免骨架屏闪烁）；
  // 离屏卡由 IO 首回调 + 延时进入卸载流程。新会话卡由 isNewSession 分支恒挂载。
  const [workbenchMounted, setWorkbenchMounted] = useState(true);
  const workbenchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const el = cardRootRef.current;
    if (!el) return;
    const root = el.closest(".react-flow") as HTMLElement | null;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries[0]?.isIntersecting ?? true;
        if (visible) {
          if (workbenchTimerRef.current) {
            clearTimeout(workbenchTimerRef.current);
            workbenchTimerRef.current = null;
          }
          setWorkbenchMounted(true);
        } else if (!workbenchTimerRef.current) {
          workbenchTimerRef.current = setTimeout(() => {
            workbenchTimerRef.current = null;
            setWorkbenchMounted(false);
          }, WORKBENCH_UNMOUNT_DELAY_MS);
        }
      },
      { root, rootMargin: `${WORKBENCH_NEAR_MARGIN}px` },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (workbenchTimerRef.current) {
        clearTimeout(workbenchTimerRef.current);
        workbenchTimerRef.current = null;
      }
    };
  }, []);
  // 组合 ref：玻璃层 setContainer 与 IO 观察目标 cardRootRef 都挂卡根
  const setCardRoot = useCallback(
    (node: HTMLDivElement | null) => {
      cardRootRef.current = node;
      setContainer(node);
    },
    [setContainer],
  );

  // 收合态中间区滚动容器 ref（内部滚动 nowheel 由 RF 隔离）
  const replyScrollRef = useRef<HTMLDivElement | null>(null);

  // 改名
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  // 取消中标记：Esc 触发的取消不应被 input 卸载随后的 blur 重新提交（对齐 NoteEditor）。
  const cancelRenameRef = useRef(false);
  const startRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameValue(title || "");
    setRenaming(true);
    cancelRenameRef.current = false;
    requestAnimationFrame(() => { renameInputRef.current?.focus(); renameInputRef.current?.select(); });
  };
  const commitRename = async () => {
    if (cancelRenameRef.current) return; // 取消/已提交后随后的 blur 不再提交
    cancelRenameRef.current = true;
    if (!sessionId) return;
    const name = renameValue.trim();
    setRenaming(false);
    if (!name || name === title) return;
    const prevTitle = title;
    updateNode(id, { data: { title: name } });
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        dispatchBoardSessionRenamed(sessionId, name);
      } else {
        updateNode(id, { data: { title: prevTitle } });
      }
    } catch {
      updateNode(id, { data: { title: prevTitle } });
    }
  };
  const cancelRename = () => {
    cancelRenameRef.current = true; // 取消中：随后的 blur 不再提交
    setRenaming(false);
  };

  // 独立展开/收起：切换 expanded + 尺寸（两态手动尺寸保留）
  // 新建占位卡（cwd 非空）：双击禁止收起（也不删卡）——占位卡保持展开等待输入；
  // 首条消息发完转正（cwd 清空）后 isNewSession 变 false，展开/收合恢复生效。
  const toggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isNewSession) return;
    const next = nextExpandState(data, w, h);
    const expanding = next.data.expanded && !data.expanded;
    updateNode(id, { data: next.data });
    // 尺寸三处对齐：顶层 width/height（NodeResizer 拖过会残留，RF 优先读它）
    // + style（RF 备选）。只改 style 会被顶层残留值屏蔽。
    updateNode(id, { width: next.w, height: next.h, style: { width: next.w, height: next.h } });
    // 展开（收→展）= 激活该会话 → 触发全局标准切换（左侧文件区跟随该会话 worktree）。
    if (expanding) {
      const actCwd = summary?.cwd || summary?.projectRoot || cwd || "";
      if (actCwd) dispatchBoardCwdSwitch(actCwd);
    }
  };

  // 显式丢弃新建占位卡（仅标题栏垃圾桶按钮；双击已被 toggleExpand 屏蔽，不再触达此处）。
  // 会话未创建（cwd 非空）：删 Y.Doc 节点即可，无确认弹窗。
  const discardNewSession = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isNewSession) return;
    deleteNode(id);
  };

  // resize：写回 style + data.w/h + 对齐参考线吸附
  // resizingRef 守卫：停止后 yjs 尺寸回灌可能再触发 onResize，不得再画线（抬起线不消失）
  const resizingRef = useRef(false);
  const onResizeStart = useCallback(() => {
    resizingRef.current = true;
    setSnapLines([]);
  }, [setSnapLines]);
  const onResizeEnd = useCallback(
    (_: unknown, params: { width: number; height: number; x?: number; y?: number }) => {
      if (!resizingRef.current) return; // 幽灵 end（RF 重初始化旧值）忽略
      resizingRef.current = false;
      setSnapLines([]);
      requestAnimationFrame(() => setSnapLines([]));
      // 松手一次落库最终尺寸（官方 onResizeEnd 契约）：RF 的 dimensions change 不写
      // style（尺寸真相源），不写会回退。写全 style/顶层/data.w/h，左/上边缘的位置一并补落。
      const w = Math.round(params.width);
      const h = Math.round(params.height);
      updateNode(id, {
        width: w,
        height: h,
        style: { width: w, height: h },
        data: { w, h },
        ...(params.x !== undefined && params.y !== undefined ? { position: { x: params.x, y: params.y } } : {}),
      });
    },
    [id, updateNode, setSnapLines],
  );
  const onResize = useCallback((_: unknown, params: { width: number; height: number }) => {
    if (!resizingRef.current) return;
    const nodes = getNodes();
    const self = nodes.find((n) => n.id === id);
    const pos = self?.position ?? { x: 0, y: 0 };
    // 参考线跟手；尺寸不写 yjs（resize 中每帧写会 CRDT 历史爆炸），
    // 松手由 onNodesChange dimensions(resizing:false) 一次性落库。
    const snap = computeResizeSnap(id, pos, params.width, params.height, nodes);
    setSnapLines(snap.lines);
  }, [id, setSnapLines, getNodes]);

  // 新会话卡转正：清 cwd 字段（写 Y.Doc → CRDT 广播）。
  // 只清 cwd（未就绪标记）：taskId 是卡的任务归属信息，保留——
  // 孤儿删判据已改为只看 session_meta，不再依赖/清空卡上 taskId。
  const handlePromote = useCallback(() => {
    updateNode(id, { data: { cwd: "" } });
  }, [id, updateNode]);

  const meta = phaseMeta[phase] ?? phaseMeta.idle;

  // 统一底部条（收起/展开共用）：🕒 时间 · worktree 分支 · 运行时长。
  // 分支信息非主 worktree 时显示（会话信息摘要，不写 yjs）。
  const sessionFooter = (
    <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-muted)", borderTop: "1px solid color-mix(in srgb, var(--border) 50%, transparent)", paddingTop: 3, marginTop: 2 }}>
      <span aria-hidden style={{ flexShrink: 0 }}>🕒</span>
      <span>{formatTime(lastActivityAt)}</span>
      {!isNewSession && isWorktree && worktreeBranch && (
        <span title={`Worktree: ${worktreeBranch}`} style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--text-muted)", minWidth: 0, flexShrink: 0 }}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10, maxWidth: 90 }}>{worktreeBranch}</span>
        </span>
      )}
      <div style={{ flex: 1 }} />
      {runningMs > 0 && phase !== "idle" && (
        <span style={{ fontFamily: "var(--font-mono)", whiteSpace: "nowrap", flexShrink: 0 }}>{formatDuration(runningMs)}</span>
      )}
    </div>
  );

  // 收合态滚轮内部滚动（RF 的 nowheel 类已处理，这里不需要额外监听）

  return (
    <>
      {/* resize 手柄 + 连线 Handle 挂在卡根外（RF wrapper 直接子级）：
          卡根 overflow:hidden（或展开态 visible）会裁掉/错位外扩的 resize 角柄，
          放外面后手柄可正常外扩/命中。
          直线隐藏（四边直线无法圆角）：选中态边线由卡根圆角 accent 边框呈现。 */}
      <NodeResizer
        isVisible={selected}
        minWidth={expanded ? 600 : CARD_W}
        minHeight={expanded ? 500 : CARD_H}
        onResizeStart={onResizeStart}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
        keepAspectRatio={false}
      />

      {/* 连线 Handle：exec/依赖线端点（左侧 target / 右侧 source） */}
      <Handle type="target" position={Position.Left} className="board-handle" style={{ background: "var(--text-dim)", width: 8, height: 8, border: "1px solid var(--bg-panel)", opacity: 0.85 }} />
      <Handle type="source" position={Position.Right} className="board-handle" style={{ background: "var(--text-dim)", width: 8, height: 8, border: "1px solid var(--bg-panel)", opacity: 0.85 }} />

    <div
      ref={setCardRoot}
      data-board-node
      data-testid={`session-card-${sessionId}`}
      onDoubleClick={toggleExpand}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        borderRadius: expanded ? 18 : 14,
        border: isHighlighted
          ? "2px solid var(--accent)"
          : `1px solid ${stale ? "color-mix(in srgb, var(--border) 80%, transparent)" : "color-mix(in srgb, var(--border) 60%, transparent)"}`,
        background: "transparent",
        // 选中态：外圈描边用 box-shadow（带 5px 间距、不占布局→不压缩内容区）。边框保持固定 1px。
        boxShadow: selected
          ? "0 0 0 5px transparent, 0 0 16px 5px color-mix(in srgb, var(--accent) 28%, transparent), 0 2px 12px -6px rgba(0,0,0,0.18)"
          : isHighlighted ? HIGHLIGHT_SHADOW : "0 2px 12px -6px rgba(0,0,0,0.18)",
        animation: isHighlighted ? "board-search-glow 1.8s ease-out forwards" : undefined,
        opacity: stale ? 0.55 : 1,
        display: "flex",
        flexDirection: "column",
        color: "var(--text)",
        userSelect: "none",
        padding: expanded ? 8 : "8px 10px 6px",
        // 卡根整卡可拖（左右下边缘留抓手区），内部内容区单独 default
        cursor: "grab",
        overflow: expanded ? "visible" : "hidden",
      }}
    >

      {/* 标题栏 = 恒可拖拽层（展开/收起都保留可拖）：不拦 pointer → RF 拖动节点。
          内部交互（改名输入/按钮/导航槽）各自 nodrag 隔离。 */}
      <div
        data-session-titlebar
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 10px",
          height: expanded ? "calc(36px + env(safe-area-inset-top))" : undefined,
          minHeight: expanded ? undefined : 20,
          borderBottom: expanded ? "1px solid color-mix(in srgb, var(--border) 50%, transparent)" : "none",
          cursor: "grab",
          position: "relative",
          ...(expanded ? {} : { marginBottom: 2 }),
        }}
      >
        {/* emoji：点击切换面板开/关（EmojiPickerField 原生 toggle）；不传 status → 不随运行状态自动切换 */}
        <EmojiPickerField kind="session" value={data.emoji} onChange={(emoji) => updateNode(id, { data: { emoji } })} />
        {renaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { cancelRenameRef.current = false; void commitRename(); }
              if (e.key === "Escape") cancelRename();
            }}
            onBlur={() => void commitRename()}
            className="nodrag"
            style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, padding: "2px 6px", border: "1px solid transparent", borderRadius: 5, outline: "none", background: "transparent", color: "var(--text)", boxSizing: "border-box" }}
          />
        ) : (
          /* 圆点并入标题元素（同 flex 容器，间距由 gap 单独控制） */
          <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 4, minWidth: 0, overflow: "hidden", fontSize: 12.5, fontWeight: 600, color: "var(--text)", padding: "2px 6px", border: "1px solid transparent", borderRadius: 5, boxSizing: "border-box" }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: meta.dot, flexShrink: 0 }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{isNewSession ? "New session" : (title || "Untitled")}</span>
          </span>
        )}
        {stale && (
          <span style={{ flexShrink: 0, fontSize: 9.5, color: "var(--text-dim)", border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)", borderRadius: 4, padding: "0 4px" }}>stale</span>
        )}
        {/* 右侧操作区最左：会话标题编辑（历史按钮左侧） */}
        {!isNewSession && !renaming && (
          <button type="button" onClick={startRename} title="Rename" aria-label="Rename" className="nodrag" style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, padding: 0, border: "none", borderRadius: 5, background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
          </button>
        )}
        {/* 导航条 portal 挂载点 */}
        <div data-session-navbar-slot className="nodrag" style={{ display: "flex", alignItems: "center" }} />
        <button
          type="button"
          onClick={isNewSession ? discardNewSession : toggleExpand}
          className="nodrag"
          title={isNewSession ? "Discard" : expanded ? "Collapse" : "Expand"}
          style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, border: "none", borderRadius: 5, background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}
        >
          {isNewSession ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
          ) : expanded ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6" /></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          )}
        </button>
      </div>

      {expanded ? (
        // 展开工作台（消息/工具/代码块）必须显式恢复文本选中：卡根 userSelect:none 会抑制整卡选中
        <div className="nodrag" style={{ flex: 1, minHeight: 0, padding: "0 12px 0", pointerEvents: "all", overflow: "visible", cursor: "default", userSelect: "text" }}>
          {workbenchMounted || isNewSession ? (
            <SessionWorkbench
              sessionId={sessionId}
              cwd={cwd}
              taskId={taskId}
              onPromote={handlePromote}
              onCwdChange={(path) => {
                updateNode(id, { data: { ...dataRef.current, cwd: path } });
                // 切分支 → 触发全局标准切换（左侧跟随 + 后续衍生），复用 AppShell.handleCwdChange
                dispatchBoardCwdSwitch(path);
              }}
            />
          ) : (
            <WorkbenchSkeleton />
          )}
        </div>
      ) : (
        <>
          {/* 中间区：最后回复 */}
          <div
            ref={replyScrollRef}
            className="nowheel nodrag"
            style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "flex-start", gap: 2, overflowY: "auto", overflowX: "hidden", padding: "2px 12px 0", scrollbarWidth: "thin", scrollbarColor: "color-mix(in srgb, var(--border) 70%, transparent) transparent", userSelect: "text", cursor: "default" }}
          >
            {lastReply ? (
              <div style={{ fontSize: 11.5, lineHeight: 1.45, color: "var(--text-muted)", wordBreak: "break-word", overflowWrap: "anywhere", whiteSpace: "pre-wrap", maxWidth: "100%", userSelect: "text" }}>
                {lastReply}
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10.5, color: "var(--text-muted)" }}>
                {projectName && <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1 }}>{projectName}</span>}
                {messageCount > 0 && <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{messageCount} msgs</span>}
              </div>
            )}
          </div>
        {/* 底部条：时间 · worktree 分支 · 运行时长（收起态） */}
        {sessionFooter}
        </>
      )}
    </div>
    </>
  );
}

/** 离屏展开卡的轻量占位：与工作台同高同宽，仅数条 pulse 条（无 ChatWindow/SSE 开销）。
 *  工作台回屏由 IO 缓冲提前挂载，此时骨架屏几乎不可见。 */
function WorkbenchSkeleton() {
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 8, padding: "4px 8px", opacity: 0.55 }}>
      <div className="board-skeleton-line" style={{ width: "38%" }} />
      <div className="board-skeleton-line" style={{ width: "72%" }} />
      <div className="board-skeleton-line" style={{ width: "55%" }} />
      <div className="board-skeleton-line" style={{ width: "88%" }} />
      <div style={{ flex: 1 }} />
      <div className="board-skeleton-line" style={{ width: "100%", height: 28, borderRadius: 8 }} />
    </div>
  );
}

/** 展开/收起尺寸切换（两态手动尺寸保留） */
function nextExpandState(data: SessionCardData, w: number, h: number) {
  if (data.expanded) {
    // 展开 → 收合
    return {
      data: { expanded: false, expandedW: w, expandedH: h, w: data.collapsedW || CARD_W, h: data.collapsedH || CARD_H },
      w: data.collapsedW || CARD_W,
      h: data.collapsedH || CARD_H,
    };
  }
  // 收合 → 展开
  return {
    data: { expanded: true, collapsedW: w, collapsedH: h, w: data.expandedW || EXPANDED_DEFAULT_W, h: data.expandedH || EXPANDED_DEFAULT_H },
    w: data.expandedW || EXPANDED_DEFAULT_W,
    h: data.expandedH || EXPANDED_DEFAULT_H,
  };
}

function formatDuration(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60}s`;
  const h = Math.floor(min / 60);
  return `${h}h${min % 60}m`;
}

function formatTime(lastActivityAt: number): string {
  if (lastActivityAt <= 0) return "";
  const d = new Date(lastActivityAt);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/** memo 化导出：忽略拖拽/位置类 props 每帧变化，避免拖拽时整卡重渲染 */
export const SessionCardNode = memoBoardNode(SessionCardNodeImpl);
