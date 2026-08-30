import { BaseBoxShapeUtil, HTMLContainer, T } from "tldraw";
import type { TLBaseShape, TLShapePartial } from "tldraw";
import { SessionWorkbench } from "./SessionWorkbench";

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

  /** 会话卡不支持旋转：对话卡片旋转无意义，且工作台浮层无法跟随旋转。 */
  override hideRotateHandle(): boolean {
    return true;
  }

  /** 双击展开为工作台（持久化 expanded 标记，刷新后恢复）。
   *  展开 → expanded=true，宽度保留用户已 resize 的当前宽（至少 280），高度 600
   *  收合 → expanded=false，回到收合卡默认 280×120
   *  宽度不强制 760：用户调过的宽度在展开/收合间保留，避免宽度跳变。 */
  override onDoubleClick(shape: SessionCardShape): TLShapePartial<SessionCardShape> | void {
    const COLLAPSED_W = 280;
    const COLLAPSED_H = 120;
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

/** 收合卡渲染（280×120 默认）。状态行 + 标题 + 元信息；选中描边由 tldraw 指示器负责。 */
function SessionCardView({ shape }: { shape: SessionCardShape }) {
  const { w, h, title, projectName, messageCount, phase, runningMs, stale, sessionId, expanded } = shape.props;

  // 展开态：上半部标题栏（pointerEvents none → tldraw 原生拖拽/选中），
  // 下半部嵌工作台（pointerEvents all → 消息/输入可交互）。
  // 工作台在卡片内部，resize 卡片时宽度天然跟随，不再有 overlay 遮挡问题。
  if (expanded) {
    return (
      <HTMLContainer
        data-testid={`session-card-${sessionId}`}
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
          color: "var(--text)",
          userSelect: "none",
        }}
      >
        {/* 标题栏 = 拖拽区：pointerEvents none 让 tldraw 接管（拖动/选中/缩放），
            仅显示标题 + 状态圆点，不拦截鼠标 */}
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 12px",
            borderBottom: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
            pointerEvents: "none",
            cursor: "grab",
            minHeight: 36,
          }}
        >
          <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: phaseMeta[phase]?.dot ?? "var(--text-dim)", flexShrink: 0 }} />
          <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
            {title || "Untitled"}
          </span>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 10.5, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            {phaseMeta[phase]?.label ?? "idle"}
          </span>
        </div>
        {/* 工作台：嵌卡片内，随卡片 resize 自然跟随 */}
        <div style={{ flex: 1, minHeight: 0, pointerEvents: "all" }}>
          <SessionWorkbench sessionId={sessionId} />
        </div>
      </HTMLContainer>
    );
  }

  const meta = phaseMeta[phase] ?? phaseMeta.idle;

  return (
    <HTMLContainer
      data-testid={`session-card-${sessionId}`}
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
        padding: "10px 12px",
        color: "var(--text)",
        userSelect: "none",
        cursor: "grab",
      }}
    >
      {/* 状态行 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 18 }}>
        <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: meta.dot, flexShrink: 0 }} />
        <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {meta.label}
          {runningMs > 0 && phase !== "idle" ? ` · ${formatDuration(runningMs)}` : ""}
        </span>
        {stale && (
          <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)", border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)", borderRadius: 4, padding: "0 4px" }}>
            stale
          </span>
        )}
      </div>
      {/* 标题 */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          fontWeight: 600,
          fontSize: 13.5,
          lineHeight: 1.3,
          overflow: "hidden",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          wordBreak: "break-word",
        }}
      >
        {title || "Untitled"}
      </div>
      {/* 元信息 */}
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
