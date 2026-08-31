"use client";

import { useCallback, useMemo } from "react";
import { BaseBoxShapeUtil, HTMLContainer, T, resizeBox, useEditor, useValue } from "tldraw";
import type { TLBaseShape, TLShapePartial } from "tldraw";
import type { ExecStatus, ReadyStatus } from "@/lib/task-card-store";

/**
 * 任务卡（task-card）：看板上的工作项卡，独立实体（业务字段在 task_cards 表）。
 * - 收合态：编号 + 名称 + 就绪/执行状态徽章 + 优先级 + 截止
 * - 展开态（Task 6）：向右展开，左=编辑表单，右=执行会话工作台，竖线分隔
 * - 布局走 board_nodes（kind=taskcard, ref_id=cardId），画布坐标由 tldraw 管理
 * - 依赖线由 task_card_links 派生（label=kind），禁删
 */

export interface TaskCardProps {
  /** 关联的 task_cards.id；空串 = 未建卡的占位 shape（新建向导接管） */
  cardId: string;
  /** 项目内编号 #N */
  number: number;
  name: string;
  readyStatus: ReadyStatus;
  execStatus: ExecStatus;
  /** 高1 / 中0 / 低-1 */
  priority: number;
  /** ms epoch；undefined = 无截止 */
  due?: number;
  expanded: boolean;
  w: number;
  h: number;
}

export type TaskCardShape = TLBaseShape<"task-card", TaskCardProps>;

declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    "task-card": TaskCardProps;
  }
}

export const taskCardProps = {
  cardId: T.string,
  number: T.number,
  name: T.string,
  readyStatus: T.string,
  execStatus: T.string,
  priority: T.number,
  due: T.number.optional(),
  expanded: T.boolean,
  w: T.number,
  h: T.number,
};

/** 就绪状态徽章配色 */
export const READY_BADGE: Record<ReadyStatus, { color: string; label: string }> = {
  draft: { color: "#9ca3af", label: "草稿" },
  todo: { color: "#3184f8", label: "待办" },
};

/** 执行状态徽章配色（running 呼吸动画） */
export const EXEC_BADGE: Record<ExecStatus, { color: string; label: string }> = {
  not_started: { color: "#9ca3af", label: "未开始" },
  running: { color: "#10b981", label: "进行中" },
  review: { color: "#f59e0b", label: "待审核" },
  done: { color: "#10b981", label: "完成" },
  failed: { color: "#ef4444", label: "失败" },
  abandoned: { color: "#9ca3af", label: "放弃" },
  waiting_reply: { color: "#3184f8", label: "等回复" },
};

const PRIORITY_STAR = { 1: "★", 0: "", [-1]: "☆" } as Record<number, string>;

export class TaskCardUtil extends BaseBoxShapeUtil<TaskCardShape> {
  static override type = "task-card" as const;
  static override props = taskCardProps;

  override getDefaultProps(): TaskCardShape["props"] {
    return {
      cardId: "",
      number: 0,
      name: "新建任务",
      readyStatus: "draft",
      execStatus: "not_started",
      priority: 0,
      expanded: false,
      w: 220,
      h: 120,
    };
  }

  override canEdit(): boolean {
    return true;
  }

  override canResize(): boolean {
    return true;
  }

  override canScroll(): boolean {
    return true;
  }

  override hideRotateHandle(): boolean {
    return true;
  }

  override onResize(
    shape: TaskCardShape,
    info: import("tldraw").TLResizeInfo<TaskCardShape>,
  ): Omit<TLShapePartial<TaskCardShape>, "id" | "type"> | undefined {
    return resizeBox(shape, info, { minWidth: 180, minHeight: 100 });
  }

  override getIndicatorPath(shape: TaskCardShape) {
    const { w, h } = shape.props;
    const path = new Path2D();
    path.roundRect(0, 0, w, h, 12);
    return path;
  }

  override component(shape: TaskCardShape) {
    return <TaskCardView shape={shape} />;
  }
}

