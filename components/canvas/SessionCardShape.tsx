import { BaseBoxShapeUtil, HTMLContainer, T, useEditor, resizeBox } from "tldraw";
import type { TLBaseShape, TLShapePartial } from "tldraw";
import { SessionWorkbench } from "./SessionWorkbench";
import { CARD_W, CARD_H } from "@/hooks/useBoardCanvas";

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
  stale: boolean;
  expanded: boolean;
  w: number;
  h: number;
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
  stale: T.boolean,
  expanded: T.boolean,
  w: T.number,
  h: T.number,
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
      stale: false,
      expanded: false,
      w: 280,
      h: 120,
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
   *  展开 → expanded=true，宽度保留用户已 resize 的当前宽（至少 CARD_W），高度 600
   *  收合 → expanded=false，回到收合卡默认 CARD_W×CARD_H
   *  宽度不强制 840：用户调过的宽度在展开/收合间保留，避免宽度跳变。 */
  override onDoubleClick(shape: SessionCardShape): TLShapePartial<SessionCardShape> | void {
    const COLLAPSED_W = CARD_W;
    const COLLAPSED_H = CARD_H;
    const EXPANDED_H = 600;
    // 展开默认宽：能容纳消息 + 底栏（spec：800px 以上）。用户已 resize 过（宽 ≠ 收合宽）则保留用户宽度。
    const EXPANDED_DEFAULT_W = 840;
    const willCollapse = shape.props.expanded;
    return {
      id: shape.id,
      type: "session-card",
      props: {
        expanded: !shape.props.expanded,
        w: willCollapse ? COLLAPSED_W : (shape.props.w === COLLAPSED_W ? EXPANDED_DEFAULT_W : Math.max(COLLAPSED_W, shape.props.w)),
        h: willCollapse ? COLLAPSED_H : EXPANDED_H,
      },
    };
  }
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
  const { w, h, title, projectName, messageCount, phase, runningMs, endedAt, stale, sessionId, expanded, lastReply } = shape.props;
  const editor = useEditor();

  // 点击卡片置顶：两卡重叠时点哪个哪个到最上层。
  // 事件来源：收合态卡片整体 / 展开态标题栏（pointerEvents none 透传到 HTMLContainer all）。
  // 展开态工作台内部 pointerEvents all 且 stopPropagation，不会触发这里（会话内交互不置顶）。
  const bringToFront = () => {
    editor?.bringToFront([shape.id]);
  };

  // 独立展开/收起：切换 expanded + 尺寸。收合 → 默认展开宽 840/高 600；展开 → 收合回 340×160。
  // 收合态点展开按钮：pointerEvents all 会拦截 tldraw 拖拽，按钮独立接收点击。
  const toggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    editor?.updateShapes([{
      id: shape.id,
      type: "session-card",
      props: {
        expanded: !expanded,
        w: expanded ? CARD_W : 840,
        h: expanded ? CARD_H : 600,
      },
    }]);
  };

  // 展开态：上半部标题栏（pointerEvents none → tldraw 原生拖拽/选中），
  // 下半部嵌工作台（pointerEvents all → 消息/输入可交互）。
  // 工作台在卡片内部，resize 卡片时宽度天然跟随，不再有 overlay 遮挡问题。
  if (expanded) {
    return (
      <HTMLContainer
        data-testid={`session-card-${sessionId}`}
        onPointerDown={bringToFront}
        style={{
          width: w,
          height: h,
          overflow: "hidden",
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
          <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
            {title || "Untitled"}
          </span>
          <div style={{ flex: 1 }} />
          {/* 导航条 portal 挂载点：SessionWorkbench 将 SessionNavBar 渲染到这里（展开按钮之前） */}
          <div data-session-navbar-slot style={{ display: "flex", alignItems: "center", pointerEvents: "all" }} />
          <button
            type="button"
            onClick={toggleExpand}
            onPointerDown={(e) => e.stopPropagation()}
            title="Collapse"
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
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 15l-6-6-6 6" />
            </svg>
          </button>
        </div>
        {/* 工作台：嵌卡片内，随卡片 resize 自然跟随；四周留 padding 保证拖拽/调整手柄可触
           垂直对齐：卡片 padding 8 上下一致，底栏内容区底部从 6 减到 0，底距卡底与顶距卡顶同 8 */}
        <div style={{ flex: 1, minHeight: 0, padding: "0 4px 0", pointerEvents: "all" }}>
          <SessionWorkbench sessionId={sessionId} />
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
          {runningMs > 0 && phase !== "idle" ? ` · ${formatDuration(runningMs)}` : ""}
        </span>
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
      {/* 中间区：最后回复（3 行截断）；无回复则回退到项目名/消息数 */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
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
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              wordBreak: "break-word",
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
      {/* 底部：最后活动时间 */}
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-dim)", borderTop: "1px solid color-mix(in srgb, var(--border) 50%, transparent)", paddingTop: 3 }}>
        <span aria-hidden style={{ flexShrink: 0 }}>🕒</span>
        <span>{formatTime(runningMs, endedAt)}</span>
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

/** 底部最后活动时间：运行中显示时长，结束/空闲显示时:分 */
function formatTime(runningMs: number, endedAt: number): string {
  if (runningMs > 0) return `${formatDuration(runningMs)} ago`;
  const d = endedAt ? new Date(endedAt) : new Date();
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
