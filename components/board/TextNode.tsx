"use client";

/**
 * 手写体文字节点（RF 版）——复刻 tldraw/excalidraw 文字交互。
 *
 * 尺寸驱动派：NodeResizer 只改节点尺寸（RF 原生管理），字号 = 纯函数（宽度）：
 *   fs = clamp(base × width / REF_W, FS_MIN, FS_MAX)
 * 字号与边框同源同步（字号由宽度派生，内容重排撑高，高度再校准回内容）。
 * 参考实践：XYflow 社区 srl-labs/vscode-containerlab TrafficRateNode（字号从
 * 节点尺寸派生、onResizeEnd 落库）；公式与 excalidraw 的宽度比例缩放同构。
 *
 * - 双击进入编辑：textarea 自适应，失焦/Ctrl+Enter 保存，Esc 取消
 * - 空内容失焦自动删卡
 * - 选中态 NodeResizer 4 角 + 4 边手柄
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { NodeResizer, Handle, Position, type NodeProps } from "@xyflow/react";
import { useBoardCanvasOps } from "./BoardCanvasContext";
import { memoBoardNode } from "./memoNode";

/** 创建时默认宽度（与 CanvasStage addNodeAt 一致），作为字号基准宽度 */
const REF_W = 240;
/** 基准宽度下的字号（px） */
const TEXT_NODE_DEFAULT_FS = 40;
/** 默认字重（粗体） */
export const TEXT_NODE_FONT_WEIGHT = 700;
/** 字号 clamp 范围 */
const FS_MIN = 12;
const FS_MAX = 200;

export interface TextNodeData extends Record<string, unknown> {
  /** 纯文本内容（无 markdown，所见即所得） */
  text: string;
  /** 文字颜色（CSS 颜色），默认主题色 */
  color?: string;
  /** 是否自动进入编辑（创建后首帧） */
  autofocus?: boolean;
  /** 背景样式：无 / 玻璃（便笺同款磨砂） / 嵌入色彩（accent 融入） */
  bg?: "none" | "glass" | "tint";
  /** 下划线 */
  underline?: boolean;
  /** 删除线 */
  strikethrough?: boolean;
}

