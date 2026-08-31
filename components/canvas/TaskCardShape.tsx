"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { BaseBoxShapeUtil, HTMLContainer, T, resizeBox, useEditor } from "tldraw";
import type { TLBaseShape, TLShapeId, TLShapePartial } from "tldraw";
import type { ExecStatus, ReadyStatus, TaskCard } from "@/lib/task-card-store";
import { linkTargetIds, useTaskCard } from "@/hooks/useTaskCards";
import { SessionWorkbench } from "./SessionWorkbench";
import { ThemedSelect } from "./ThemedSelect";
import { DirectoryPicker } from "@/components/DirectoryPicker";

/**
 * 任务卡（task-card）：看板上的工作项卡，独立实体（业务字段在 task_cards 表）。
 * - 常态（表单栏常驻）：左=编辑表单（空卡=建卡向导），宽 340
 * - 展开：右侧追加执行会话工作台，宽 900（双击/按钮切换）
 * - 布局走 board_nodes（kind=taskcard, ref_id=cardId），shape.id 去 "shape:" 前缀 = node id
 * - 依赖线由 task_card_links 派生（label=kind），禁删
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

/** 常态 = 编辑表单栏（左侧常驻）；展开 = 右侧追加工作台 */
const FORM_W = 340;
const FORM_H = 300;
const EXPANDED_W = 900;
const EXPANDED_H = 600;

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

  /** 双击切换右侧工作台展开（常态 340 表单栏 ↔ 展开 900 表单+工作台）。 */
  override onDoubleClick(shape: TaskCardShape): TLShapePartial<TaskCardShape> | void {
    if (shape.props.expanded) {
      return { id: shape.id, type: "task-card", props: { expanded: false, w: FORM_W, h: shape.props.h } };
    }
    return { id: shape.id, type: "task-card", props: { expanded: true, w: EXPANDED_W, h: EXPANDED_H } };
  }

  override onResize(
    shape: TaskCardShape,
    info: import("tldraw").TLResizeInfo<TaskCardShape>,
  ): Omit<TLShapePartial<TaskCardShape>, "id" | "type"> | undefined {
    return resizeBox(shape, info, { minWidth: FORM_W, minHeight: 240 });
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
  return <TaskCardBody shape={shape} />;
}

