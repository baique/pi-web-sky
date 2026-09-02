"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { NodeResizer, Handle, Position, type NodeProps } from "@xyflow/react";
import ReactMarkdown from "react-markdown";
import { HIGHLIGHT_SHADOW, useBoardSearch } from "@/components/canvas/BoardSearchContext";
import { CardKindBadge } from "@/components/canvas/CardKindBadge";
import { useCardGlass } from "@/hooks/useCardGlass";
import { useBoardCanvasOps } from "./BoardCanvasContext";
import { memoBoardNode } from "./memoNode";

/**
 * 自研 markdown 便笺（RF 节点版，替代 tldraw sticky-note shape）。
 * 观感 = AI 消息气泡同款毛玻璃（复用 --bubble-* / --assistant-card-glass token）。
 * - 双击进入编辑：textarea 写 markdown 源码
 * - 非编辑态：react-markdown 渲染，左上角对齐
 * - 缩放由 RF 节点（NodeResizer）控制
 * - 内部滚动用 nowheel class（RF 原生隔离，不缩放画布）
 */

export interface StickyNoteData extends Record<string, unknown> {
  text: string;
  /** 徽记颜色：blue | green | red | yellow | purple */
  badge?: string;
  /** 新建时间（ms epoch） */
  createdAt?: number;
}

/** 徽记可选色（固定色，不随主题） */
export const BADGE_COLORS: Record<string, string> = {
  blue: "#3184f8",
  green: "#10b981",
  red: "#ef4444",
  yellow: "#f59e0b",
  purple: "#8b5cf6",
};

export const BADGE_NAMES: Record<string, string> = {
  blue: "蓝",
  green: "绿",
  red: "红",
  yellow: "黄",
  purple: "紫",
};