function TextNodeImpl({ id, data, selected, width, height }: NodeProps & { data: TextNodeData }) {
  const { updateNode, updateNodeDebounced, deleteNode } = useBoardCanvasOps();
  const text = data.text ?? "";
  const color = data.color ?? "var(--text)";
  const bg = data.bg ?? "none";
  const underline = Boolean(data.underline);
  const strikethrough = Boolean(data.strikethrough);
  // 背景样式（玻璃/嵌入色）+ 文本装饰：编辑与展示共用同一套派生样式
  const bgStyle = bg === "glass"
    ? { background: "var(--board-card-glass)", backdropFilter: "blur(14px) saturate(1.4)", WebkitBackdropFilter: "blur(14px) saturate(1.4)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)" }
    : bg === "tint"
      ? { background: "color-mix(in srgb, var(--accent) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--accent) 42%, transparent)" }
      : { background: "transparent", border: "1px solid transparent" };
  const textDecoration = [underline ? "underline" : null, strikethrough ? "line-through" : null].filter(Boolean).join(" ") || "none";

  // 字号 = 宽度派生（纯函数，无状态）：宽 REF_W → 默认 40px，等比例放大缩小
  const nodeW = Math.max(20, width ?? REF_W);
  const derivedFs = Math.round(Math.min(FS_MAX, Math.max(FS_MIN, TEXT_NODE_DEFAULT_FS * (nodeW / REF_W))));

  const [editing, setEditing] = useState(Boolean(data.autofocus));
  // 最新 data 镜像：格式按钮/保存回调读 ref，避免闭包旧 data 覆盖样式
  //（点击格式后未及时 re-render → blur 保存用旧 data 把 bg/underline 冲掉）
  const dataRef = useRef(data);
  dataRef.current = data;
  // 拖拽缩放中的本地字号：RF 拖动时 props.width（来自 measured）不实时更新，
  // 用 onResize 的 params.width（flow 单位）实时算字号跟手；松手清空回落派生值。
  const [dragFs, setDragFs] = useState<number | null>(null);
  const effectiveFs = dragFs ?? derivedFs;
  // 编辑草稿（保存时读 ref，防 blur/Ctrl+Enter 丢尾输入）
  const draftRef = useRef(text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const cancellingRef = useRef(false);
  const wasEditingRef = useRef(Boolean(data.autofocus));

  // textarea 高度自适应
  const autoGrow = useCallback((ta: HTMLTextAreaElement) => {
    ta.style.height = "auto";
    ta.style.height = `${Math.max(24, ta.scrollHeight)}px`;
  }, []);

  // 重置编辑草稿（编辑期间外部 text 变化不覆盖草稿：只在非编辑 → 编辑时重置）
  useEffect(() => {
    if (editing && !wasEditingRef.current) {
      draftRef.current = text;
      cancellingRef.current = false;
    }
    wasEditingRef.current = editing;
  }, [editing, text]);

  // 聚焦：进入编辑（含 autofocus 首帧）即聚焦末尾 + 自适应高度。
  useEffect(() => {
    if (!editing) return;
    draftRef.current = text;
    let t1 = 0;
    let t2 = 0;
    const ta = textareaRef.current;
    if (ta) {
      t1 = requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        autoGrow(ta);
        t2 = requestAnimationFrame(() => {
          if (document.activeElement !== ta) {
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
          }
        });
      });
    }
    return () => { cancelAnimationFrame(t1); cancelAnimationFrame(t2); };
  }, [editing, text, autoGrow]);

  const finish = useCallback(() => {
    const next = draftRef.current;
    // 空内容失焦：自动删卡（不留空白文字卡片）
    if (!next.trim()) {
      deleteNode(id);
      return;
    }
    if (next !== text || data.autofocus) {
      // 只传变更字段（autofocus 清除 + 新文本）：updateNode 深合并保留 bg/underline 等格式
      updateNode(id, { data: { autofocus: undefined, text: next } });
    }
    setEditing(false);
  }, [text, data, id, updateNode, deleteNode]);

  const cancel = useCallback(() => {
    cancellingRef.current = true;
    draftRef.current = text;
    if (data.autofocus) {
      updateNode(id, { data: { autofocus: undefined } });
    }
    setEditing(false);
  }, [data, id, updateNode, text]);

  // 失焦自动保存：焦点移出节点 → finish（空内容会走删卡）
  const handleBlur = useCallback(
    (e: React.FocusEvent) => {
      if (cancellingRef.current) return;
      const next = (e as unknown as FocusEvent).relatedTarget;
      const root = rootRef.current;
      if (root && next instanceof Node && root.contains(next)) return;
      finish();
    },
    [finish],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        finish();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    },
    [finish, cancel],
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    draftRef.current = e.target.value;
    autoGrow(e.target);
  }, [autoGrow]);

  // 高度 = 内容自适应：字号变 / 文本变 / 编辑中 → 内容重排 → 校准节点 height（flow 单位）。
  // offsetHeight 是 layout px（不含 RF 的 CSS transform 缩放），直接 = flow 单位，
  // 不能除以 zoom（rect 才需除，那是屏幕 px）。
  // 关键：缩放拖动中不写 yjs（resizingRef 保护）——每帧 updateNode 会触发 observe
  // 回灌 → setNodes 全量重建 → 重渲染 → 卡顿（“很不跟手”元凶）+ undo 栈被中间值污染。
  // 拖动中字号/重排本地跟手，松手后 effectiveFs 回落触发本函数一次落库。
  // 编辑态也同步（否则 wrapper 停在创建高度 → 连线句柄 top:50% 偏离内容中心）。
  // 编辑中打字高频变化 → 走 updateNodeDebounced（停顿 150ms 合并一次），不每帧写。
  const resizingRef = useRef(false);
  const syncHeight = useCallback(() => {
    const el = rootRef.current;
    if (!el || resizingRef.current) return;
    const h = Math.max(20, Math.round(el.offsetHeight));
    if (Math.abs(h - (height ?? 0)) > 1) {
      // 只校 height：宽度由 RF/NodeResizer 管（style 深合并保留现有 width）。
      if (editing) updateNodeDebounced(id, { style: { height: h } }, 150);
      else updateNode(id, { style: { height: h } });
    }
  }, [id, editing, updateNode, updateNodeDebounced, height]);

  useEffect(() => {
    const t = requestAnimationFrame(syncHeight);
    return () => cancelAnimationFrame(t);
  }, [effectiveFs, text, editing, syncHeight, height]);

  // NodeResizer：RF 原生改节点尺寸（flow 单位），松手落 yjs。拖动中 props.width
  //（来自 measured）不实时更新，用 onResize 的 params.width 实时派生字号本地跟手；
  // 松手清空 dragFs，回落派生值（= 拖动终值，无跳变）。
  const onResizeStart = useCallback(() => { resizingRef.current = true; }, []);
  const onResize = useCallback(
    (_: unknown, params: { width: number; height: number }) => {
      const nextFs = Math.round(Math.min(FS_MAX, Math.max(FS_MIN, TEXT_NODE_DEFAULT_FS * (params.width / REF_W))));
      setDragFs(nextFs);
    },
    [],
  );
  const onResizeEnd = useCallback(
    (_: unknown, params: { width: number; height: number }) => {
      if (!resizingRef.current) return; // 幽灵 end（RF 重初始化旧值）忽略
      resizingRef.current = false;
      setDragFs(null);
      // 松手一次落库最终尺寸（flow 单位，RF store 终值）：RF 的 dimensions change
      // 不写 user node 的 style（只更新 internal measured），尺寸真相源在 style——
      // 不写会回退到创建值。style 深合并保留另一维；height 稍后由 syncHeight 校准为内容高。
      updateNode(id, { style: { width: Math.max(20, Math.round(params.width)), height: Math.max(20, Math.round(params.height)) } });
    },
    [id, updateNode],
  );

  // ---- 编辑工具栏：透明/玻璃/嵌入色 + 下划线/删除线 ----
  // 编辑态常驻，absolute 定位在节点上方（top:-38，root overflow visible 显示），
  // DOM 仍在 root 内 → 点击不触发 blur 保存（handleBlur 的 contains 检查）。
  // onMouseDown preventDefault 防 textarea 失焦；onPointerDown stopPropagation 防 RF 拖拽。
  const setFormat = useCallback(
    (patch: Partial<TextNodeData>) => {
      // 增量更新：updateNode data 深合并，patch 只含本次字段，不覆盖先前格式
      updateNode(id, { data: patch });
    },
    [id, updateNode],
  );
  const toggleBg = (next: "none" | "glass" | "tint") => {
    if (next === bg) return;
    setFormat({ bg: next });
  };
  const renderToolbar = () => {
    if (!editing) return null;
    const btnBase: React.CSSProperties = {
      width: 24, height: 22, padding: 0, border: "none", borderRadius: 4, cursor: "pointer",
      display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, lineHeight: 1,
      color: "var(--text)", background: "transparent", flexShrink: 0,
    };
    const activeBtn: React.CSSProperties = { background: "color-mix(in srgb, var(--accent) 22%, transparent)", color: "var(--accent)" };
    const swatch = (key: "none" | "glass" | "tint", color: string, title: string) => (
      <button
        title={title}
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => toggleBg(key)}
        style={{ ...btnBase, ...(bg === key ? activeBtn : {}) }}
      >
        <span style={{ width: 14, height: 14, borderRadius: 3, border: bg === key ? "2px solid var(--accent)" : "1px solid color-mix(in srgb, var(--border) 70%, transparent)", background: color, display: "block" }} />
      </button>
    );
    const toggleBtn = (active: boolean, onClick: () => void, label: string, title: string) => (
      <button
        title={title}
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onClick}
        style={{ ...btnBase, ...(active ? activeBtn : {}), fontWeight: 700 }}
      >
        {label}
      </button>
    );
    return (
      <div
        className="nowheel"
        data-testid="text-node-toolbar"
        style={{
          position: "absolute", top: -38, left: 0, zIndex: 50,
          display: "flex", gap: 2, padding: 3, borderRadius: 8,
          background: "var(--bg-panel)",
          border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
          boxShadow: "0 4px 16px color-mix(in srgb, #000 25%, transparent)",
        }}
      >
        {swatch("none", "transparent", "透明背景")}
        {swatch("glass", "var(--board-card-glass)", "玻璃背景")}
        {swatch("tint", "color-mix(in srgb, var(--accent) 20%, transparent)", "嵌入色彩")}
        <span style={{ width: 1, alignSelf: "stretch", margin: "2px 2px", background: "color-mix(in srgb, var(--border) 60%, transparent)" }} />
        {toggleBtn(underline, () => setFormat({ underline: !underline }), "U", "下划线")}
        {toggleBtn(strikethrough, () => setFormat({ strikethrough: !strikethrough }), "S̶", "删除线")}
      </div>
    );
  };

  // 手柄渲染（选中态显示，wrapper 层，RF 处理遮挡/z-index）
  // 4 角手柄透明化：视觉隐藏小圆球（突兀），保留事件与功能；hover/拖动时经
  // .board-text-resize-handle 淡显（见 globals.css）。handleStyle 不设 background，
  // 否则 inline 会覆盖 CSS 的 hover 态。
  const renderResizer = () => {
    if (!selected || editing) return null;
    return (
      <NodeResizer
        minWidth={80}
        minHeight={40}
        onResizeStart={onResizeStart}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
        color="var(--accent)"
        handleClassName="board-text-resize-handle"
        handleStyle={{ width: 16, height: 16, zIndex: 30, cursor: "nwse-resize" }}
        lineStyle={{ borderColor: "color-mix(in srgb, var(--accent) 45%, transparent)", zIndex: 30 }}
      />
    );
  };

  return (
    <>
      <Handle type="target" position={Position.Left} className="board-handle" style={{ background: "var(--text-dim)", width: 8, height: 8, border: "1px solid var(--bg-panel)", opacity: 0.85 }} />
      <Handle type="source" position={Position.Right} className="board-handle" style={{ background: "var(--text-dim)", width: 8, height: 8, border: "1px solid var(--bg-panel)", opacity: 0.85 }} />
      {renderResizer()}
      <div
        ref={rootRef}
        data-board-node
        data-testid={`text-node-${id}`}
        className="nowheel"
        onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
        style={{
          position: "relative",
          zIndex: 0, // NodeResizer 手柄 zIndex 30 必须盖住内容
          // 尺寸：宽度跟随 RF 节点（NodeResizer 改），高度内容自适应（overflow visible，
          // 同步校准到 style.height）
          width: "100%",
          minHeight: 28,
          boxSizing: "border-box",
          // 背景（透明/玻璃/嵌入色）与文本装饰（下划线/删除线）
          ...bgStyle,
          textDecoration,
          // 选中/编辑态：虚线描边（excalidraw 选中框）
          outline: selected || editing ? "1.5px dashed color-mix(in srgb, var(--accent) 65%, transparent)" : "none",
          outlineOffset: 5,
          borderRadius: 4,
          padding: "4px 6px",
          color,
          fontFamily: "var(--font-hand)",
          fontSize: effectiveFs,
          fontWeight: TEXT_NODE_FONT_WEIGHT,
          lineHeight: 1.35,
          cursor: "default",
          userSelect: editing ? "text" : "none",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflowWrap: "anywhere",
        }}
      >
        {renderToolbar()}
        {editing ? (
          <textarea
            ref={textareaRef}
            defaultValue={text}
            onChange={handleChange}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            onPointerDown={(e) => e.stopPropagation()}
            spellCheck={false}
            rows={1}
            data-testid="text-node-editor"
            style={{
              display: "block",
              width: "100%",
              minWidth: 0,
              minHeight: 26,
              border: "none",
              outline: "none",
              background: "transparent",
              color: "inherit",
              fontFamily: "inherit",
              fontSize: "inherit",
              fontWeight: "inherit",
              lineHeight: "inherit",
              resize: "none",
              overflow: "hidden",
              padding: 0,
              userSelect: "text",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              caretColor: "currentColor",
              // 下划线/删除线：textarea 默认 text-decoration:none 不继承，需显式继承
              textDecoration: "inherit",
            }}
          />
        ) : (
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", minHeight: "1em" }}>
            {text || <span style={{ opacity: 0.35 }}>双击编辑</span>}
          </div>
        )}
      </div>
    </>
  );
}

/** memo 化导出：忽略拖拽/位置类 props 每帧变化 */
export const TextNode = memoBoardNode(TextNodeImpl);