// ============================================================================
// 任务卡本体：左=编辑表单（空卡=建卡向导）常驻；expanded 时右侧追加执行会话工作台
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
  const { detail, candidates, loading, error, reload, createCard, saveCard } = useTaskCard(cardId || null, boardId);

  // 卡片激活判定（与 SessionWorkbench 同模式）：实时读 editor，不引 React 重渲染
  const isActive = useCallback(() => {
    const card = rootRef.current?.closest(".tl-html-container");
    const nodeId = card?.getAttribute("data-node-id");
    if (!nodeId) return false;
    return editor.getSelectedShapeIds().includes(`shape:${nodeId}` as TLShapeId);
  }, [editor]);

  const rootRef = useRef<HTMLDivElement>(null);

  const isCreating = !cardId;
  const sessionId = detail?.card.sessionId ?? null;

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

  // 工作目录选择：DirectoryPicker 弹窗 + worktree 列表（复用文件浏览器下方选择器逻辑）
  const [dirPickerOpen, setDirPickerOpen] = useState(false);
  const [worktrees, setWorktrees] = useState<Array<{ path: string; branch: string; isMain: boolean }>>([]);
  // 当前选中 worktree 路径（null = 用 cwd 本身，可能是主 checkout 或非 git）
  const [wtPath, setWtPath] = useState<string | null>(null);

  // 加载 cwd 所在项目的 worktrees（git 项目才有）
  useEffect(() => {
    const cwd = draft?.cwd;
    if (!cwd) { setWorktrees([]); setWtPath(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/worktrees?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { worktrees?: Array<{ path: string; branch: string; isMain: boolean }>; isGit?: boolean };
        if (cancelled) return;
        setWorktrees(data.isGit ? (data.worktrees ?? []) : []);
        // 当前 cwd 若正好是某 worktree 路径，选中它
        const cur = data.worktrees?.find((w) => w.path === cwd);
        setWtPath(cur?.path ?? null);
      } catch {
        // 静默：非 git / 目录不可访问时 worktree 区不显示
      } finally {
      }
    })();
    return () => { cancelled = true; };
  }, [draft?.cwd]);

  // 选择 worktree：cwd 联动到 worktree 路径（主 checkout 则回到项目根）
  const handleWorktreeSelect = (path: string) => {
    setWtPath(path);
    set("cwd", path);
  };

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
      execStatus: draft.execStatus,
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
      // 同步收合态展示字段
      editor.updateShape<TaskCardShape>({
        id: shape.id,
        type: "task-card",
        props: {
          name: draft.name,
          readyStatus: draft.readyStatus,
          execStatus: draft.execStatus,
          priority: draft.priority,
          due: draft.due ?? undefined,
        },
      });
    } else {
      setSaveError(error ?? "保存失败");
    }
  };

  const formBody = draft ? (
    <>
      {isCreating && (
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
          新建任务卡
        </div>
      )}
      <label style={LABEL_STYLE}>任务名称 *</label>
      <input
        style={FIELD_STYLE}
        value={draft.name}
        onChange={(e) => set("name", e.target.value)}
        placeholder="任务名称"
      />
      <label style={LABEL_STYLE}>描述（Markdown）</label>
      <textarea
        style={{ ...FIELD_STYLE, minHeight: 70, resize: "vertical", fontFamily: "var(--font-mono)", fontSize: 11 }}
        value={draft.description}
        onChange={(e) => set("description", e.target.value)}
        placeholder="任务描述，支持 markdown"
        spellCheck={false}
      />
      <label style={LABEL_STYLE}>就绪状态</label>
      <ThemedSelect
        value={draft.readyStatus}
        onChange={(v) => set("readyStatus", v as ReadyStatus)}
        options={[
          { value: "draft", label: "草稿" },
          { value: "todo", label: "待办" },
        ]}
      />
      <label style={LABEL_STYLE}>执行状态</label>
      {/* 执行状态由调度器维护，用户只读查看 */}
      <div
        style={{
          display: "flex", alignItems: "center", gap: 6, height: 28, padding: "0 8px",
          border: "1px solid var(--border)", borderRadius: 5, fontSize: 11, color: "var(--text-muted)",
        }}
      >
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: (EXEC_BADGE[draft.execStatus] ?? EXEC_BADGE.not_started).color }} />
        {(EXEC_BADGE[draft.execStatus] ?? EXEC_BADGE.not_started).label}
      </div>
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
          <label style={LABEL_STYLE}>预计截止</label>
          <DuePicker due={draft.due ?? null} onChange={(ms) => set("due", ms)} />
        </div>
      </div>
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
          style={btnGhost}
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
      {worktrees.length > 0 && (
        <>
          <label style={LABEL_STYLE}>Worktree（git 分支）</label>
          <ThemedSelect
            value={wtPath ?? ""}
            onChange={handleWorktreeSelect}
            options={[
              ...worktrees.map((w) => ({
                value: w.path,
                label: w.isMain ? `主 checkout（${w.branch ?? ""}）` : `${w.branch ?? ""}`,
              })),
            ]}
          />
        </>
      )}
      <label style={LABEL_STYLE}>最大重试次数</label>
      <input
        style={FIELD_STYLE}
        type="number"
        min={0}
        value={draft.maxRetries}
        onChange={(e) => set("maxRetries", Math.max(0, Number(e.target.value) || 0))}
      />
      <>
          <label style={LABEL_STYLE}>前置任务（可多选）</label>
          <div style={{ maxHeight: 90, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: 4 }}>
            {candidates.filter((c) => c.id !== cardId).map((c) => (
              <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text)", cursor: "pointer", padding: "1px 0" }}>
                <input
                  type="checkbox"
                  checked={draftPrereq.includes(c.id)}
                  onChange={(e) => setDraftPrereq((p) => (e.target.checked ? [...p, c.id] : p.filter((x) => x !== c.id)))}
                />
                #{c.number} {c.name}
              </label>
            ))}
            {candidates.length <= 1 && <div style={{ color: "var(--text-dim)", fontSize: 10 }}>无其他任务卡可选</div>}
          </div>
          <label style={LABEL_STYLE}>关联任务（可多选）</label>
          <div style={{ maxHeight: 90, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: 4 }}>
            {candidates.filter((c) => c.id !== cardId).map((c) => (
              <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text)", cursor: "pointer", padding: "1px 0" }}>
                <input
                  type="checkbox"
                  checked={draftRelated.includes(c.id)}
                  onChange={(e) => setDraftRelated((p) => (e.target.checked ? [...p, c.id] : p.filter((x) => x !== c.id)))}
                />
                #{c.number} {c.name}
              </label>
            ))}
            {candidates.length <= 1 && <div style={{ color: "var(--text-dim)", fontSize: 10 }}>无其他任务卡可选</div>}
          </div>
      </>
      <label style={LABEL_STYLE}>附件（引用文件路径，每行一个）</label>
      <textarea
        style={{ ...FIELD_STYLE, minHeight: 46, resize: "vertical", fontFamily: "var(--font-mono)", fontSize: 11 }}
        value={(draft.attachments ?? []).join("\n")}
        onChange={(e) => set("attachments", e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))}
        placeholder="/path/to/file"
        spellCheck={false}
      />
      {(saveError || error) && <div style={{ color: "#f87171", fontSize: 11, marginTop: 6 }}>{saveError ?? error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        {isCreating ? (
          <button type="button" style={btnPrimary} disabled={saving || !draft.name.trim() || !boardId} onClick={() => void handleCreate()}>
            {saving ? "创建中…" : "创建任务卡"}
          </button>
        ) : (
          <button type="button" style={btnPrimary} disabled={saving || !draft.name.trim()} onClick={() => void handleSave()}>
            {saving ? "保存中…" : "保存"}
          </button>
        )}
        <button type="button" style={btnGhost} onClick={() => { editor.updateShape<TaskCardShape>({ id: shape.id, type: "task-card", props: expanded ? { expanded: false, w: FORM_W } : { expanded: true, w: EXPANDED_W, h: EXPANDED_H } }); }}>
          {expanded ? "收起工作台" : "展开工作台"}
        </button>
      </div>
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
      style={{ width: w, height: h, pointerEvents: "none" }}
    >
      <div
        ref={rootRef}
        style={{
          width: w,
          height: h,
          borderRadius: "var(--bubble-radius, 12px)",
          border: "1px solid var(--bubble-border)",
          background: "var(--assistant-card-glass)",
          backdropFilter: "blur(var(--glass-blur-bubble)) saturate(var(--glass-saturate))",
          WebkitBackdropFilter: "blur(var(--glass-blur-bubble)) saturate(var(--glass-saturate))",
          boxShadow: "0 2px 10px -6px rgba(0,0,0,0.2)",
          color: "var(--text)",
          display: "flex",
          overflow: "hidden",
          pointerEvents: "all",
          userSelect: "none",
        }}
        onPointerDown={(e) => { if (e.button === 0 && isActive()) e.stopPropagation(); }}
        onPointerUp={(e) => { if (e.button === 0 && isActive()) e.stopPropagation(); }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {/* 左：编辑表单 / 建卡向导（常驻） */}
        <div style={{ width: 340, flexShrink: 0, borderRight: expanded ? "1px solid var(--bubble-hairline)" : "none", overflowY: "auto", padding: "10px 12px" }}>
          {formBody}
        </div>
        {/* 右：执行会话工作台 / 空态（expanded 才显示） */}
        {expanded && (
        <div style={{ flex: 1, minWidth: 0, borderLeft: "1px solid var(--bubble-hairline)", position: "relative" }}>
          {sessionId ? (
            <SessionWorkbench sessionId={sessionId} />
          ) : (
            <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--text-dim)", fontSize: 12 }}>
              {isCreating ? (
                <>
                  <div>填写左侧信息创建任务卡</div>
                  <div style={{ fontSize: 10 }}>创建后调度器将自动派发执行（就绪=待办时）</div>
                </>
              ) : (
                <>
                  <div>尚未派发执行</div>
                  <div style={{ fontSize: 10 }}>
                    {detail?.card.execStatus === "not_started" ? "就绪=待办后调度器自动派发" : `执行状态：${EXEC_BADGE[detail?.card.execStatus ?? "not_started"].label}`}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        )}
      </div>
    </HTMLContainer>
  );
}

const btnPrimary: React.CSSProperties = {
  border: "none",
  background: "var(--accent)",
  color: "var(--accent-contrast, #fff)",
  borderRadius: 6,
  padding: "5px 14px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  opacity: 1,
};

const btnGhost: React.CSSProperties = {
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-muted)",
  borderRadius: 6,
  padding: "5px 14px",
  fontSize: 12,
  cursor: "pointer",
};

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
