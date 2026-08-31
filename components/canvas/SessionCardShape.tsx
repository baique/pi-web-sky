import { BaseBoxShapeUtil, HTMLContainer, T, useEditor, resizeBox } from "tldraw";
import type { TLBaseShape, TLShapePartial } from "tldraw";
import { useState, useRef } from "react";
import { SessionWorkbench } from "./SessionWorkbench";
import { CARD_W, CARD_H } from "@/hooks/useBoardCanvas";
import { dispatchBoardSessionRenamed } from "@/lib/board-events";

/**
 * 会话卡 shape。props 含 w/h 满足 BaseBoxShapeUtil（可拉伸）；
 * 业务字段：sessionId / 标题 / 状态 / 失效标记 / 展开标记。
 * 通过 TLGlobalShapePropsMap 模块声明注册进 tldraw 类型系统。
 */
export interface SessionCardProps {
  sessionId: string;
  title: string;
  projectName: string;
  messageCount: number;
  /** 最后一条 assistant 回复（收合态中间区展示），空则显示项目/消息数 */
  lastReply: string;
  phase: "waiting_model" | "running_tools" | "running_command" | "waiting_input" | "idle" | "just-ended";
  runningMs: number;
  /** 会话结束时刻（ms epoch），仅 phase=just-ended 时有效；用于 30s 后移除 */
  endedAt: number;
  /** 最后一条消息时间（会话文件 mtime，ms epoch），摘要轮询刷新；底部时间展示用 */
  lastActivityAt: number;
  stale: boolean;
  expanded: boolean;
  /** draft 卡（新建会话）绑定目录；转正后置空 */
  cwd?: string;
  /** draft 卡（任务看板）目标任务 id；转正后置空 */
  taskId?: string;
  w: number;
  h: number;
  /** 用户手动设置的展开态尺寸（收起时记录、再次展开恢复）；0 = 未设置用默认 */
  expandedW: number;
  expandedH: number;
  /** 用户手动设置的收合态尺寸（展开时记录、再次收起恢复）；0 = 未设置用默认 */
  collapsedW: number;
  collapsedH: number;
}

export type SessionCardShape = TLBaseShape<"session-card", SessionCardProps>;

declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    "session-card": SessionCardProps;
  }
}

export const sessionCardProps = {
  sessionId: T.string,
  title: T.string,
  projectName: T.string,
  messageCount: T.number,
  lastReply: T.string,
  phase: T.string,
  runningMs: T.number,
  endedAt: T.number,
  lastActivityAt: T.number,
  stale: T.boolean,
  expanded: T.boolean,
  cwd: T.string,
  taskId: T.string,
  w: T.number,
  h: T.number,
  expandedW: T.number,
  expandedH: T.number,
  collapsedW: T.number,
  collapsedH: T.number,
};

export class SessionCardUtil extends BaseBoxShapeUtil<SessionCardShape> {
  static override type = "session-card" as const;
  static override props = sessionCardProps;

  override getDefaultProps(): SessionCardShape["props"] {
    return {
      sessionId: "",
      title: "Untitled session",
      projectName: "",
      messageCount: 0,
      lastReply: "",
      phase: "idle",
      runningMs: 0,
      endedAt: 0,
      lastActivityAt: 0,
      stale: false,
      expanded: false,
      cwd: "",
      taskId: "",
      w: 280,
      h: 120,
      expandedW: 0,
      expandedH: 0,
      collapsedW: 0,
      collapsedH: 0,
    };
  }

  override component(shape: SessionCardShape) {
    return <SessionCardView shape={shape} />;
  }

  override getIndicatorPath(shape: SessionCardShape) {
    const { w, h } = shape.props;
    const path = new Path2D();
    path.roundRect(0, 0, w, h, 14);
    return path;
  }

  override canResize(): boolean {
    return true;
  }

  /** 会话卡内部承载滚动工作台：声明可滚动，tldraw 的 wheel 劫持逻辑不吞卡片内滚轮。 */
  override canScroll(): boolean {
    return true;
  }

  /** 会话卡不支持旋转：对话卡片旋转无意义，且工作台浮层无法跟随旋转。 */
  override hideRotateHandle(): boolean {
    return true;
  }

  /** resize：左上角固定、随宽度/高度扩展（tldraw resizeBox 默认锚点），
   *  并钳制最小尺寸：展开态 400×500，收合态回到卡片默认。 */
  override onResize(
    shape: SessionCardShape,
    info: import("tldraw").TLResizeInfo<SessionCardShape>,
  ): Omit<TLShapePartial<SessionCardShape>, "id" | "type"> | undefined {
    const expanded = shape.props.expanded;
    // 展开态最小宽 600（用户要求），高 500；收合态回到卡片默认下限
    const minW = expanded ? 600 : CARD_W;
    const minH = expanded ? 500 : CARD_H;
    // resizeBox 处理左上角固定锚点（返回 x/y）+ 最小尺寸钳制，
    // 不手写 w/h（手写会丢锚点，拖拽时卡片会跑位）。
    return resizeBox(shape, info, { minWidth: minW, minHeight: minH }) as Omit<TLShapePartial<SessionCardShape>, "id" | "type">;
  }

