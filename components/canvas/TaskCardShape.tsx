"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { BaseBoxShapeUtil, HTMLContainer, T, resizeBox, useEditor, useValue } from "tldraw";
import type { TLBaseShape, TLShapeId, TLShapePartial } from "tldraw";
import type { ExecStatus, ReadyStatus, TaskCard } from "@/lib/task-card-store";
import { linkTargetIds, useTaskCard } from "@/hooks/useTaskCards";
import { ThemedSelect } from "./ThemedSelect";
import { useCardGlass } from "@/hooks/useCardGlass";
import { TaskCardMultiSelect } from "./TaskCardMultiSelect";
import { CardKindBadge } from "./CardKindBadge";
import { DirectoryPicker } from "@/components/DirectoryPicker";
import { WorktreePicker } from "./WorktreePicker";

/**
 * 任务卡（task-card）：看板上的工作项卡，独立实体（业务字段在 task_cards 表）。
 * - 常态（表单栏常驻）：编辑表单（空卡=建卡向导），宽 380；描述之下字段收进「高级」折叠区
 * - 展开：纯表单加宽，宽 760（双击切换）；无内置工作台（原子-链接）
 * - 布局走 board_nodes（kind=taskcard, ref_id=cardId），shape.id 去 "shape:" 前缀 = node id
 * - 依赖线由 task_card_links 派生（label=kind）、exec 线由 task_cards.session_id 派生（label=exec），禁删
 */

/** 当前看板上下文（SessionCanvas 提供）：boardId + 左侧栏当前选中目录（建卡 cwd 默认值）。 */
export const BoardIdContext = createContext<{ boardId: string | null; defaultCwd: string | null } | null>(null);
export function useBoardId(): string | null {
  return useContext(BoardIdContext)?.boardId ?? null;
}
/** 左侧栏当前选中目录（newSessionCwd），任务卡建卡时 cwd 默认值。 */
export function useBoardDefaultCwd(): string | null {
  return useContext(BoardIdContext)?.defaultCwd ?? null;
}

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
  /** 展开态手动尺寸（收起时记录，刷新保留）；0 = 未设置用默认 */
  expandedW: number;
  expandedH: number;
  /** 收合态手动尺寸（展开时记录，刷新保留）；0 = 未设置用默认 */
  collapsedW: number;
  collapsedH: number;
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
  expandedW: T.number,
  expandedH: T.number,
  collapsedW: T.number,
  collapsedH: T.number,
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

/** 常态 = 编辑表单栏；展开 = 纯表单加宽（无内置工作台，原子-链接） */
const FORM_W = 380;
const FORM_H = 270;
/** 展开态默认宽 = 表单加宽（无右侧工作台） */
const EXPANDED_W = 760;
const EXPANDED_H = 600;
/** 收起态最小高（表单：名称/描述 + 折叠的「高级」标题） */
const COLLAPSED_MIN_H = 240;

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
      w: FORM_W,
      h: FORM_H,
      expandedW: 0,
      expandedH: 0,
      collapsedW: 0,
      collapsedH: 0,
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

  /** 双击切换展开/收合（常态 380 表单栏 ↔ 展开 760 纯表单加宽），两态手动尺寸各自保留。 */
  override onDoubleClick(shape: TaskCardShape): TLShapePartial<TaskCardShape> | void {
    return { id: shape.id, type: "task-card", props: nextExpandState(shape) };
  }

  override onResize(
    shape: TaskCardShape,
    info: import("tldraw").TLResizeInfo<TaskCardShape>,
  ): Omit<TLShapePartial<TaskCardShape>, "id" | "type"> | undefined {
    // 收起/展开两态最小尺寸：展开态表单加宽，收合态紧凑表单
    const expanded = shape.props.expanded;
    const minW = expanded ? 480 : FORM_W;
    const minH = expanded ? 400 : COLLAPSED_MIN_H;
    return resizeBox(shape, info, { minWidth: minW, minHeight: minH });
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

/** 展开/收起尺寸切换（参考会话卡片）：收起时记录展开尺寸（expandedW/H）→ 恢复上次收合尺寸；
 *  展开时记录收合尺寸（collapsedW/H）→ 恢复上次展开尺寸。两态手动 resize 的尺寸来回切换不丢失，
 *  刷新后从 board_nodes props 还原。 */
function nextExpandState(shape: TaskCardShape) {
  if (shape.props.expanded) {
    // 展开 → 收合
    return {
      expanded: false,
      expandedW: shape.props.w,
      expandedH: shape.props.h,
      w: shape.props.collapsedW || FORM_W,
      h: shape.props.collapsedH || FORM_H,
    };
  }
  // 收合 → 展开
  return {
    expanded: true,
    collapsedW: shape.props.w,
    collapsedH: shape.props.h,
    w: shape.props.expandedW || EXPANDED_W,
    h: shape.props.expandedH || EXPANDED_H,
  };
}

function TaskCardView({ shape }: { shape: TaskCardShape }) {
  return <TaskCardBody shape={shape} />;
}

// ============================================================================
// 任务卡本体：编辑表单（空卡=建卡向导）常驻；展开态表单加宽（无内置工作台，
// 执行会话通过 exec 线引用画布独立会话卡——原子-链接，见 spec 2026-09-01-task-card-atomic-link.md）
// ============================================================================

const FIELD_STYLE: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "transparent",
  color: "var(--text)",
  fontSize: 12,
  padding: "4px 8px",
  outline: "none",
};

