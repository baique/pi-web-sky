"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BaseBoxShapeUtil, HTMLContainer, T, resizeBox, useEditor, useValue } from "tldraw";
import type { TLBaseShape, TLShapePartial } from "tldraw";
import ReactMarkdown from "react-markdown";
import { HIGHLIGHT_SHADOW, useBoardSearch } from "./BoardSearchContext";
import { CardKindBadge } from "./CardKindBadge";

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

  /** 便笺内部可滚动（编辑态 textarea / 非编辑态 markdown 内容区）：
   *  声明后 tldraw 在编辑本便笺时豁免 wheel（不劫持成画布平移），让内部正常滚动。 */
  override canScroll(): boolean {
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
  // 搜索高亮：命中时 accent 描边 + 泛光渐隐（由 BoardSearchContext 驱动，不落库）
  const { highlightId } = useBoardSearch();
  const isHighlighted = highlightId === shape.id;
  const isEditing = useValue("editing", () => editor.getEditingShapeId() === shape.id, [editor, shape.id]);

  // 内容区与画布手势隔离：
  // - pointer 事件不冒泡到 .tl-canvas，tldraw 不会把这里的手势当成形状拖拽；
  //   文本拖动 = 浏览器原生选字（CSS 已放行 user-select:text）。
  // - 但 tldraw 的 canvas 层事件（选中 / ClickManager 双击进编辑）也因此收不到，
  //   由本地 click / dblclick 补回（浏览器保证拖动后不派发 click，选中与拖拽天然互斥）。
  // - 仅拦左键(0)：右键必须冒泡到 tldraw 打开上下文菜单（右键便笺失灵根因）。
  const isolateContent = useCallback(
    (e: React.PointerEvent) => { if (e.button === 0) e.stopPropagation(); },
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

  // 旧便笺无 createdAt 时兜底：用挂载时刻（仅展示，不写回避免噪声）。
  // useState 惰性初始化——只在挂载取一次，避免 render 期调用 Date.now()（React purity 规则）。
  const [createdAt] = useState(() => shape.props.createdAt ?? Date.now());
  const badge = shape.props.badge ?? "blue";

  const [draft, setDraft] = useState(text);
  const draftRef = useRef(text);
  // 徽记同样进草稿：完成才写回，取消则放弃选择
  const [draftBadge, setDraftBadge] = useState(badge);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 非编辑态 markdown 内容区（滚动拦截挂这里，原生监听）
  const contentRef = useRef<HTMLDivElement>(null);
  // 取消时置 true：退出编辑的保存钩子跳过（放弃草稿）；finish 不置 → 正常保存
  const cancelRef = useRef(false);
  const wasEditingRef = useRef(false);
  // 复制反馈：复制成功后短暂显示 ✓
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // wheel 拦截（原生监听，非 React 合成）：tldraw 的原生 wheel 监听在 .tl-container（更内层、
  // 先触发），React 合成 onWheel 在 React root 派发（晚于 tldraw），stopPropagation 根本来不及 ——
  // 这是便笺被选中时滚动仍平移画布的根因。改原生 addEventListener 挂在内容容器上（bubble），
  // 事件冒泡到 tldraw container 之前先拦截。无依赖 effect：便笺 DOM 随 tldraw 重渲染替换，
  // 每次渲染重挂保证监听在当前元素。仅内容溢出时拦截（按需），ctrl/meta 缩放交给画布。
  useEffect(() => {
    const attach = (el: HTMLElement | null) => {
      if (!el) return;
      const stop = (e: WheelEvent) => {
        if (e.ctrlKey || e.metaKey) return;
        if (el.scrollHeight > el.clientHeight) e.stopPropagation();
      };
      el.addEventListener("wheel", stop);
      return () => el.removeEventListener("wheel", stop);
    };
    const detachTA = attach(textareaRef.current);
    const detachContent = attach(contentRef.current);
    return () => {
      detachTA?.();
      detachContent?.();
    };
  });

  // copy 拦截（原生监听，bubble 阶段）：预览态选中文本后 Ctrl+C 会被 tldraw 劫持——
  // 单击内容区会选中 shape（handleContentClick → editor.select），tldraw 的 useNativeClipboardEvents
  // 发现 selectedShapeIds 非空即 preventDefault 并复制 shape，sticky-note 无可提取文本时
  // 写入一个空格（`textContent = " "`），选区文本被丢弃。这里在事件冒泡到 document
  // （tldraw 监听处）之前，若存在非空文本选区就 stopPropagation，放行浏览器原生复制选区；
  // 无文本选区（shape 选中复制）则放行给 tldraw 正常复制。无依赖 effect：DOM 随渲染替换。
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const onCopy = (e: ClipboardEvent) => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) e.stopPropagation();
    };
    el.addEventListener("copy", onCopy);
    return () => el.removeEventListener("copy", onCopy);
  });

  const copyContent = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      // 复制「渲染后」的格式文本（非 markdown 源码）：直接取已渲染的 .markdown-body 文本，
      // 所见即所得（标题/粗体/列表/链接均按显示样式展开）；空便笺（无渲染 DOM）回退原始 text。
      const rendered =
        contentRef.current?.querySelector<HTMLElement>(".markdown-body")?.innerText ?? shape.props.text;
      void navigator.clipboard.writeText(rendered).then(() => {
        setCopied(true);
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => setCopied(false), 1200);
      }).catch(() => {
        // 剪贴板不可用（无焦点/权限）：回退到临时 textarea
        try {
          const ta = document.createElement("textarea");
          ta.value = rendered;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          setCopied(true);
          if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
          copiedTimerRef.current = setTimeout(() => setCopied(false), 1200);
        } catch {
          // ignore
        }
      });
    },
    [shape.props.text],
  );

  // 卸载时清理定时器
  useEffect(() => () => { if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current); }, []);

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
    border: isHighlighted ? "2px solid var(--accent)" : "1px solid var(--bubble-border)",
    background: "var(--assistant-card-glass)",
    backdropFilter: "blur(var(--glass-blur-bubble)) saturate(var(--glass-saturate))",
    WebkitBackdropFilter: "blur(var(--glass-blur-bubble)) saturate(var(--glass-saturate))",
    boxShadow: isHighlighted ? HIGHLIGHT_SHADOW : "0 2px 10px -6px rgba(0,0,0,0.2)",
    animation: isHighlighted ? "board-search-glow 1.8s ease-out forwards" : undefined,
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
          {/* 顶部：类别徽记 + 徽记选择 + 取消/完成（按钮区置顶）。
              高度与预览态 header 固定一致（32px），避免编辑/预览切换时卡片顶部跳动 */}
          <div
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              flexShrink: 0,
              height: 32,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "0 10px",
              borderBottom: "1px solid var(--bubble-hairline)",
              boxSizing: "border-box",
            }}
          >
            {/* 类别徽记：状态点 = 当前徽记草稿色 + 类型「便笺」（11px 浅色） */}
            <CardKindBadge kind="note" color={BADGE_COLORS[draftBadge] ?? BADGE_COLORS.blue} />
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
            onPointerDown={(e) => { if (e.button === 0) e.stopPropagation(); }}
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
            height: 32,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 var(--bubble-pad-x, 12px)",
            fontSize: 10,
            color: "var(--text-muted)",
            cursor: "grab",
            boxSizing: "border-box",
          }}
        >
          {/* 类别徽记：状态点 = 用户徽记色 + 类型「便笺」（11px 浅色），时间戳右侧两端对齐 */}
          <CardKindBadge kind="note" color={BADGE_COLORS[badge] ?? BADGE_COLORS.blue} />
          {/* 右上角：时间戳 + 快捷复制（两端对齐，时间戳放最右；复制独立接收点击不参与拖拽把手） */}
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>{formatNoteTime(createdAt)}</span>
          <button
            type="button"
            title={copied ? "已复制" : "复制内容"}
            onClick={copyContent}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 20,
              padding: 0,
              border: "none",
              borderRadius: 5,
              background: "transparent",
              color: copied ? "var(--accent)" : "var(--text-dim)",
              cursor: "pointer",
              pointerEvents: "all",
            }}
          >
            {copied ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
        </div>
        <div
          ref={contentRef}
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