  /** 双击展开为工作台（持久化 expanded 标记，刷新后恢复）。
   *  展开/收合尺寸切换统一走 nextExpandState：展开/收合两态的手动尺寸都各自保留。 */
  override onDoubleClick(shape: SessionCardShape): TLShapePartial<SessionCardShape> | void {
    return {
      id: shape.id,
      type: "session-card",
      props: nextExpandState(shape),
    };
  }
}

/** 展开工作台默认尺寸（用户未手动调过时）。能容纳消息 + 底栏（spec：800px 以上）。 */
const EXPANDED_DEFAULT_W = 840;
const EXPANDED_DEFAULT_H = 600;

/** 展开/收起尺寸切换：
 *  收起：记录当前展开尺寸（expandedW/H）→ 恢复上次收合尺寸（未设置则 CARD_W×CARD_H）
 *  展开：记录当前收合尺寸（collapsedW/H）→ 恢复上次展开尺寸（未设置则 840×600）
 *  用户手动 resize 过的尺寸在两态间来回切换都不丢失，刷新后从 board_nodes.props 还原。 */
function nextExpandState(shape: SessionCardShape) {
  if (shape.props.expanded) {
    // 展开 → 收合
    return {
      expanded: false,
      expandedW: shape.props.w,
      expandedH: shape.props.h,
      w: shape.props.collapsedW || CARD_W,
      h: shape.props.collapsedH || CARD_H,
    };
  }
  // 收合 → 展开
  return {
    expanded: true,
    collapsedW: shape.props.w,
    collapsedH: shape.props.h,
    w: shape.props.expandedW || EXPANDED_DEFAULT_W,
    h: shape.props.expandedH || EXPANDED_DEFAULT_H,
  };
}

const phaseMeta: Record<string, { dot: string; label: string }> = {
  waiting_model: { dot: "var(--accent)", label: "thinking" },
  running_tools: { dot: "#f59e0b", label: "tools" },
  running_command: { dot: "#f59e0b", label: "command" },
  waiting_input: { dot: "var(--text)", label: "waiting" },
  idle: { dot: "var(--text-dim)", label: "idle" },
  "just-ended": { dot: "#10b981", label: "done" },
};

/** 收合卡渲染（340×160 默认）。状态行+标题+展开按钮 / 最后回复区 / 底部时间。
 *  选中描边由 tldraw 指示器负责。 */