function TaskCardView({ shape }: { shape: TaskCardShape }) {
  const { w, h, cardId, number, name, readyStatus, execStatus, priority, due, expanded } = shape.props;
  const editor = useEditor();
  const isSelected = useValue("selected", () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id]);

  // 内容区与画布手势隔离（参照便笺）：仅拦左键，右键放行（右键菜单必须能开）
  const isolateContent = useCallback(
    (e: React.PointerEvent) => { if (e.button === 0) e.stopPropagation(); },
    [],
  );

  const exec = EXEC_BADGE[execStatus] ?? EXEC_BADGE.not_started;
  const ready = READY_BADGE[readyStatus] ?? READY_BADGE.draft;

  const dueText = useMemo(() => {
    if (!due) return null;
    const d = new Date(due);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }, [due]);

  // 收合态（展开态 Task 6 实现，暂用占位）
  if (expanded) {
    return (
      <HTMLContainer data-testid={`task-card-${shape.id}`} style={{ width: w, height: h, pointerEvents: "none" }}>
        <div style={{ width: w, height: h, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12, borderRadius: "var(--bubble-radius, 12px)", border: "1px dashed var(--border)", background: "var(--assistant-card-glass)" }}>
          展开态（编辑表单 | 工作台）— Task 6
        </div>
      </HTMLContainer>
    );
  }

  const bubbleStyle: React.CSSProperties = {
    width: w,
    height: h,
    borderRadius: "var(--bubble-radius, 12px)",
    border: isSelected ? "2px solid var(--accent)" : "1px solid var(--bubble-border)",
    background: "var(--assistant-card-glass)",
    backdropFilter: "blur(var(--glass-blur-bubble)) saturate(var(--glass-saturate))",
    WebkitBackdropFilter: "blur(var(--glass-blur-bubble)) saturate(var(--glass-saturate))",
    boxShadow: "0 2px 10px -6px rgba(0,0,0,0.2)",
    color: "var(--text)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    fontSize: 13,
    lineHeight: 1.5,
    pointerEvents: "all",
    userSelect: "none",
    cursor: "grab",
  };

  return (
    <HTMLContainer
      data-testid={`task-card-${shape.id}`}
      onPointerDown={() => editor.bringToFront([shape.id])}
      style={{ width: w, height: h, pointerEvents: "none" }}
    >
      <div style={bubbleStyle}>
        {/* 顶部行：就绪/执行状态徽章 + 优先级星标 */}
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 6, padding: "6px 10px 0", fontSize: 10 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: ready.color, fontWeight: 600 }}>
            <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: ready.color }} />
            {ready.label}
          </span>
          <span
            style={{
              display: "inline-flex", alignItems: "center", gap: 4, color: exec.color, fontWeight: 600,
              animation: execStatus === "running" ? "board-running-pulse 1.6s ease-in-out infinite" : undefined,
            }}
          >
            <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: exec.color }} />
            {exec.label}
          </span>
          <div style={{ flex: 1 }} />
          {priority !== 0 && (
            <span title={`优先级 ${priority > 0 ? "高" : "低"}`} style={{ color: "var(--text-dim)", fontSize: 11, letterSpacing: 1 }}>
              {PRIORITY_STAR[priority] ?? ""}
            </span>
          )}
        </div>
        {/* 主体：#号 + 名称 */}
        <div
          onPointerDown={isolateContent}
          style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", padding: "4px 10px", overflow: "hidden" }}
        >
          <span
            style={{
              display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
              fontSize: 13, fontWeight: 600, lineHeight: 1.35, wordBreak: "break-word",
            }}
          >
            {cardId ? <span style={{ color: "var(--text-dim)", fontWeight: 500, marginRight: 5, fontFamily: "var(--font-mono)" }}>#{number}</span> : null}
            {name}
          </span>
        </div>
        {/* 底部行：截止 + 空位 */}
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 8, padding: "0 10px 6px", fontSize: 10, color: "var(--text-dim)" }}>
          {dueText ? <span>📅 {dueText}</span> : <span>—</span>}
          <div style={{ flex: 1 }} />
        </div>
      </div>
    </HTMLContainer>
  );
}