const LABEL_STYLE: React.CSSProperties = {
  display: "block",
  fontSize: 10,
  color: "var(--text-muted)",
  fontWeight: 600,
  margin: "8px 0 3px",
};

function TaskCardBody({ shape }: { shape: TaskCardShape }) {
  const { cardId, w, h, expanded } = shape.props;
  const editor = useEditor();
  const boardId = useBoardId();
  const defaultCwd = useBoardDefaultCwd();
  // 任务卡详情（表单真相源 + 执行会话 sessionId）：挂载/展开时拉取一次；
  // 不再 8s 轮询——运行中状态由 2.5s running 快照驱动（原子-链接 spec §3.2）
  const { detail, candidates, loading, error, reload, createCard, saveCard } = useTaskCard(
    cardId || null,
    boardId,
  );

  // 卡片激活判定（与 SessionWorkbench 同模式）：实时读 editor，不引 React 重渲染
  const isActive = useCallback(() => {
    const card = rootRef.current?.closest(".tl-html-container");
    const nodeId = card?.getAttribute("data-node-id");
    if (!nodeId) return false;
    return editor.getSelectedShapeIds().includes(`shape:${nodeId}` as TLShapeId);
  }, [editor]);

  const rootRef = useRef<HTMLDivElement>(null);
  // 卡片玻璃（局部贴图）：内嵌视口对齐的模糊壁纸层，见 useCardGlass
  const setGlassContainer = useCardGlass(editor, shape.id, "var(--assistant-card-glass)");

  const isCreating = !cardId;
  // 执行会话 id（exec 线真相源）：用于「定位执行会话」跳到画布上对应的会话卡
  const sessionId = detail?.card.sessionId ?? null;

  // 展开即时：展开时重新拉详情（拿调度器最新派发的 sessionId/执行状态，不依赖轮询）
  useEffect(() => {
    if (expanded && !isCreating) void reload();
  }, [expanded, isCreating, reload]);

  // 定位执行会话：跳到画布上该会话的独立会话卡并选中（工作台已移除，原子-链接）
  const focusExecSession = useCallback(() => {
    if (!sessionId) return;
    for (const shape of editor.getCurrentPageShapes()) {
      if (shape.type !== "session-card") continue;
      const p = shape.props as { sessionId?: string; w?: number; h?: number };
      if (p.sessionId !== sessionId) continue;
      const center = { x: shape.x + (p.w ?? 0) / 2, y: shape.y + (p.h ?? 0) / 2 };
      editor.centerOnPoint(center);
      editor.select(shape.id);
      return;
    }
  }, [editor, sessionId]);

  // 删除任务卡入口在右键菜单（SyncedContextMenu）：确认 → DELETE /api/task-cards/[id]（级联删）→ 删 shape

  // 轮询器状态同步：画布层 2.5s 轮询会把本 shape 的 execStatus props 更新为调度器最新状态，
  // 这里镜像进 draft——头部徽章（读 draft.execStatus）自动刷新，保存时也不会用旧值覆盖调度器状态。
  const shapeExecStatus = useValue("execStatus", () => {
    const s = editor.getShape(shape.id);
    return (s?.props as TaskCardProps | undefined)?.execStatus ?? null;
  }, [editor, shape.id]);
  useEffect(() => {
    if (shapeExecStatus && draft && draft.execStatus !== shapeExecStatus) {
      set("execStatus", shapeExecStatus as ExecStatus);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeExecStatus]);

  // 表单草稿（受控）。空卡=默认草稿（建卡向导）；已建卡=detail 加载后初始化一次。
  const [draft, setDraft] = useState<TaskCard | null>(() =>
    isCreating
      ? {
          id: "",
          boardId: "",
          projectKey: "",
          number: 0,
          name: "",
          description: "",
          readyStatus: "draft",
          execStatus: "not_started",
          priority: 0,
          due: null,
          attachments: [],
          cwd: defaultCwd,
          useWorktree: false,
          maxRetries: 3,
          retryCount: 0,
          sessionId: null,
          created: 0,
          updated: 0,
        }
      : null,
  );
  useEffect(() => {
    if (!isCreating && detail?.card && !draft) {
      setDraft({ ...detail.card });
    }
  }, [isCreating, detail, draft]);

  const [draftPrereq, setDraftPrereq] = useState<string[]>([]);
  const [draftRelated, setDraftRelated] = useState<string[]>([]);
  const depsInitializedRef = useRef(false);
  useEffect(() => {
    // 依赖草稿只在 detail 首次可用时初始化一次（空数组也是新引用，直接依赖数组会死循环）
    if (detail && !depsInitializedRef.current) {
      depsInitializedRef.current = true;
      setDraftPrereq(linkTargetIds(detail.links, "prerequisite"));
      setDraftRelated(linkTargetIds(detail.links, "related"));
    }
  }, [detail]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 「高级」折叠区：默认收起
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // 展开态自动展开「高级」折叠区；收起时自动收起
  useEffect(() => {
    setAdvancedOpen(expanded);
  }, [expanded]);

  // 工作目录选择：DirectoryPicker 弹窗
  const [dirPickerOpen, setDirPickerOpen] = useState(false);
  // 当前选中 worktree 路径（null = 用 cwd 本身，可能是主 checkout 或非 git）；WorktreePicker 接管列表/新建
  const [wtPath, setWtPath] = useState<string | null>(null);

  const set = <K extends keyof TaskCard>(key: K, value: TaskCard[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };

  // wheel 拦截（表单区可滚动）：原生监听，激活态 + 内容溢出才拦
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      if (!isActive()) return;
      const t = e.target;
      if (t instanceof Node && el.contains(t) && hasScrollableAncestor(t, el)) e.stopPropagation();
    };
    el.addEventListener("wheel", stop);
    return () => el.removeEventListener("wheel", stop);
  });

  // 建卡向导提交（空卡）
  const handleCreate = async () => {
    if (!boardId || !draft?.name.trim()) return;
    setSaving(true);
    setSaveError(null);
    // 复用本空卡的画布 node（data-node-id = shape.id 去 shape: 前缀），服务端绑定 refId=cardId
    const container = rootRef.current?.closest(".tl-html-container");
    const nodeId = container?.getAttribute("data-node-id") ?? undefined;
    const created = await createCard({
      boardId,
      nodeId,
      name: draft.name,
      description: draft.description,
      readyStatus: draft.readyStatus,
      priority: draft.priority,
      due: draft.due ?? null,
      cwd: draft.cwd ?? undefined,
      useWorktree: draft.useWorktree,
      maxRetries: draft.maxRetries,
      attachments: draft.attachments,
      prerequisites: draftPrereq,
      related: draftRelated,
    });
    setSaving(false);
    if (created) {
      // 更新 shape props：转正为空卡为已建卡（cardId 落 shape，store 变更自动持久化）
      editor.updateShape<TaskCardShape>({
        id: shape.id,
        type: "task-card",
        props: {
          cardId: created.id,
          number: created.number,
          name: created.name,
          readyStatus: created.readyStatus,
          execStatus: created.execStatus,
          priority: created.priority,
          due: created.due ?? undefined,
        },
      });
      // 立即把 cardId 写库（不依赖防抖全量保存）：服务端 refId 已绑，但 shape props 里的
      // cardId 需持久化，否则刷新后 hydrate 用 refId 恢复也够；这里再补一发节点 PATCH 保底
      setDraft((d) => (d ? { ...d, ...created, sessionId: created.sessionId } : d));
      void reload();
    }
  };

  // 编辑保存（已建卡）
  const handleSave = async () => {
    if (!draft?.name.trim()) return;
    setSaving(true);
    setSaveError(null);
    const ok = await saveCard({
      name: draft.name,
      description: draft.description,
      readyStatus: draft.readyStatus,
      // execStatus 由调度器维护（用户只读），保存不提交——防编辑保存把 done/failed 等终态回写成旧值诱发重复审核
      priority: draft.priority,
      due: draft.due ?? null,
      attachments: draft.attachments,
      cwd: draft.cwd ?? null,
      useWorktree: draft.useWorktree,
      maxRetries: draft.maxRetries,
      prerequisites: draftPrereq,
      related: draftRelated,
    });
    setSaving(false);
    if (ok) {
      // 同步收合态展示字段（execStatus 由画布层轮询镜像，不在保存时回写）
      editor.updateShape<TaskCardShape>({
        id: shape.id,
        type: "task-card",
        props: {
          name: draft.name,
          readyStatus: draft.readyStatus,
          priority: draft.priority,
          due: draft.due ?? undefined,
        },
      });
    } else {
      setSaveError(error ?? "保存失败");
    }
  };

  // 就绪状态即时生效：编辑态 change 即保存（PATCH 部分字段）；建卡态仅记草稿，创建时提交
  const handleReadyChange = (v: string) => {
    set("readyStatus", v as ReadyStatus);
    if (!isCreating && cardId) void saveCard({ readyStatus: v as ReadyStatus });
  };

  // —— 未保存编辑（dirty）判定：与 detail 对比（就绪状态已即时保存，不计入 dirty）——
  const isDirty = useMemo(() => {
    if (isCreating || !detail?.card || !draft) return false;
    const c = detail.card;
    return (
      draft.name !== c.name ||
      draft.description !== c.description ||
      draft.priority !== c.priority ||
      draft.due !== c.due ||
      draft.cwd !== c.cwd ||
      draft.useWorktree !== c.useWorktree ||
      draft.maxRetries !== c.maxRetries ||
      JSON.stringify(draft.attachments ?? []) !== JSON.stringify(c.attachments ?? []) ||
      JSON.stringify([...draftPrereq].sort()) !== JSON.stringify(linkTargetIds(detail.links, "prerequisite").sort()) ||
      JSON.stringify([...draftRelated].sort()) !== JSON.stringify(linkTargetIds(detail.links, "related").sort())
    );
  }, [isCreating, detail, draft, draftPrereq, draftRelated]);

  // —— 离开卡片自动保存（与便笺“退出编辑自动保存”一致）：选中 → 未选中且 dirty 时保存。
  // 用 useValue 订阅选中态（返回 boolean，store 变化时才重渲染）；handler 走 ref 避免 effect 依赖抖动。
  const isSelected = useValue("selected", () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id]);
  const wasSelectedRef = useRef(isSelected);
  const dirtyRef = useRef(isDirty);
  dirtyRef.current = isDirty;
  const saveRef = useRef(handleSave);
  saveRef.current = handleSave;
  useEffect(() => {
    const wasSelected = wasSelectedRef.current;
    wasSelectedRef.current = isSelected;
    if (wasSelected && !isSelected && !isCreating && dirtyRef.current) {
      void saveRef.current();
    }
  }, [isSelected, isCreating]);

  // —— 取消：撤销未保存编辑，恢复 detail 原值（含依赖与工作区选中）——
  const handleCancelEdit = () => {
    if (!detail) return;
    setDraft({ ...detail.card });
    setDraftPrereq(linkTargetIds(detail.links, "prerequisite"));
    setDraftRelated(linkTargetIds(detail.links, "related"));
    setWtPath(null);
    setSaveError(null);
  };

  const formBody = draft ? (
    <>
      <label style={LABEL_STYLE}>任务名称 *</label>
      <input
        style={FIELD_STYLE}
        value={draft.name}
        onChange={(e) => set("name", e.target.value)}
        placeholder="任务名称"
      />
      <label style={LABEL_STYLE}>需求说明</label>
      <textarea
        style={{ ...FIELD_STYLE, flex: 1, minHeight: 70, resize: "none", fontFamily: "var(--font-mono)", fontSize: 11 }}
        value={draft.description}
        onChange={(e) => set("description", e.target.value)}
        placeholder="任务描述"
        spellCheck={false}
      />
      <CollapsibleSection title="高级" open={advancedOpen} onToggle={() => setAdvancedOpen((v) => !v)}>
      {/* 1. 工作目录 */}
      <label style={LABEL_STYLE}>工作目录</label>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          style={{ ...FIELD_STYLE, flex: 1 }}
          value={draft.cwd ?? ""}
          onChange={(e) => set("cwd", e.target.value || null)}
          placeholder="默认项目根目录"
          readOnly
        />
        <button
          type="button"
          style={footerBtnStyle}
          onClick={() => setDirPickerOpen(true)}
        >
          选择目录
        </button>
      </div>
      {dirPickerOpen && draft && (
        <DirectoryPicker
          onCancel={() => setDirPickerOpen(false)}
          onSelect={(path) => { set("cwd", path); setDirPickerOpen(false); }}
        />
      )}
      {/* 2. 工作区（worktree，支持手动新建） */}
      <label style={LABEL_STYLE}>工作区</label>
      <WorktreePicker
        cwd={draft.cwd}
        value={wtPath}
        onChange={(p) => { setWtPath(p); set("cwd", p); }}
      />
      {/* 3. 预计截止（单独一行） */}
      <label style={LABEL_STYLE}>预计截止</label>
      <DuePicker due={draft.due ?? null} onChange={(ms) => set("due", ms)} />
      {/* 4. 优先级 + 最大重试次数（两列一行） */}
      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={LABEL_STYLE}>优先级</label>
          <ThemedSelect
            value={String(draft.priority)}
            onChange={(v) => set("priority", Number(v))}
            options={[
              { value: "1", label: "高" },
              { value: "0", label: "中" },
              { value: "-1", label: "低" },
            ]}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={LABEL_STYLE}>最大重试次数</label>
          <input
            style={FIELD_STYLE}
            type="number"
            min={0}
            value={draft.maxRetries}
            onChange={(e) => set("maxRetries", Math.max(0, Number(e.target.value) || 0))}
          />
        </div>
      </div>
      <label style={LABEL_STYLE}>前置任务（可多选）</label>
      <TaskCardMultiSelect
        candidates={candidates}
        selected={draftPrereq}
        onChange={setDraftPrereq}
        excludeId={cardId}
        placeholder="本看板内选择前置任务…"
      />
      <label style={LABEL_STYLE}>关联任务（可多选）</label>
      <TaskCardMultiSelect
        candidates={candidates}
        selected={draftRelated}
        onChange={setDraftRelated}
        excludeId={cardId}
        placeholder="本看板内选择关联任务…"
      />
      <label style={LABEL_STYLE}>附件（引用文件路径，每行一个）</label>
      <textarea
        style={{ ...FIELD_STYLE, minHeight: 46, resize: "vertical", fontFamily: "var(--font-mono)", fontSize: 11 }}
        value={(draft.attachments ?? []).join("\n")}
        onChange={(e) => set("attachments", e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))}
        placeholder="/path/to/file"
        spellCheck={false}
      />
      </CollapsibleSection>
      {(saveError || error) && <div style={{ color: "#f87171", fontSize: 11, marginTop: 6 }}>{saveError ?? error}</div>}
    </>
  ) : loading ? (
    <div style={{ color: "var(--text-dim)", fontSize: 12, padding: 20, textAlign: "center" }}>加载中…</div>
  ) : (
    <div style={{ color: "var(--text-dim)", fontSize: 12, padding: 20, textAlign: "center" }}>未找到任务卡</div>
  );

  return (
    <HTMLContainer
      data-node-id={shape.id.replace("shape:", "")}
      data-testid={`task-card-${shape.id}`}
      // 点卡片置顶（与会话卡同模式）：两卡重叠时点哪个哪个到最上层；
      // 表单区已选中时 stopPropagation，不会重复触发
      onPointerDown={() => editor.bringToFront([shape.id])}
      style={{ width: w, height: h, pointerEvents: "none" }}
    >
      <div
        ref={(node) => { rootRef.current = node; setGlassContainer(node); }}
        style={{
          position: "relative",
          width: w,
          height: h,
          borderRadius: "var(--bubble-radius, 12px)",
          border: "1px solid var(--bubble-border)",
          // 透明：色层已由内嵌层提供（useCardGlass 的 linear-gradient 单层 0.44），
          // 容器再叠背景色会双重叠加更不透
          background: "transparent",
          boxShadow: "0 2px 10px -6px rgba(0,0,0,0.2)",
          color: "var(--text)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          pointerEvents: "all",
          userSelect: "none",
        }}
      >
        {/* 拖拽把手：不拦 pointer（事件冒泡到 tldraw 接管拖动），与便笺同模式；
            右上角就绪下拉 + 操作按钮独立接收点击（stopPropagation 隔离拖拽） */}
        <div
          style={{
            flexShrink: 0,
            height: 36,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 10px",
            borderBottom: "1px solid var(--bubble-hairline)",
            cursor: "grab",
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          {/* 类别徽记：圆点 = exec 状态色 + 类别文字「任务」（状态文字由类别取代，状态靠圆点颜色，hover 见 title） */}
          <span
            title={`执行状态：${(EXEC_BADGE[draft?.execStatus ?? "not_started"] ?? EXEC_BADGE.not_started).label}`}
            style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}
          >
            <CardKindBadge kind="task" color={(EXEC_BADGE[draft?.execStatus ?? "not_started"] ?? EXEC_BADGE.not_started).color} />
          </span>
          {/* 标题：名称 + 编号（编号算入标题一部分，同深色样式）；与左侧类型浅色字区分 */}
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>
            {draft?.name || (isCreating ? "新建任务卡" : "任务卡")}
          </span>
          {draft?.number ? <span style={{ flexShrink: 0, fontSize: 12.5, fontWeight: 600, color: "var(--text)", marginLeft: 4 }}>#{draft.number}</span> : null}
          {/* 右上角：就绪状态下拉（在操作按钮之前）+ 操作按钮（对齐便笺小 ghost 样式） */}
          <div
            style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {/* 就绪状态复选框：勾选=激活（待办）→ 文案「就绪」；未勾=草稿，默认不激活。无任何装饰，仅文字+勾选小方块 */}
            <button
              type="button"
              role="checkbox"
              aria-checked={draft?.readyStatus === "todo"}
              onClick={() => handleReadyChange(draft?.readyStatus === "todo" ? "draft" : "todo")}
              title={draft?.readyStatus === "todo" ? "已激活（待办），点击改为草稿" : "点击激活（待办）"}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                padding: 0,
                background: "transparent",
                border: "none",
                borderRadius: 0,
                color: draft?.readyStatus === "todo" ? "var(--text)" : "var(--text-muted)",
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 11,
                  height: 11,
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 2,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--accent)",
                }}
              >
                {draft?.readyStatus === "todo" && (
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
              </span>
              {draft?.readyStatus === "todo" ? "就绪" : "草稿"}
            </button>
            {sessionId && (
              <button
                type="button"
                style={footerBtnStyle}
                onClick={focusExecSession}
                title="定位到该任务的执行会话卡"
              >
                会话
              </button>
            )}
            {isCreating ? (
              <button
                type="button"
                style={footerBtnStyle}
                disabled={saving || !draft?.name.trim() || !boardId}
                onClick={() => void handleCreate()}
                title="创建任务卡"
              >
                {saving ? "创建中…" : "创建"}
              </button>
            ) : isDirty ? (
              <>
                <button
                  type="button"
                  style={footerBtnStyle}
                  onClick={handleCancelEdit}
                  title="撤销本次编辑"
                >
                  取消
                </button>
                <button
                  type="button"
                  style={footerBtnStyle}
                  disabled={saving || !draft?.name.trim()}
                  onClick={() => void handleSave()}
                  title="完成（保存）"
                >
                  {saving ? "保存中…" : "完成"}
                </button>
              </>
            ) : null}
          </div>
        </div>
        {/* 内容区：编辑表单（无右侧工作台，原子-链接） */}
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {/* 编辑表单 / 建卡向导（常驻，占满卡片）——无右侧工作台（原子-链接）。
            隐藏滚动条（[scrollbar-width:none]，与 ChatWindow 同惯例） */}
        <div
          className="[scrollbar-width:none]"
          style={{ flex: "1 1 auto", minWidth: 0, overflowY: "auto", padding: "10px 12px", display: "flex", flexDirection: "column" }}
          onPointerDown={(e) => { if (e.button === 0 && isActive()) e.stopPropagation(); }}
          onPointerUp={(e) => { if (e.button === 0 && isActive()) e.stopPropagation(); }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {formBody}
        </div>
        {/* 执行会话不在任务卡内展示：任务卡通过 exec 线引用画布独立会话卡（原子-链接）。
            「定位执行会话」入口在 S2-4 加入（跳到连着的会话卡）。 */}
      </div>
      </div>
    </HTMLContainer>
  );
}

/** 操作按钮：对齐便笺右上角小 ghost 样式（无边框、半透明灰底、圆角 5、字号 11）。 */
const footerBtnStyle: React.CSSProperties = {
  border: "none",
  background: "color-mix(in srgb, var(--border) 30%, transparent)",
  color: "var(--text-muted)",
  borderRadius: 5,
  padding: "2px 10px",
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

/** 「高级」折叠区标题行：分隔线 + 箭头 + 标题（默认收起）。 */
function CollapsibleSection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          width: "100%",
          marginTop: 10,
          padding: "5px 0 3px",
          border: "none",
          borderTop: "1px solid var(--bubble-hairline)",
          background: "transparent",
          color: "var(--text-muted)",
          fontSize: 11,
          fontWeight: 600,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.12s" }}
        >
          <polyline points="3 2 6.5 5 3 8" />
        </svg>
        {title}
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

/** ms epoch → datetime-local 输入值（本地时间） */
/**
 * 预计截止：年/月/日 三个主题化下拉联动（无原生控件，观感对齐表单其余部分）。
 * 无日期时默认当天；选完组装 ms epoch（当日 00:00 本地）。
 */
function DuePicker({ due, onChange }: { due: number | null; onChange: (ms: number | null) => void }) {
  const now = new Date();
  const d = due ? new Date(due) : now;
  const [y, m, day] = [d.getFullYear(), d.getMonth() + 1, d.getDate()];

  const years: string[] = [];
  for (let i = now.getFullYear() - 2; i <= now.getFullYear() + 3; i++) years.push(String(i));
  const months = Array.from({ length: 12 }, (_, i) => String(i + 1));
  const daysInMonth = new Date(y, m, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => String(i + 1));

  const assemble = (ny: number, nm: number, nd: number) => {
    const t = new Date(ny, nm - 1, nd, 0, 0, 0, 0).getTime();
    onChange(Number.isNaN(t) ? null : t);
  };

  return (
    <div style={{ display: "flex", gap: 4 }}>
      <div style={{ flex: 1.4, minWidth: 0 }}>
        <ThemedSelect value={String(y)} options={years.map((v) => ({ value: v, label: v }))} onChange={(v) => assemble(Number(v), m, Math.min(day, daysInMonth))} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <ThemedSelect value={String(m)} options={months.map((v) => ({ value: v, label: `${v}月` }))} onChange={(v) => assemble(y, Number(v), Math.min(day, new Date(y, Number(v), 0).getDate()))} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <ThemedSelect value={String(day)} options={days.map((v) => ({ value: v, label: v }))} onChange={(v) => assemble(y, m, Number(v))} />
      </div>
    </div>
  );
}

/** 从目标向上找可滚动容器（到 root 为止）。 */
function hasScrollableAncestor(target: Node, root: HTMLElement): boolean {
  let elm: Element | null = target instanceof Element ? target : target.parentElement;
  while (elm && elm instanceof HTMLElement) {
    if (elm === root) break;
    const overflowsY = elm.scrollHeight > elm.clientHeight;
    const overflowsX = elm.scrollWidth > elm.clientWidth;
    if (overflowsY || overflowsX) {
      const style = getComputedStyle(elm);
      const oy = style.overflowY;
      const ox = style.overflowX;
      if (
        (overflowsY && (oy === "auto" || oy === "scroll" || oy === "overlay")) ||
        (overflowsX && (ox === "auto" || ox === "scroll" || ox === "overlay"))
      ) {
        return true;
      }
    }
    elm = elm.parentElement;
  }
  return false;
}