function SessionCardView({ shape }: { shape: SessionCardShape }) {
  const { w, h, title, projectName, messageCount, phase, runningMs, endedAt, lastActivityAt, stale, sessionId, expanded, lastReply, cwd, taskId } = shape.props;
  const editor = useEditor();

  // draft 卡（新建会话）：sessionId 为空，尚未绑定真实会话
  const isDraft = !sessionId;

  // 改名：内联输入 → PATCH /api/sessions/[id] → 事件桥刷左侧树 + 摘要轮询刷新标题
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const startRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameValue(title || "");
    setRenaming(true);
    // 输入框挂载后聚焦并全选
    requestAnimationFrame(() => {
      const input = renameInputRef.current;
      if (input) {
        input.focus();
        input.select();
      }
    });
  };
  const commitRename = async () => {
    if (!sessionId) return;
    const name = renameValue.trim();
    setRenaming(false);
    if (!name || name === title) return;
    // 乐观更新：卡片标题立即写回（不等 10s 摘要轮询），PATCH 失败回滚
    const prevTitle = title;
    editor?.updateShapes([{ id: shape.id, type: "session-card", props: { title: name } }]);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        dispatchBoardSessionRenamed(sessionId, name);
      } else {
        // 失败回滚标题
        editor?.updateShapes([{ id: shape.id, type: "session-card", props: { title: prevTitle } }]);
      }
    } catch {
      editor?.updateShapes([{ id: shape.id, type: "session-card", props: { title: prevTitle } }]);
    }
  };
  const cancelRename = () => setRenaming(false);

  // 点击卡片置顶：两卡重叠时点哪个哪个到最上层。
  // 事件来源：收合态卡片整体 / 展开态标题栏（pointerEvents none 透传到 HTMLContainer all）。
  // 展开态工作台内部 pointerEvents all 且 stopPropagation，不会触发这里（会话内交互不置顶）。
  const bringToFront = () => {
    editor?.bringToFront([shape.id]);
  };

  // 独立展开/收起：切换 expanded + 尺寸（nextExpandState 保留两态手动尺寸）。
  // 收合态点展开按钮：pointerEvents all 会拦截 tldraw 拖拽，按钮独立接收点击。
  // draft 卡不可收合：收起按钮改为删除（尚未绑定会话，收合无意义）。
  const toggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDraft) {
      editor?.deleteShapes([shape.id]);
      return;
    }
    editor?.updateShapes([{
      id: shape.id,
      type: "session-card",
      props: nextExpandState(shape),
    }]);
  };

  // 展开态：上半部标题栏（pointerEvents none → tldraw 原生拖拽/选中），
  // 下半部嵌工作台（pointerEvents all → 消息/输入可交互）。
  // 工作台在卡片内部，resize 卡片时宽度天然跟随，不再有 overlay 遮挡问题。
  if (expanded) {
    return (
      <HTMLContainer
        data-testid={`session-card-${sessionId}`}
        data-node-id={shape.id.replace("shape:", "")}
        onPointerDown={bringToFront}
        style={{
          width: w,
          height: h,
          overflow: "visible",
          borderRadius: 18,
          border: `1px solid ${stale ? "color-mix(in srgb, var(--border) 80%, transparent)" : "color-mix(in srgb, var(--border) 60%, transparent)"}`,
          // 卡片磨砂玻璃：略低于消息气泡（alpha 0.55 vs 气泡 0.44，blur 12px vs 气泡 18px）
          background: "var(--board-card-glass)",
          backdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
          WebkitBackdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
          boxShadow: "0 2px 12px -6px rgba(0,0,0,0.18)",
          opacity: stale ? 0.55 : 1,
          pointerEvents: "all",
          display: "flex",
          flexDirection: "column",
          color: "var(--text)",
          userSelect: "none",
          // 胶囊化：内部统一留白，标题栏/底栏都被向内挤压，四边圆角衔接
          padding: 8,
        }}
      >
        {/* 标题栏 = 拖拽区：pointerEvents none 让 tldraw 接管（拖动/选中/缩放），
            仅显示标题 + 状态圆点 + 展开按钮（按钮 pointerEvents all 独立点击）。
            无玻璃背景（还原原状态），仅保留底部 border 分隔工作台。
            导航条（SessionNavBar）经 portal 渲染到 data-session-titlebar 内、展开按钮前。 */}
        <div
          data-session-titlebar
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 10px",
            height: "calc(36px + env(safe-area-inset-top))",
            borderTopLeftRadius: 12,
            borderTopRightRadius: 12,
            pointerEvents: "none",
            cursor: "grab",
            position: "relative",
          }}
        >
          <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: phaseMeta[phase]?.dot ?? "var(--text-dim)", flexShrink: 0 }} />
          {renaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitRename();
                if (e.key === "Escape") cancelRename();
              }}
              onBlur={() => void commitRename()}
              onPointerDown={(e) => e.stopPropagation()}
              style={{
                flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600,
                padding: "2px 6px", border: "1px solid var(--accent)", borderRadius: 5,
                outline: "none", background: "var(--side-input)", color: "var(--text)",
              }}
            />
          ) : (
            <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
              {isDraft ? "New session" : (title || "Untitled")}
            </span>
          )}
          {!isDraft && !renaming && (
            <button
              type="button"
              onClick={startRename}
              onPointerDown={(e) => e.stopPropagation()}
              title="Rename"
              aria-label="Rename"
              style={{
                flexShrink: 0,
                pointerEvents: "all",
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, border: "none", borderRadius: 5,
                background: "transparent", color: "var(--text-dim)", cursor: "pointer",
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
              </svg>
            </button>
          )}
          <div style={{ flex: 1 }} />
          {/* 导航条 portal 挂载点：SessionWorkbench 将 SessionNavBar 渲染到这里（展开按钮之前） */}
          <div data-session-navbar-slot style={{ display: "flex", alignItems: "center", pointerEvents: "all" }} />
          <button
            type="button"
            onClick={toggleExpand}
            onPointerDown={(e) => e.stopPropagation()}
            title={isDraft ? "Discard" : "Collapse"}
            style={{
              flexShrink: 0,
              pointerEvents: "all",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              padding: 0,
              border: "none",
              borderRadius: 5,
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
            }}
          >
            {isDraft ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 15l-6-6-6 6" />
              </svg>
            )}
          </button>
        </div>
        {/* 工作台：嵌卡片内，随卡片 resize 自然跟随；四周留 padding 保证拖拽/调整手柄可触
           垂直对齐：卡片 padding 8 上下一致，底栏内容区底部从 6 减到 0，底距卡底与顶距卡顶同 8 */}
        <div style={{ flex: 1, minHeight: 0, padding: "0 4px 0", pointerEvents: "all" }}>
          <SessionWorkbench sessionId={sessionId} cwd={cwd} taskId={taskId} />
        </div>
      </HTMLContainer>
    );
  }

  const meta = phaseMeta[phase] ?? phaseMeta.idle;

  return (
    <HTMLContainer
      data-testid={`session-card-${sessionId}`}
      onPointerDown={bringToFront}
      style={{
        width: w,
        height: h,
        overflow: "hidden",
        borderRadius: 14,
        border: `1px solid ${stale ? "color-mix(in srgb, var(--border) 80%, transparent)" : "color-mix(in srgb, var(--border) 60%, transparent)"}`,
        // 卡片磨砂玻璃：略低于消息气泡（alpha 0.55 vs 气泡 0.44，blur 12px vs 气泡 18px）
        background: "var(--board-card-glass)",
        backdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
        WebkitBackdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
        boxShadow: "0 2px 12px -6px rgba(0,0,0,0.18)",
        opacity: stale ? 0.55 : 1,
        pointerEvents: "all",
        display: "flex",
        flexDirection: "column",
        padding: "8px 10px 6px",
        color: "var(--text)",
        userSelect: "none",
        cursor: "grab",
      }}
    >
      {/* 状态行：状态圆点 + 状态文字 + 标题（紧跟状态）+ 展开按钮 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 20, flexShrink: 0 }}>
        <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: meta.dot, flexShrink: 0 }} />
        <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0, whiteSpace: "nowrap" }}>
          {meta.label}
        </span>
        {renaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitRename();
              if (e.key === "Escape") cancelRename();
            }}
            onBlur={() => void commitRename()}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600,
              padding: "2px 6px", border: "1px solid var(--accent)", borderRadius: 5,
              outline: "none", background: "var(--side-input)", color: "var(--text)",
            }}
          />
        ) : (
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              minWidth: 0,
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--text)",
            }}
          >
            {title || "Untitled"}
          </span>
        )}
        {!isDraft && !renaming && (
          <button
            type="button"
            onClick={startRename}
            onPointerDown={(e) => e.stopPropagation()}
            title="Rename"
            aria-label="Rename"
            style={{
              flexShrink: 0,
              pointerEvents: "all",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 20,
              height: 20,
              padding: 0,
              border: "none",
              borderRadius: 5,
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              opacity: 0.65,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
            </svg>
          </button>
        )}
        {stale && (
          <span style={{ flexShrink: 0, fontSize: 9.5, color: "var(--text-dim)", border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)", borderRadius: 4, padding: "0 4px" }}>
            stale
          </span>
        )}
        <button
          type="button"
          onClick={toggleExpand}
          onPointerDown={(e) => e.stopPropagation()}
          title="Expand"
          style={{
            flexShrink: 0,
            pointerEvents: "all",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
            height: 20,
            padding: 0,
            border: "none",
            borderRadius: 5,
            background: "transparent",
            color: "var(--text-dim)",
            cursor: "pointer",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>
      {/* 中间区：最后回复 —— 流体高度 + 左上对齐（不截断行数），拉高卡片可看完整内容 */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "flex-start",
          gap: 2,
          overflow: "hidden",
          padding: "2px 0",
        }}
      >
        {lastReply ? (
          <div
            style={{
              fontSize: 11.5,
              lineHeight: 1.45,
              color: "var(--text-muted)",
              wordBreak: "break-word",
              whiteSpace: "pre-wrap",
              maxWidth: "100%",
            }}
          >
            {lastReply}
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10.5, color: "var(--text-dim)" }}>
            {projectName && (
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1 }}>
                {projectName}
              </span>
            )}
            {messageCount > 0 && (
              <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{messageCount} msgs</span>
            )}
          </div>
        )}
      </div>
      {/* 底部：左下角最后活动时间，右下角运行时长（仅运行中） */}
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-dim)", borderTop: "1px solid color-mix(in srgb, var(--border) 50%, transparent)", paddingTop: 3 }}>
        <span aria-hidden style={{ flexShrink: 0 }}>🕒</span>
        <span>{formatTime(lastActivityAt)}</span>
        <div style={{ flex: 1 }} />
        {runningMs > 0 && phase !== "idle" && (
          <span style={{ fontFamily: "var(--font-mono)", whiteSpace: "nowrap", flexShrink: 0 }}>{formatDuration(runningMs)}</span>
        )}
      </div>
    </HTMLContainer>
  );
}

function formatDuration(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60}s`;
  const h = Math.floor(min / 60);
  return `${h}h${min % 60}m`;
}

/** 左下角最后活动时间（今天 时:分，跨天 月/日 时:分） */
function formatTime(lastActivityAt: number): string {
  if (lastActivityAt <= 0) return "";
  const d = new Date(lastActivityAt);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