function StickyNoteNodeImpl({ id, data, selected, width, height }: NodeProps & { data: StickyNoteData }) {
  const { updateNode, deleteNode } = useBoardCanvasOps();
  const { highlightId } = useBoardSearch();
  const isHighlighted = highlightId === id;
  const w = width ?? 338;
  const h = height ?? 230;
  const text = data.text ?? "";
  const badge = data.badge ?? "blue";

  // 玻璃（局部贴图）：从 RF store 读节点 position
  const { setContainer } = useCardGlass("var(--assistant-card-glass)");

  // 本地编辑态（RF 无 tldraw editing 概念）
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [draftBadge, setDraftBadge] = useState(badge);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // 旧便笺无 createdAt 时兜底（惰性初始化，不 render 期 Date.now）
  const [createdAt] = useState(() => data.createdAt ?? Date.now());
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 进入编辑同步草稿；外部 text 变化时重置
  useEffect(() => {
    if (isEditing) {
      setDraft(text);
      setDraftBadge(badge);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [isEditing, text, badge]);

  const save = useCallback(() => {
    if (draft !== text || draftBadge !== badge) {
      updateNode(id, { data: { ...data, text: draft, badge: draftBadge } });
    }
  }, [draft, draftBadge, text, badge, updateNode, id, data]);

  const finish = useCallback(() => {
    save();
    setIsEditing(false);
  }, [save]);

  const cancel = useCallback(() => {
    setDraft(text);
    setDraftBadge(badge);
    setIsEditing(false);
  }, [text, badge]);

  // 失焦自动保存：textarea 失去焦点且焦点不在本卡内 → 保存并退出编辑。
  // （点画布空白/点别的节点/切走应用 → 等价 tldraw 点别处退出编辑自动保存）
  const handleTextareaBlur = useCallback((e: React.FocusEvent<HTMLTextAreaElement>) => {
    const next = e.relatedTarget;
    const root = rootRef.current;
    // 焦点仍在卡内（点徽记/取消/完成等按钮，它们可聚焦且 onMouseDown 已 preventDefault）→ 保持编辑
    if (root && next instanceof Node && root.contains(next)) return;
    // 焦点移出卡片：自动保存退出
    save();
    setIsEditing(false);
  }, [save]);

  // 编辑态下点击取消/完成按钮时，阻止 mousedown 把焦点从 textarea 移走，
  // 避免误触发 blur 自动保存；按钮 onClick 仍正常触发取消/完成。
  const keepTextareaFocus = useCallback((e: React.MouseEvent) => { e.preventDefault(); }, []);

  const copyContent = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const rendered = contentRef.current?.querySelector<HTMLElement>(".markdown-body")?.innerText ?? text;
      void navigator.clipboard.writeText(rendered).then(() => {
        setCopied(true);
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => setCopied(false), 1200);
      }).catch(() => { /* ignore */ });
    },
    [text],
  );

  useEffect(() => () => { if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current); }, []);

  const bubbleStyle: React.CSSProperties = {
    position: "relative",
    width: "100%",
    height: "100%",
    borderRadius: "var(--bubble-radius, 12px)",
    border: isHighlighted ? "2px solid var(--accent)" : "1px solid var(--bubble-border)",
    background: "transparent",
    // 选中态：外圈描边用 box-shadow（带 5px 间距、不占布局→不压缩内容区）。边框保持固定 1px。
    boxShadow: isHighlighted
      ? HIGHLIGHT_SHADOW
      : selected
        ? "0 2px 10px -6px rgba(0,0,0,0.2), 0 0 0 5px transparent, 0 0 0 6px color-mix(in srgb, var(--accent) 55%, transparent)"
        : "0 2px 10px -6px rgba(0,0,0,0.2)",
    animation: isHighlighted ? "board-search-glow 1.8s ease-out forwards" : undefined,
    color: "var(--text)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    fontSize: 13,
    lineHeight: 1.5,
    userSelect: "none",
    // 统一预留内边距：连线 Handle 呼吸空间 + 贴边按下可拖拽移动（RF 可拖区）+ 内容与 resize 边界留间距
    padding: 6,
  };

  // 非编辑态内容交互：阻止事件冒泡到 RF（避免触发节点拖动/画布平移）
  const isolateContent = useCallback((e: React.PointerEvent) => { if (e.button === 0) e.stopPropagation(); }, []);

  // resize：写回 style + data.w/h（NodeResizer 已改 style，这里同步 data）
  const onResize = useCallback((_: unknown, params: { width: number; height: number }) => {
    updateNode(id, { data: { ...data, w: params.width, h: params.height } });
  }, [id, data, updateNode]);

  return (
    <>
      {/* resize 手柄 + 连线 Handle 挂在卡根外（RF wrapper 直接子级）：
          卡根 overflow:hidden 会裁掉外扩的 resize 角柄 → 点击落到卡根变成拖卡，
          resize 永远无法触发。放外面后手柄可正常外扩/命中。
          直线隐藏（四边直线无法圆角）：选中态边线由卡根圆角 accent 边框呈现。 */}
      <NodeResizer
        isVisible={selected}
        minWidth={120}
        minHeight={60}
        onResize={onResize}
        keepAspectRatio={false}
      />
      <Handle type="target" position={Position.Left} className="board-handle" style={{ background: "var(--text-dim)", width: 8, height: 8, border: "1px solid var(--bg-panel)", opacity: 0.85 }} />
      <Handle type="source" position={Position.Right} className="board-handle" style={{ background: "var(--text-dim)", width: 8, height: 8, border: "1px solid var(--bg-panel)", opacity: 0.85 }} />
    <div
      ref={(el) => { setContainer(el); rootRef.current = el; }}
      data-board-node
      data-testid={`sticky-note-${id}`}
      style={bubbleStyle}
      // 根可拖（RF 默认）：顶部把手行即拖拽把手；内容区/编辑控件各自 nodrag 隔离。
      // 原地双击（不移动）不启动拖动，dblclick 正常触发进入编辑。
      className="nowheel"
      onDoubleClick={(e) => { e.stopPropagation(); setIsEditing(true); }}
    >
      {/* 顶部把手行（始终一行、高度固定 32——编辑/预览切换顶部不跳动）：
          预览态 = 徽记 + 时间戳 + 复制，整条是拖拽区（不拦 pointer → RF 拖动节点）；
          编辑态 = 徽记（草稿色）+ 5 色徽记选择 + 取消/完成，整行 nodrag 不可拖（空区也不误拖） */}
      <div
        className={isEditing ? "nodrag" : ""}
        style={{ flexShrink: 0, height: 32, display: "flex", alignItems: "center", gap: 6, padding: "0 var(--bubble-pad-x, 12px)", fontSize: 10, color: "var(--text-muted)", cursor: isEditing ? "default" : "grab", boxSizing: "border-box" }}
      >
        <CardKindBadge kind="note" color={BADGE_COLORS[isEditing ? draftBadge : badge] ?? BADGE_COLORS.blue} />
        {isEditing ? (
          <>
            <div className="nodrag" style={{ display: "flex", alignItems: "center", gap: 5 }}>
              {Object.entries(BADGE_COLORS).map(([key, color]) => (
                <button
                  key={key}
                  type="button"
                  title={`徽记·${BADGE_NAMES[key] ?? key}`}
                  className="nodrag"
                  onClick={(e) => { e.stopPropagation(); setDraftBadge(key); }}
                  style={{ width: 14, height: 14, padding: 0, border: "none", borderRadius: "50%", background: color, cursor: "pointer", boxShadow: draftBadge === key ? `0 0 0 2px var(--bg-panel), 0 0 0 3.5px ${color}` : `0 0 0 1px color-mix(in srgb, ${color} 45%, transparent)`, opacity: draftBadge === key ? 1 : 0.72 }}
                />
              ))}
            </div>
            <div style={{ flex: 1 }} />
            <button type="button" className="nodrag" onMouseDown={keepTextareaFocus} onClick={cancel} style={footerBtnStyle} title="放弃变更 (Esc)">取消</button>
            <button type="button" className="nodrag" onMouseDown={keepTextareaFocus} onClick={finish} style={footerBtnStyle} title="完成 (Ctrl+Enter)">完成</button>
          </>
        ) : (
          <>
            <div style={{ flex: 1 }} />
            <span style={{ fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>{formatNoteTime(createdAt)}</span>
            <button
              type="button"
              title={copied ? "已复制" : "复制内容"}
              onClick={copyContent}
              className="nodrag"
              style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 20, padding: 0, border: "none", borderRadius: 5, background: "transparent", color: copied ? "var(--accent)" : "var(--text-dim)", cursor: "pointer" }}
            >
              {copied ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
              )}
            </button>
          </>
        )}
      </div>

      {isEditing ? (
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(); }
            else if (e.key === "Escape") { e.preventDefault(); cancel(); }
          }}
          spellCheck={false}
          onBlur={handleTextareaBlur}
          placeholder="Markdown 便笺…"
          className="sticky-note-input nodrag nowheel"
          style={{ flex: 1, minHeight: 0, resize: "none", border: "none", outline: "none", background: "transparent", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 14, lineHeight: 1.7, padding: "var(--bubble-pad-y, 8px) var(--bubble-pad-x, 12px)" }}
        />
      ) : (
        <div
          ref={contentRef}
          className="nowheel nodrag"
          style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px var(--bubble-pad-x, 12px) var(--bubble-pad-y, 8px)", textAlign: "left", cursor: "text" }}
          onPointerDown={isolateContent}
          onPointerUp={isolateContent}
          onDoubleClick={(e) => { e.stopPropagation(); setIsEditing(true); }}
        >
          {text.trim() ? (
            <div className="markdown-body" style={{ wordBreak: "break-word" }}>
              <ReactMarkdown>{text}</ReactMarkdown>
            </div>
          ) : (
            <div style={{ color: "var(--text-dim)", fontSize: 12, cursor: "text" }}>双击编辑 markdown</div>
          )}
        </div>
      )}
    </div>
    </>
  );
}

const footerBtnStyle: React.CSSProperties = {
  border: "none",
  background: "color-mix(in srgb, var(--border) 30%, transparent)",
  color: "var(--text-muted)",
  borderRadius: 5,
  padding: "2px 10px",
  fontSize: 11,
  cursor: "pointer",
};

/** 便笺时间：今天显示时:分，否则 月/日 */
function formatNoteTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** memo 化导出：忽略拖拽/位置类 props 每帧变化，避免拖拽时整卡重渲染 */
export const StickyNoteNode = memoBoardNode(StickyNoteNodeImpl);
