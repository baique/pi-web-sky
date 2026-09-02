"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NodeResizer, Handle, Position, type NodeProps } from "@xyflow/react";
import type { ExecStatus, ReadyStatus, TaskCard } from "@/lib/task-card-store";
import { linkTargetIds, useTaskCard } from "@/hooks/useTaskCards";
import { ThemedSelect } from "@/components/canvas/ThemedSelect";
import { useCardGlass } from "@/hooks/useCardGlass";
import { TaskCardMultiSelect } from "@/components/canvas/TaskCardMultiSelect";
import { CardKindBadge } from "@/components/canvas/CardKindBadge";
import { DirectoryPicker } from "@/components/DirectoryPicker";
import { WorktreePicker } from "@/components/canvas/WorktreePicker";
import { useBoardCanvasOps } from "./BoardCanvasContext";
import { useBoardId, useBoardDefaultCwd } from "./BoardIdContext";
import { memoBoardNode } from "./memoNode";

/**
 * 任务卡（RF 节点版，替代 tldraw task-card shape）。
 * - 常态（表单栏常驻）：编辑表单（空卡=建卡向导），宽 380
 * - 展开：纯表单加宽，宽 760（双击切换）
 * - 业务字段真相源在 task_cards 表，shape 的 data 是展示 + 草稿镜像
 * - exec/依赖线由后端 reconcile 派生（本组件不管）
 */

export interface TaskCardData extends Record<string, unknown> {
  cardId: string;
  number: number;
  name: string;
  description: string;
  readyStatus: ReadyStatus;
  execStatus: ExecStatus;
  priority: number;
  due?: number | null;
  expanded: boolean;
  w: number;
  h: number;
  expandedW: number;
  expandedH: number;
  collapsedW: number;
  collapsedH: number;
}

/** 就绪状态徽章配色 */
export const READY_BADGE: Record<ReadyStatus, { color: string; label: string }> = {
  draft: { color: "#9ca3af", label: "草稿" },
  todo: { color: "#3184f8", label: "待办" },
};

/** 执行状态徽章配色 */
export const EXEC_BADGE: Record<ExecStatus, { color: string; label: string }> = {
  not_started: { color: "#9ca3af", label: "未开始" },
  running: { color: "#10b981", label: "进行中" },
  review: { color: "#f59e0b", label: "待审核" },
  done: { color: "#10b981", label: "完成" },
  failed: { color: "#ef4444", label: "失败" },
  abandoned: { color: "#9ca3af", label: "放弃" },
  waiting_reply: { color: "#3184f8", label: "等回复" },
};

/** 常态 = 编辑表单栏；展开 = 纯表单加宽 */
const FORM_W = 380;
const FORM_H = 270;
const EXPANDED_W = 760;
/** 展开态默认高 = 旧版 600 + 20px 余量（用户指定） */
const EXPANDED_H = 620;
const COLLAPSED_MIN_H = 240;

