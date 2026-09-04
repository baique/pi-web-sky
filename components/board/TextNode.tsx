"use client";

/**
 * 手写体文字节点（RF 版，替代 tldraw text shape）。
 *
 * 类似 excalidraw 的文字：无卡片背景，只有文字本身，手写字体渲染。
 * - 双击进入编辑：textarea 自适应高度，失焦/Ctrl+Enter 保存，Esc 取消
 * - 非编辑态：纯文字 + 手写体（--font-hand），选中态显示虚线描边
 * - 尺寸自适应：编辑态 textarea 撑开，预览态由内容决定（RF measured）
 * - 空白文字：创建后默认进入编辑态（autofocus）
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useBoardCanvasOps } from "./BoardCanvasContext";
import { memoBoardNode } from "./memoNode";

export interface TextNodeData extends Record<string, unknown> {
  /** 纯文本内容（无 markdown，所见即所得） */
  text: string;
  /** 手写体字号（px），默认 20 */
  fontSize?: number;
  /** 文字颜色（CSS 颜色），默认主题色 */
  color?: string;
  /** 是否自动进入编辑（创建后首帧） */
  autofocus?: boolean;
}

function TextNodeImpl({ id, data, selected }: NodeProps & { data: TextNodeData }) {
  const { updateNode } = useBoardCanvasOps();
  const text = data.text ?? "";
  const fontSize = data.fontSize ?? 20;
  const color = data.color ?? "var(--text)";

  const [editing, setEditing] = useState(Boolean(data.autofocus));
  // 编辑草稿（保存时读 ref，防 blur/Ctrl+Enter 丢尾输入——同便笺 latestMdRef 教训）
  const draftRef = useRef(text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // 进入编辑时的初始值（外部 text 变化只在进入编辑时重置一次）
  const initialTextRef = useRef(text);
  const cancellingRef = useRef(false);
  // 上次是否在编辑（防止编辑期间外部 yjs 回灌 text 覆盖草稿）
  const wasEditingRef = useRef(Boolean(data.autofocus));

  // textarea 高度自适应内容（useCallback 需在 useEffect 前定义）
  const autoGrow = useCallback((ta: HTMLTextAreaElement) => {
    ta.style.height = "auto";
    ta.style.height = `${Math.max(24, ta.scrollHeight)}px`;
  }, []);

  // 进入编辑：重置草稿 + 聚焦末尾 + 自适应高度；编辑期间外部 text 变化不覆盖草稿
  useEffect(() => {
    if (editing && !wasEditingRef.current) {
      initialTextRef.current = text;
      draftRef.current = text;
      cancellingRef.current = false;
      const ta = textareaRef.current;
      if (ta) {
        requestAnimationFrame(() => {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
          autoGrow(ta);
        });
      }
    }
    wasEditingRef.current = editing;
  }, [editing, text, autoGrow]);

  const save = useCallback(() => {
    const next = draftRef.current;
    if (next !== text || data.autofocus) {
      updateNode(id, { data: { ...data, autofocus: undefined, text: next } });
    }
  }, [text, data, id, updateNode]);

  const finish = useCallback(() => {
    save();
    setEditing(false);
  }, [save]);

  const cancel = useCallback(() => {
    cancellingRef.current = true;
    draftRef.current = initialTextRef.current;
    // 取消也清掉 autofocus 标记（防止 Esc 后 yjs 里残留 autofocus，下次回灌又进编辑）
    if (data.autofocus) {
      updateNode(id, { data: { ...data, autofocus: undefined, text: draftRef.current } });
    }
    setEditing(false);
  }, [data, id, updateNode]);

  // 失焦自动保存：焦点移到卡外（非本节点内部）→ 保存退出编辑
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

  // 编辑中 textarea 输入：更新草稿 + 自适应
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    draftRef.current = e.target.value;
    autoGrow(e.target);
  }, [autoGrow]);

  return (
    <>
      <Handle type="target" position={Position.Left} className="board-handle" style={{ background: "var(--text-dim)", width: 8, height: 8, border: "1px solid var(--bg-panel)", opacity: 0.85 }} />
      <Handle type="source" position={Position.Right} className="board-handle" style={{ background: "var(--text-dim)", width: 8, height: 8, border: "1px solid var(--bg-panel)", opacity: 0.85 }} />
      <div
        ref={rootRef}
        data-board-node
        data-testid={`text-node-${id}`}
        className="nowheel"
        onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
        style={{
          position: "relative",
          minWidth: 40,
          minHeight: 30,
          // 选中/编辑态：虚线描边（类似 excalidraw 选中框）；非选中无边框无背景
          outline: selected || editing ? "1.5px dashed color-mix(in srgb, var(--accent) 65%, transparent)" : "none",
          outlineOffset: 4,
          borderRadius: 4,
          padding: "4px 6px",
          color,
          fontFamily: "var(--font-hand)",
          fontSize,
          lineHeight: 1.35,
          cursor: "default",
          userSelect: editing ? "text" : "none",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
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
              minWidth: 200,
              minHeight: 24,
              border: "none",
              outline: "none",
              background: "transparent",
              color: "inherit",
              fontFamily: "inherit",
              fontSize: "inherit",
              lineHeight: "inherit",
              resize: "none",
              overflow: "hidden",
              padding: 0,
              userSelect: "text",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          />
        ) : (
          <div
            className="nodrag"
            onPointerDown={(e) => { if (e.button === 0) e.stopPropagation(); }}
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", minHeight: "1em" }}
          >
            {text || <span style={{ opacity: 0.35 }}>双击编辑</span>}
          </div>
        )}
      </div>
    </>
  );
}

/** memo 化导出：忽略拖拽/位置类 props 每帧变化 */
export const TextNode = memoBoardNode(TextNodeImpl);
