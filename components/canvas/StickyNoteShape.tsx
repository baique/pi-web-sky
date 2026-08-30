"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BaseBoxShapeUtil, HTMLContainer, T, resizeBox, useEditor, useValue } from "tldraw";
import type { TLBaseShape, TLShapePartial } from "tldraw";
import ReactMarkdown from "react-markdown";

/**
 * 自研 markdown 便笺（sticky-note）。
 * 观感 = AI 消息气泡同款毛玻璃（复用 --bubble-* / --assistant-card-glass token，黑白主题自适应）。
 * - 双击进入编辑：textarea 写 markdown 源码
 * - 非编辑态：react-markdown 渲染，左上角对齐
 * - w/h 自由缩放（BaseBoxShapeUtil + resizeBox）
 */

export interface StickyNoteProps {
  text: string;
  w: number;
  h: number;
  /** 徽记颜色：blue | green | red | yellow | purple，默认 blue */
  badge: string;
  /** 新建时间（ms epoch），新建自动记录 */
  createdAt: number;
}

export type StickyNoteShape = TLBaseShape<"sticky-note", StickyNoteProps>;

declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    "sticky-note": StickyNoteProps;
  }
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

export const stickyNoteProps = {
  text: T.string,
  w: T.number,
  h: T.number,
  // optional：兼容旧便笺（无 badge/createdAt 的存量数据），组件内兜底默认值
  badge: T.string.optional(),
  createdAt: T.number.optional(),
};

export class StickyNoteUtil extends BaseBoxShapeUtil<StickyNoteShape> {
  static override type = "sticky-note" as const;
  static override props = stickyNoteProps;

  override getDefaultProps(): StickyNoteShape["props"] {
    // 新建自动记录时间（badge 默认蓝）
    return { text: "", w: 260, h: 200, badge: "blue", createdAt: Date.now() };
  }

  override canEdit(): boolean {
    return true;
  }

  override canResize(): boolean {
    return true;
  }

  override hideRotateHandle(): boolean {
    return true;
  }

  override onResize(
    shape: StickyNoteShape,
    info: import("tldraw").TLResizeInfo<StickyNoteShape>,
  ): Omit<TLShapePartial<StickyNoteShape>, "id" | "type"> | undefined {
    return resizeBox(shape, info, { minWidth: 140, minHeight: 100 });
  }

  override getIndicatorPath(shape: StickyNoteShape) {
    const { w, h } = shape.props;
    const path = new Path2D();
    path.roundRect(0, 0, w, h, 12);
    return path;
  }

  override component(shape: StickyNoteShape) {
    return <StickyNoteView shape={shape} />;
  }
}