function TaskCardNodeImpl({ id, data, selected, width, height }: NodeProps & { data: TaskCardData }) {
  const { updateNode, deleteNode, normalizeNodeId } = useBoardCanvasOps();
  const w = width ?? data.w ?? FORM_W;
  const h = height ?? data.h ?? FORM_H;
  const expanded = Boolean(data.expanded);
  const { cardId } = data;
  const boardId = useBoardId();
  const defaultCwd = useBoardDefaultCwd();

  // 任务卡详情（表单真相源 + 执行会话 sessionId）
  const { detail, candidates, loading, error, reload, createCard, saveCard } = useTaskCard(cardId || null, boardId);

  // 玻璃
  const { setContainer } = useCardGlass("var(--assistant-card-glass)");

  const isCreating = !cardId;
  const sessionId = detail?.card.sessionId ?? null;

  // 展开即时：重新拉详情
  useEffect(() => {
    if (expanded && !isCreating) void reload();
  }, [expanded, isCreating, reload]);

  // 表单草稿（受控）。空卡=默认草稿（从 data 恢复）
  const [draft, setDraft] = useState<TaskCard | null>(() =>
    isCreating
      ? {
          id: "",
          boardId: "",
          projectKey: "",
          number: 0,
          name: data.name === "新建任务" ? "" : data.name,
          description: data.description ?? "",
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
          dispatchToken: null,
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
    if (detail && !depsInitializedRef.current) {
      depsInitializedRef.current = true;
      setDraftPrereq(linkTargetIds(detail.links, "prerequisite"));
      setDraftRelated(linkTargetIds(detail.links, "related"));
    }
  }, [detail]);

  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => { setAdvancedOpen(expanded); }, [expanded]);

  const [dirPickerOpen, setDirPickerOpen] = useState(false);
  const [wtPath, setWtPath] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);

  // 编辑实时写回节点 data（CRDT 广播到多端 + 持久化）
  const set = <K extends keyof TaskCard>(key: K, value: TaskCard[K]) => {
    setDraft((d) => {
      const next = d ? { ...d, [key]: value } : d;
      if (next && (key === "name" || key === "description")) {
        updateNode(id, { data: { ...data, name: key === "name" ? (value as string) : next.name, description: key === "description" ? (value as string) : next.description ?? "" } });
      }
      return next;
    });
  };

  // 建卡向导提交（空卡）→ 派发：建卡即转待办
  const handleCreate = async () => {
    if (!boardId) { setSaveError("缺少看板上下文，无法创建"); return; }
    if (!draft?.name.trim()) { setNameError("请填写任务名称"); return; }
    if (savingRef.current) return;
    setSaving(true);
    savingRef.current = true;
    setSaveError(null);
    const created = await createCard({
      boardId,
      name: draft.name,
      description: draft.description,
      readyStatus: "todo",
      priority: draft.priority,
      due: draft.due ?? null,
      cwd: draft.cwd ?? undefined,
      useWorktree: draft.useWorktree,
      maxRetries: draft.maxRetries,
      attachments: draft.attachments,
      prerequisites: draftPrereq,
      related: draftRelated,
    });
    savingRef.current = false;
    setSaving(false);
    if (created) {
      // 规范化节点 id：随机 UUID → task-<cardId>（与服务端 reconcile 的确定性 id 一致，避免重复卡）。
      // 必须先改 id 再落 cardId，否则 reconcile 已按 task-<cardId> 补卡时两者并存。
      const newId = `task-${created.id}`;
      normalizeNodeId(id, newId);
      updateNode(newId, { data: { ...data, cardId: created.id, number: created.number, name: created.name, readyStatus: created.readyStatus, execStatus: created.execStatus, priority: created.priority, due: created.due ?? undefined } });
      setDraft((d) => (d ? { ...d, ...created, sessionId: created.sessionId } : d));
      void reload();
    }
  };

  // 编辑保存（已建卡）
  const handleSave = async () => {
    if (!draft?.name.trim()) { setNameError("请填写任务名称"); return; }
    if (savingRef.current) return;
    setSaving(true);
    savingRef.current = true;
    setSaveError(null);
    const ok = await saveCard({
      name: draft.name,
      description: draft.description,
      readyStatus: draft.readyStatus,
      priority: draft.priority,
      due: draft.due ?? null,
      attachments: draft.attachments,
      cwd: draft.cwd ?? null,
      useWorktree: draft.useWorktree,
      maxRetries: draft.maxRetries,
      prerequisites: draftPrereq,
      related: draftRelated,
    });
    savingRef.current = false;
    setSaving(false);
    if (ok) {
      updateNode(id, { data: { ...data, name: draft.name, description: draft.description ?? "", readyStatus: draft.readyStatus, priority: draft.priority, due: draft.due ?? undefined } });
    } else {
      setSaveError(error ?? "保存失败");
    }
  };

  // 就绪状态即时生效
  const handleReadyChange = (v: string) => {
    set("readyStatus", v as ReadyStatus);
    if (!isCreating && cardId) void saveCard({ readyStatus: v as ReadyStatus });
  };

  // dirty 判定
  const isDirty = useMemo(() => {
    if (isCreating || !detail?.card || !draft) return false;
    const c = detail.card;
    return (
      draft.name !== c.name || draft.description !== c.description || draft.priority !== c.priority ||
      draft.due !== c.due || draft.cwd !== c.cwd || draft.useWorktree !== c.useWorktree ||
      draft.maxRetries !== c.maxRetries ||
      JSON.stringify(draft.attachments ?? []) !== JSON.stringify(c.attachments ?? []) ||
      JSON.stringify([...draftPrereq].sort()) !== JSON.stringify(linkTargetIds(detail.links, "prerequisite").sort()) ||
      JSON.stringify([...draftRelated].sort()) !== JSON.stringify(linkTargetIds(detail.links, "related").sort())
    );
  }, [isCreating, detail, draft, draftPrereq, draftRelated]);

  // 取消：撤销未保存编辑
  const handleCancelEdit = () => {
    if (!detail) return;
    setDraft({ ...detail.card });
    setDraftPrereq(linkTargetIds(detail.links, "prerequisite"));
    setDraftRelated(linkTargetIds(detail.links, "related"));
    setWtPath(null);
    setSaveError(null);
    setNameError(null);
  };

  // 离开节点自动保存（选中 → 未选中且 dirty）
  const wasSelectedRef = useRef(selected);
  const dirtyRef = useRef(isDirty);
  dirtyRef.current = isDirty;
  useEffect(() => {
    const was = wasSelectedRef.current;
    wasSelectedRef.current = selected;
    if (was && !selected && !isCreating && dirtyRef.current) {
      void handleSave();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, isCreating]);

  // 双击切换展开/收合（展开尺寸固定参考旧版：760×(600+20)，两态不记忆——
  // resize 曾长期失效导致记忆字段全是脏值（380×240 被记成展开尺寸），不可信）
  const toggleExpand = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (expanded) {
      updateNode(id, {
        data: {
          ...data,
          expanded: false,
          expandedW: EXPANDED_W, expandedH: EXPANDED_H,
          w: FORM_W, h: FORM_H,
          collapsedW: FORM_W, collapsedH: FORM_H,
        },
        // 尺寸三处对齐：顶层 width/height（NodeResizer 拖过会残留，RF 优先读它）
        // + style（RF 备选）+ data.w/h（镜像）。只改 style 会被顶层残留值屏蔽。
        width: FORM_W,
        height: FORM_H,
        style: { width: FORM_W, height: FORM_H },
      });
    } else {
      updateNode(id, {
        data: {
          ...data,
          expanded: true,
          expandedW: EXPANDED_W, expandedH: EXPANDED_H,
          w: EXPANDED_W, h: EXPANDED_H,
          collapsedW: FORM_W, collapsedH: FORM_H,
        },
        width: EXPANDED_W,
        height: EXPANDED_H,
        style: { width: EXPANDED_W, height: EXPANDED_H },
      });
    }
  }, [id, data, expanded, updateNode]);

  const onResize = useCallback((_: unknown, params: { width: number; height: number }) => {
    updateNode(id, { data: { ...data, w: params.width, h: params.height } });
  }, [id, data, updateNode]);

  // exec 状态：轮询已写 data.execStatus（running 快照），直接读
  const execStatus = data.execStatus ?? detail?.card.execStatus ?? "not_started";

  const formBody = draft ? (
    <>
      <label style={LABEL_STYLE}>任务名称 *</label>
      <input
        style={{ ...FIELD_STYLE, ...(nameError ? { borderColor: "#f87171", boxShadow: "0 0 0 1px #f87171" } : {}) }}
        value={draft.name}
        onChange={(e) => { set("name", e.target.value); if (nameError) setNameError(null); }}
        placeholder="任务名称"
      />
      {nameError && <div style={{ color: "#f87171", fontSize: 11, marginTop: 3 }}>{nameError}</div>}
      <label style={LABEL_STYLE}>需求说明</label>
      <textarea
        style={{ ...FIELD_STYLE, flex: 1, minHeight: 70, resize: "none", fontFamily: "var(--font-mono)", fontSize: 11 }}
        value={draft.description}
        onChange={(e) => set("description", e.target.value)}
        placeholder="任务描述"
        spellCheck={false}
      />
      <CollapsibleSection title="高级" open={advancedOpen} onToggle={() => setAdvancedOpen((v) => !v)}>
        <label style={LABEL_STYLE}>工作目录</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input style={{ ...FIELD_STYLE, flex: 1 }} value={draft.cwd ?? ""} onChange={(e) => set("cwd", e.target.value || null)} placeholder="默认项目根目录" readOnly />
          <button type="button" style={footerBtnStyle} onClick={() => setDirPickerOpen(true)}>选择目录</button>
        </div>
        {dirPickerOpen && draft && (
          <DirectoryPicker onCancel={() => setDirPickerOpen(false)} onSelect={(path) => { set("cwd", path); setDirPickerOpen(false); }} />
        )}
        <label style={LABEL_STYLE}>工作区</label>
        <WorktreePicker cwd={draft.cwd} value={wtPath} onChange={(p) => { setWtPath(p); set("cwd", p); }} />
        <label style={LABEL_STYLE}>预计截止</label>
        <DuePicker due={draft.due ?? null} onChange={(ms) => set("due", ms)} />
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={LABEL_STYLE}>优先级</label>
            <ThemedSelect value={String(draft.priority)} onChange={(v) => set("priority", Number(v))} options={[{ value: "1", label: "高" }, { value: "0", label: "中" }, { value: "-1", label: "低" }]} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={LABEL_STYLE}>最大重试次数</label>
            <input style={FIELD_STYLE} type="number" min={0} value={draft.maxRetries} onChange={(e) => set("maxRetries", Math.max(0, Number(e.target.value) || 0))} />
          </div>
        </div>
        <label style={LABEL_STYLE}>前置任务（可多选）</label>
        <TaskCardMultiSelect candidates={candidates} selected={draftPrereq} onChange={setDraftPrereq} excludeId={cardId} placeholder="本看板内选择前置任务…" />
        <label style={LABEL_STYLE}>关联任务（可多选）</label>
        <TaskCardMultiSelect candidates={candidates} selected={draftRelated} onChange={setDraftRelated} excludeId={cardId} placeholder="本看板内选择关联任务…" />
        <label style={LABEL_STYLE}>附件（引用文件路径，每行一个）</label>
        <textarea style={{ ...FIELD_STYLE, minHeight: 46, resize: "vertical", fontFamily: "var(--font-mono)", fontSize: 11 }} value={(draft.attachments ?? []).join("\n")} onChange={(e) => set("attachments", e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))} placeholder="/path/to/file" spellCheck={false} />
      </CollapsibleSection>
      {(saveError || error) && <div style={{ color: "#f87171", fontSize: 11, marginTop: 6 }}>{saveError ?? error}</div>}
    </>
  ) : loading ? (
    <div style={{ color: "var(--text-dim)", fontSize: 12, padding: 20, textAlign: "center" }}>加载中…</div>
  ) : (
    <div style={{ color: "var(--text-dim)", fontSize: 12, padding: 20, textAlign: "center" }}>未找到任务卡</div>
  );

  return (
    <>
      {/* resize 手柄 + 连线 Handle 挂在卡根外（RF wrapper 直接子级）：
          卡根 overflow:hidden 会裁掉外扩的 resize 角柄 → 点击落到卡根变成拖卡，
          resize 永远无法触发。放外面后手柄可正常外扩/命中。
          直线隐藏（四边直线无法圆角）：选中态边线由卡根圆角 accent 边框呈现。 */}
      <NodeResizer isVisible={selected} minWidth={expanded ? 480 : FORM_W} minHeight={expanded ? 400 : COLLAPSED_MIN_H} onResize={onResize} keepAspectRatio={false} />
      <Handle type="target" position={Position.Left} className="board-handle" style={{ background: "var(--text-dim)", width: 8, height: 8, border: "1px solid var(--bg-panel)", opacity: 0.85 }} />
      <Handle type="source" position={Position.Right} className="board-handle" style={{ background: "var(--text-dim)", width: 8, height: 8, border: "1px solid var(--bg-panel)", opacity: 0.85 }} />
      <div
        ref={(node) => { rootRef.current = node; setContainer(node); }}
        data-board-node
        data-testid={`task-card-${id}`}
        // 根可拖（RF 默认）：标题栏即拖拽把手；内容区（表单）与交互控件各自 nodrag 隔离，
        // 双击（展开/收合）由 RF wrapper 的 dblclick 触发，不依赖根 nodrag。
        onDoubleClick={toggleExpand}
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          borderRadius: "var(--bubble-radius, 12px)",
          border: "1px solid var(--bubble-border)",
          background: "transparent",
          // 选中态：外圈描边用 box-shadow（带 5px 间距、不占布局→不压缩内容区）。边框保持固定 1px。
          boxShadow: selected
            ? "0 2px 10px -6px rgba(0,0,0,0.2), 0 0 0 5px transparent, 0 0 16px 5px color-mix(in srgb, var(--accent) 28%, transparent)"
            : "0 2px 10px -6px rgba(0,0,0,0.2)",
          color: "var(--text)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          userSelect: "none",
          // 统一预留内边距：连线 Handle 呼吸空间 + 贴边按下可拖拽移动（RF 可拖区）+ 内容与 resize 边界留间距
          padding: 6,
        }}
      >
      {/* 拖拽把手：不拦 pointer（RF 拖动节点）；右上角操作按钮 nodrag 独立点击 */}
      <div style={{ flexShrink: 0, height: 36, display: "flex", alignItems: "center", gap: 6, padding: "0 10px", borderBottom: "1px solid var(--bubble-hairline)", cursor: "grab", fontSize: 11, color: "var(--text-muted)" }}>
        <span title={`执行状态：${(EXEC_BADGE[execStatus] ?? EXEC_BADGE.not_started).label}`} style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          <CardKindBadge kind="task" color={(EXEC_BADGE[execStatus] ?? EXEC_BADGE.not_started).color} />
        </span>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>
          {draft?.name || (isCreating ? "新建任务卡" : "任务卡")}
        </span>
        {draft?.number ? <span style={{ flexShrink: 0, fontSize: 12.5, fontWeight: 600, color: "var(--text)", marginLeft: 4 }}>#{draft.number}</span> : null}
        <div className="nodrag" style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }} onPointerDown={(e) => e.stopPropagation()}>
          {isCreating ? (
            <button type="button" style={footerBtnStyle} disabled={saving || !boardId} onClick={() => void handleCreate()} title="创建任务并派发（转待办，调度器可执行）">
              {saving ? "创建中…" : "派发"}
            </button>
          ) : draft?.readyStatus === "draft" ? (
            <button type="button" style={footerBtnStyle} disabled={saving} onClick={() => handleReadyChange("todo")} title="派发（转待办，调度器可执行）">
              {saving ? "派发中…" : "派发"}
            </button>
          ) : draft?.readyStatus === "todo" ? (
            <span title={`执行状态：${(EXEC_BADGE[execStatus] ?? EXEC_BADGE.not_started).label}`} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: (EXEC_BADGE[execStatus] ?? EXEC_BADGE.not_started).color, whiteSpace: "nowrap" }}>
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: (EXEC_BADGE[execStatus] ?? EXEC_BADGE.not_started).color, ...(execStatus === "running" ? { animation: "pulse-dot 1.6s ease-in-out infinite" } : {}) }} />
              {(EXEC_BADGE[execStatus] ?? EXEC_BADGE.not_started).label}
            </span>
          ) : null}
          {isCreating ? null : isDirty ? (
            <>
              <button type="button" style={footerBtnStyle} onClick={handleCancelEdit} title="撤销本次编辑">取消</button>
              <button type="button" style={footerBtnStyle} disabled={saving} onClick={() => void handleSave()} title="完成（保存）">{saving ? "保存中…" : "完成"}</button>
            </>
          ) : null}
        </div>
      </div>
      {/* 内容区：编辑表单 */}
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div className="[scrollbar-width:none] nodrag nowheel" style={{ flex: "1 1 auto", minWidth: 0, overflowY: "auto", padding: "10px 12px", display: "flex", flexDirection: "column" }}>
          {formBody}
        </div>
      </div>
      </div>
    </>
  );
}

/** 看板 id（从 BoardIdContext 读取，SessionCanvas 提供） */

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
  color: "var(--text)",
  fontWeight: 600,
  margin: "8px 0 3px",
};

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

function CollapsibleSection({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div>
      <button type="button" onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 4, width: "100%", marginTop: 10, padding: "5px 0 3px", border: "none", borderTop: "1px solid var(--bubble-hairline)", background: "transparent", color: "var(--text-muted)", fontSize: 11, fontWeight: 600, cursor: "pointer", textAlign: "left" }}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.12s" }}>
          <polyline points="3 2 6.5 5 3 8" />
        </svg>
        {title}
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

/** 预计截止：年/月/日 三下拉联动 */
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

/** memo 化导出：忽略拖拽/位置类 props 每帧变化，避免拖拽时整卡重渲染 */
export const TaskCardNode = memoBoardNode(TaskCardNodeImpl);
