import { BaseBoxShapeUtil, HTMLContainer, T } from "tldraw";
import type { TLBaseShape } from "tldraw";

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
}

/** 收合卡渲染（280×120 默认）。状态行 + 标题 + 元信息；选中描边由 tldraw 指示器负责。 */
function SessionCardView({ shape }: { shape: SessionCardShape }) {
  const { w, h, title, projectName, messageCount, phase, runningMs, stale, sessionId } = shape.props;

  const phaseMeta: Record<string, { dot: string; label: string }> = {
    waiting_model: { dot: "var(--accent)", label: "thinking" },
    running_tools: { dot: "#f59e0b", label: "tools" },
    running_command: { dot: "#f59e0b", label: "command" },
    waiting_input: { dot: "var(--text)", label: "waiting" },
    idle: { dot: "var(--text-dim)", label: "idle" },
    "just-ended": { dot: "#10b981", label: "done" },
  };
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
        background: "var(--panel-glass)",
        backdropFilter: "blur(var(--glass-blur-panel)) saturate(var(--glass-saturate))",
        WebkitBackdropFilter: "blur(var(--glass-blur-panel)) saturate(var(--glass-saturate))",
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