function StickyNoteView({ shape }: { shape: StickyNoteShape }) {
  const { w, h, text } = shape.props;
  const editor = useEditor();
  const isEditing = useValue("editing", () => editor.getEditingShapeId() === shape.id, [editor, shape.id]);

  // 内容区与画布手势隔离：
  // - pointer 事件不冒泡到 .tl-canvas，tldraw 不会把这里的手势当成形状拖拽；
  //   文本拖动 = 浏览器原生选字（CSS 已放行 user-select:text）。
  // - 但 tldraw 的 canvas 层事件（选中 / ClickManager 双击进编辑）也因此收不到，
  //   由本地 click / dblclick 补回（浏览器保证拖动后不派发 click，选中与拖拽天然互斥）。
  const isolateContent = useCallback(
    (e: React.PointerEvent) => e.stopPropagation(),
    [],
  );

  const handleContentClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      // 若已在编辑态（如刚双击），不打断 textarea 焦点
      if (editor.getEditingShapeId() === shape.id) return;
      editor.select(shape.id);
    },
    [editor, shape.id],
  );

  const handleContentDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      editor.setEditingShape(shape.id);
    },
    [editor, shape.id],
  );

  // 旧便笺无 createdAt 时兜底：用当前时间（仅展示，不写回避免噪声）
  const createdAt = shape.props.createdAt ?? Date.now();
  const badge = shape.props.badge ?? "blue";

  const [draft, setDraft] = useState(text);
  const draftRef = useRef(text);
  // 徽记同样进草稿：完成才写回，取消则放弃选择
  const [draftBadge, setDraftBadge] = useState(badge);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 取消时置 true：退出编辑的保存钩子跳过（放弃草稿）；finish 不置 → 正常保存
  const cancelRef = useRef(false);
  const wasEditingRef = useRef(false);

  // 进入编辑时同步草稿；非编辑且外部 text 变化时重置
  useEffect(() => {
    if (isEditing) {
      setDraft(text);
      draftRef.current = text;
      setDraftBadge(badge);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [isEditing, text, badge]);

  const save = useCallback(() => {
    const value = draftRef.current;
    if (value !== shape.props.text || draftBadge !== badge) {
      editor.updateShapes([{ id: shape.id, type: "sticky-note", props: { text: value, badge: draftBadge } }]);
    }
  }, [editor, shape.id, shape.props.text, badge, draftBadge]);

  // 自动保存：监听编辑态退出（tldraw 里点击画布空白退出时 textarea 先被卸载，
  // React 合成 onBlur 不触发，必须靠 isEditing true→false 这个时机保存）
  useEffect(() => {
    if (!isEditing && wasEditingRef.current && !cancelRef.current) {
      save();
    }
    cancelRef.current = false;
    wasEditingRef.current = isEditing;
  }, [isEditing, save]);

  const finish = useCallback(() => {
    editor.setEditingShape(null); // 退出时上面的钩子自动保存
  }, [editor]);

  // 取消：放弃草稿变更（text + badge），直接退出编辑
  const cancel = useCallback(() => {
    cancelRef.current = true;
    editor.setEditingShape(null);
  }, [editor]);

  // 消息气泡同款毛玻璃
  const bubbleStyle: React.CSSProperties = {
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
    flexDirection: "column",
    overflow: "hidden",
    fontSize: 13,
    lineHeight: 1.5,
    pointerEvents: "all",
    userSelect: "none",
  };

  // —— 编辑态：textarea 写 markdown 源码 ——
  if (isEditing) {
    return (
      <HTMLContainer data-testid={`sticky-note-${shape.id}`} style={{ width: w, height: h, pointerEvents: "none" }}>
        <div style={bubbleStyle}>
          {/* 顶部：徽记选择 + 取消/完成（按钮区置顶） */}
          <div
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px",
              borderBottom: "1px solid var(--bubble-hairline)",
            }}
          >
            {/* 徽记选择：5 色，默认蓝 */}
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              {Object.entries(BADGE_COLORS).map(([key, color]) => (
                <button
                  key={key}
                  type="button"
                  title={`徽记·${BADGE_NAMES[key] ?? key}`}
                  onClick={(e) => { e.stopPropagation(); setDraftBadge(key); }}
                  style={{
                    width: 14,
                    height: 14,
                    padding: 0,
                    border: "none",
                    borderRadius: "50%",
                    background: color,
                    cursor: "pointer",
                    boxShadow: draftBadge === key
                      ? `0 0 0 2px var(--bg-panel), 0 0 0 3.5px ${color}`
                      : `0 0 0 1px color-mix(in srgb, ${color} 45%, transparent)`,
                    opacity: draftBadge === key ? 1 : 0.72,
                  }}
                />
              ))}
            </div>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); cancel(); }}
              style={footerBtnStyle}
              title="放弃变更 (Esc)"
            >
              取消
            </button>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); finish(); }}
              style={footerBtnStyle}
              title="完成 (Ctrl+Enter)"
            >
              完成
            </button>
          </div>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); draftRef.current = e.target.value; }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(); }
              else if (e.key === "Escape") { e.preventDefault(); cancel(); }
            }}
            onPointerDown={(e) => e.stopPropagation()}
            spellCheck={false}
            placeholder="Markdown 便笺…"
            className="sticky-note-input"
            style={{
              flex: 1,
              minHeight: 0,
              resize: "none",
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
              fontSize: 12.5,
              lineHeight: 1.5,
              padding: "var(--bubble-pad-y, 8px) var(--bubble-pad-x, 12px)",
            }}
          />
        </div>
      </HTMLContainer>
    );
  }

  // —— 非编辑态：markdown 渲染（左上角对齐）——
  return (
    <HTMLContainer
      data-testid={`sticky-note-${shape.id}`}
      onPointerDown={() => editor.bringToFront([shape.id])}
      style={{ width: w, height: h, pointerEvents: "none" }}
    >
      <div style={bubbleStyle}>
        {/* 顶部拖拽把手：徽记 + 时间（新建自动记录）。整条是拖拽区（不拦截 pointer），
            让 tldraw 接管——便笺可拖拽面积太小的问题主要就是内容区占满、拦事件 */}
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px var(--bubble-pad-x, 12px) 0",
            fontSize: 10,
            color: "var(--text-muted)",
            cursor: "grab",
          }}
        >
          <span
            aria-hidden
            title={`徽记·${BADGE_NAMES[badge] ?? badge}`}
            style={{ width: 8, height: 8, borderRadius: "50%", background: BADGE_COLORS[badge] ?? BADGE_COLORS.blue, flexShrink: 0 }}
          />
          <span style={{ fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>{formatNoteTime(createdAt)}</span>
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: "4px var(--bubble-pad-x, 12px) var(--bubble-pad-y, 8px)",
            textAlign: "left",
          }}
        >
          {text.trim() ? (
            <div
              className="markdown-body"
              onPointerDown={isolateContent}
              onPointerUp={isolateContent}
              onClick={handleContentClick}
              onDoubleClick={handleContentDoubleClick}
              style={{ wordBreak: "break-word", cursor: "text" }}
            >
              <ReactMarkdown>{text}</ReactMarkdown>
            </div>
          ) : (
            <div
              onClick={handleContentClick}
              onDoubleClick={handleContentDoubleClick}
              style={{ color: "var(--text-dim)", fontSize: 12, cursor: "text" }}
            >
              双击编辑 markdown
            </div>
          )}
        </div>
      </div>
    </HTMLContainer>
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

/** 便笺时间：今天显示时:分，否则 月/日（新建自动记录） */
function formatNoteTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
