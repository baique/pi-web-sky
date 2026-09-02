"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NodeProps } from "@xyflow/react";
import ReactMarkdown from "react-markdown";
import { HIGHLIGHT_SHADOW, useBoardSearch } from "@/components/canvas/BoardSearchContext";
import { CardKindBadge } from "@/components/canvas/CardKindBadge";
import { useCardGlass } from "@/hooks/useCardGlass";
import { useBoardCanvasOps } from "./BoardCanvasContext";
import { useNodePosition } from "./nodePosition";

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

export function StickyNoteNode({ id, data, selected, width, height }: NodeProps & { data: StickyNoteData }) {
  const { updateNode, deleteNode } = useBoardCanvasOps();
  const { highlightId } = useBoardSearch();
  const isHighlighted = highlightId === id;
  const w = width ?? 338;
  const h = height ?? 230;
  const text = data.text ?? "";
  const badge = data.badge ?? "blue";

  // 玻璃（局部贴图）：从 RF store 读节点 position
  const position = useNodePosition(id);
  const { setContainer, setNode } = useCardGlass("var(--assistant-card-glass)");
  useEffect(() => { setNode(position ? { id, position, data, type: "sticky-note", style: { width: w, height: h } } as never : null); /* eslint-disable-line */ });

  // 本地编辑态（RF 无 tldraw editing 概念）
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [draftBadge, setDraftBadge] = useState(badge);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
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
    border: isHighlighted ? "2px solid var(--accent)" : selected ? "1.5px solid var(--accent)" : "1px solid var(--bubble-border)",
    background: "transparent",
    boxShadow: isHighlighted ? HIGHLIGHT_SHADOW : "0 2px 10px -6px rgba(0,0,0,0.2)",
    animation: isHighlighted ? "board-search-glow 1.8s ease-out forwards" : undefined,
    color: "var(--text)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    fontSize: 13,
    lineHeight: 1.5,
    userSelect: "none",
  };

  // 非编辑态内容交互：阻止事件冒泡到 RF（避免触发节点拖动/画布平移）
  const isolateContent = useCallback((e: React.PointerEvent) => { if (e.button === 0) e.stopPropagation(); }, []);

  return (
    <div
      ref={setContainer}
      data-board-node
      data-testid={`sticky-note-${id}`}
      style={bubbleStyle}
      className="nodrag nowheel"
      onDoubleClick={(e) => { e.stopPropagation(); setIsEditing(true); }}
    >
      {/* 顶部拖拽把手：不拦 pointer（让 RF 拖动节点）；按钮独立接收点击 */}
      <div style={{ flexShrink: 0, height: 32, display: "flex", alignItems: "center", gap: 6, padding: "0 var(--bubble-pad-x, 12px)", fontSize: 10, color: "var(--text-muted)", cursor: "grab", boxSizing: "border-box" }}>
        <CardKindBadge kind="note" color={BADGE_COLORS[badge] ?? BADGE_COLORS.blue} />
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>{formatNoteTime(createdAt)}</span>
        <button
          type="button"
          title={copied ? "已复制" : "复制内容"}
          onClick={copyContent}
          style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 20, padding: 0, border: "none", borderRadius: 5, background: "transparent", color: copied ? "var(--accent)" : "var(--text-dim)", cursor: "pointer" }}
        >
          {copied ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
          )}
        </button>
      </div>

      {isEditing ? (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          {/* 编辑态：徽记选择 + 取消/完成 */}
          <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "0 var(--bubble-pad-x, 12px)", height: 26, flexShrink: 0 }}>
            {Object.entries(BADGE_COLORS).map(([key, color]) => (
              <button
                key={key}
                type="button"
                title={`徽记·${BADGE_NAMES[key] ?? key}`}
                onClick={(e) => { e.stopPropagation(); setDraftBadge(key); }}
                style={{ width: 14, height: 14, padding: 0, border: "none", borderRadius: "50%", background: color, cursor: "pointer", boxShadow: draftBadge === key ? `0 0 0 2px var(--bg-panel), 0 0 0 3.5px ${color}` : `0 0 0 1px color-mix(in srgb, ${color} 45%, transparent)`, opacity: draftBadge === key ? 1 : 0.72 }}
              />
            ))}
            <div style={{ flex: 1 }} />
            <button type="button" onClick={cancel} style={footerBtnStyle} title="放弃变更 (Esc)">取消</button>
            <button type="button" onClick={finish} style={footerBtnStyle} title="完成 (Ctrl+Enter)">完成</button>
          </div>
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
            placeholder="Markdown 便笺…"
            className="sticky-note-input"
            style={{ flex: 1, minHeight: 0, resize: "none", border: "none", outline: "none", background: "transparent", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 14, lineHeight: 1.7, padding: "var(--bubble-pad-y, 8px) var(--bubble-pad-x, 12px)" }}
          />
        </div>
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
