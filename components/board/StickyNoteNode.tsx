"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { NodeResizer, Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import { computeResizeSnap } from "@/lib/board-align";
import ReactMarkdown from "react-markdown";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
// ProseMirror 基样式（white-space/ligatures 等），与 @xyflow 同方式按需引入
import "prosemirror-view/style/prosemirror.css";
import { HIGHLIGHT_SHADOW, useBoardSearch } from "@/components/canvas/BoardSearchContext";
import { CardKindBadge } from "@/components/canvas/CardKindBadge";
import { useCardGlass } from "@/hooks/useCardGlass";
import { useBoardCanvasOps } from "./BoardCanvasContext";
import { memoBoardNode } from "./memoNode";

/**
 * 自研 markdown 便笺（RF 节点版，替代 tldraw sticky-note shape）。
 * 观感 = AI 消息气泡同款毛玻璃（复用 --bubble-* / --assistant-card-glass token）。
 * - 双击进入编辑：TipTap WYSIWYG（ProseMirror 内核），无工具栏，所见即所得
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
  const { updateNode, deleteNode, setSnapLines } = useBoardCanvasOps();
  const { highlightId } = useBoardSearch();
  const isHighlighted = highlightId === id;
  const w = width ?? 380;
  const h = height ?? 280;
  const text = data.text ?? "";
  const badge = data.badge ?? "blue";

  // 玻璃（局部贴图）：从 RF store 读节点 position
  const { setContainer } = useCardGlass("var(--assistant-card-glass)");

  // 本地编辑态（RF 无 tldraw editing 概念）
  const [isEditing, setIsEditing] = useState(false);
  const [draftBadge, setDraftBadge] = useState(badge);
  const contentRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // 编辑中的最新 markdown（同步镜像）：TipTap onUpdate 实时写这里，save/finish/blur 读它——
  // 不依赖 React state（异步提交会丢 blur/Ctrl+Enter 瞬间的最后输入）
  const latestMdRef = useRef(text);
  // 旧便笺无 createdAt 时兜底（惰性初始化，不 render 期 Date.now）
  const [createdAt] = useState(() => data.createdAt ?? Date.now());
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 进入编辑重置镜像 + 徽记草稿（TipTap 编辑器初始化由子组件 NoteEditor 在 mount 时完成）
  useEffect(() => {
    if (isEditing) {
      setDraftBadge(badge);
      latestMdRef.current = text;
    }
  }, [isEditing, text, badge]);

  // onDraftChange：实时写 markdown 镜像
  const handleDraftChange = useCallback((md: string) => {
    latestMdRef.current = md;
  }, []);

  const save = useCallback(() => {
    const md = latestMdRef.current;
    if (md !== text || draftBadge !== badge) {
      updateNode(id, { data: { ...data, text: md, badge: draftBadge } });
    }
  }, [draftBadge, text, badge, updateNode, id, data]);

  const finish = useCallback(() => {
    save();
    setIsEditing(false);
  }, [save]);

  const cancel = useCallback(() => {
    setDraftBadge(badge);
    latestMdRef.current = text;
    setIsEditing(false);
  }, [text, badge]);

  // 失焦自动保存：编辑器失去焦点且焦点移出卡片 → 保存并退出编辑。
  // （点画布空白/点别的节点/切走应用 → 等价 tldraw 点别处退出编辑自动保存）
  // 点卡内按钮（徽记/取消/完成）焦点仍在卡内，NoteEditor 的 onBlur 内判断后不触发。
  const handleBlurExit = useCallback(() => {
    save();
    setIsEditing(false);
  }, [save]);

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
        ? "0 2px 10px -6px rgba(0,0,0,0.2), 0 0 0 5px transparent, 0 0 16px 5px color-mix(in srgb, var(--accent) 28%, transparent)"
        : "0 2px 10px -6px rgba(0,0,0,0.2)",
    animation: isHighlighted ? "board-search-glow 1.8s ease-out forwards" : undefined,
    color: "var(--text)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    fontSize: 13,
    lineHeight: 1.5,
    userSelect: "none",
    // 卡根默认箭头：非可移动区域（内容区）不用抓手；可拖的顶部把手行单独 grab
    cursor: "default",
    // 统一预留内边距：连线 Handle 呼吸空间 + 贴边按下可拖拽移动（RF 可拖区）+ 内容与 resize 边界留间距
    padding: 6,
  };

  // 非编辑态内容交互：阻止事件冒泡到 RF（避免触发节点拖动/画布平移）
  const isolateContent = useCallback((e: React.PointerEvent) => { if (e.button === 0) e.stopPropagation(); }, []);

  // resize：写回 style + data.w/h + 对齐参考线吸附
  const onResize = useCallback((_: unknown, params: { width: number; height: number }) => {
    const { getNodes } = useReactFlow();
    const nodes = getNodes();
    const self = nodes.find((n) => n.id === id);
    const pos = self?.position ?? { x: 0, y: 0 };
    const snap = computeResizeSnap(id, pos, params.width, params.height, nodes);
    setSnapLines(snap.lines);
    const finalW = snap.snapW ?? params.width;
    const finalH = snap.snapH ?? params.height;
    updateNode(id, { data: { ...data, w: finalW, h: finalH } });
  }, [id, data, updateNode, setSnapLines]);

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
            <button type="button" className="nodrag" onClick={cancel} style={footerBtnStyle} title="放弃变更 (Esc)">取消</button>
            <button type="button" className="nodrag" onClick={finish} style={footerBtnStyle} title="完成 (Ctrl+Enter)">完成</button>
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
        <NoteEditor
          key={`${id}-edit`}
          initialText={text}
          onDraftChange={handleDraftChange}
          onExit={finish}
          onCancel={cancel}
          onBlurExit={handleBlurExit}
          rootRef={rootRef}
        />
      ) : (
        <div
          ref={contentRef}
          className="nowheel nodrag"
          // 预览态 markdown 必须显式恢复文本选中：卡根 userSelect:none 会抑制整卡选中（编辑态已单独恢复）
          style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px var(--bubble-pad-x, 12px) var(--bubble-pad-y, 8px)", textAlign: "left", cursor: "text", userSelect: "text" }}
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

/**
 * 便笺编辑态的 TipTap WYSIWYG 编辑器。
 * - markdown ↔ ProseMirror 双向转换：初值用 initialText 解析，编辑中经 getMarkdown() 同步回 draft
 * - 无工具栏：手打 md 语法即时渲染成块（StarterKit 范围，不含表格/任务列表）
 * - 键盘：Ctrl/Cmd+Enter 完成，Esc 取消（均 stopPropagation 防 RF 拖拽/画布缩放）
 * - 失焦：焦点移到卡外 → onBlurExit（自动保存）；焦点仍在卡内（点徽记/取消/完成按钮）→ 保持编辑
 * - 随 isEditing 条件卸载，useEditor 自动 destroy
 */
function NoteEditor({
  initialText,
  onDraftChange,
  onExit,
  onCancel,
  onBlurExit,
  rootRef,
}: {
  initialText: string;
  onDraftChange: (text: string) => void;
  onExit: () => void;
  onCancel: () => void;
  onBlurExit: () => void;
  rootRef: React.RefObject<HTMLDivElement | null>;
}) {
  // 取消中标记：Esc/取消按钮触发的取消不应被随后的 blur 自动保存抢先
  const cancellingRef = useRef(false);
  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content: initialText || "",
    contentType: "markdown",
    editorProps: {
      attributes: {
        // 等宽对齐 markdown-body（预览态同款字体），行高 1.7 保持编辑/预览一致
        class: "markdown-body sticky-note-editor",
        spellcheck: "false",
      },
    },
    onUpdate: ({ editor }) => {
      if (cancellingRef.current) return; // 取消中忽略输入同步
      onDraftChange(editor.getMarkdown());
    },
    onBlur: ({ editor, event }) => {
      // 取消中（Esc/点取消按钮）：blur 不再触发保存退出
      if (cancellingRef.current) return;
      // 先把最终内容同步回父（blur 时 React setState 可能尚未提交，直接读 editor 保证不丢尾输入）
      onDraftChange(editor.getMarkdown());
      // 点卡内可聚焦元素（徽记/取消/完成按钮）：焦点移到卡内，保持编辑
      const next = (event as FocusEvent).relatedTarget;
      const root = rootRef.current;
      if (root && next instanceof Node && root.contains(next)) return;
      onBlurExit();
    },
  });

  // 进入编辑立即聚焦（textarea 时代 focus 在首行；contenteditable focus 置于文档开头）
  useEffect(() => {
    requestAnimationFrame(() => {
      editor?.commands.focus("start");
    });
  }, [editor]);

  // 取消：标记后在下一 tick 清标记（父组件卸载本组件前 blur 可能先到），并回调父取消
  const handleCancel = useCallback(() => {
    cancellingRef.current = true;
    // 让 blur（若有）先过去，再触发取消；父取消会卸载本组件，ref 标记随之销毁
    requestAnimationFrame(() => {
      onCancel();
    });
  }, [onCancel]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        // 先同步当前内容（keydown 时 React setState 可能未提交），再让父完成保存
        if (editor) onDraftChange(editor.getMarkdown());
        onExit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        handleCancel();
      }
    },
    [editor, onDraftChange, onExit, handleCancel],
  );

  return (
    <div
      className="nodrag nowheel sticky-note-edit-wrap"
      data-testid="sticky-note-editor"
      onKeyDown={handleKeyDown}
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        // 卡根 userSelect:none 会抑制编辑选中；编辑态显式恢复文本选择
        userSelect: "text",
        padding: "var(--bubble-pad-y, 8px) var(--bubble-pad-x, 12px)",
      }}
    >
      <EditorContent editor={editor} />
    </div>
  );
}

/** memo 化导出：忽略拖拽/位置类 props 每帧变化，避免拖拽时整卡重渲染 */
export const StickyNoteNode = memoBoardNode(StickyNoteNodeImpl);
