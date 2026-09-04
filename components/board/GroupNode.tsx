"use client";

/**
 * 分组容器节点（RF parentId 分组）：透明虚线框 + 组名。
 * - 子节点 parentId 指向本节点，position 为相对坐标（RF 原生）
 * - 拖动分组容器 = 整体移动组内节点（RF 原生）
 * - 选中态显示组名编辑（双击改名）
 * - 次级需求：支持分组
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { type NodeProps } from "@xyflow/react";
import { useBoardCanvasOps } from "./BoardCanvasContext";
import { memoBoardNode } from "./memoNode";

export interface GroupNodeData extends Record<string, unknown> {
  /** 组名（可选） */
  label?: string;
}

function GroupNodeImpl({ id, data, selected }: NodeProps & { data: GroupNodeData }) {
  const { updateNode } = useBoardCanvasOps();
  const label = data.label ?? "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(label);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, label]);

  const commit = useCallback(() => {
    const next = draft.trim();
    setEditing(false);
    if (next !== label) {
      updateNode(id, { data: { ...data, label: next || undefined } });
    }
  }, [draft, label, id, data, updateNode]);

  return (
    <div
      data-board-node
      data-testid={`group-node-${id}`}
      className="nowheel"
      onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        borderRadius: 12,
        // 分组容器：透明底 + 虚线框；选中态 accent 虚线
        border: selected
          ? "1.5px dashed color-mix(in srgb, var(--accent) 70%, transparent)"
          : "1.5px dashed color-mix(in srgb, var(--text) 28%, transparent)",
        background: selected
          ? "color-mix(in srgb, var(--accent) 5%, transparent)"
          : "color-mix(in srgb, var(--text) 2%, transparent)",
        pointerEvents: "auto",
        cursor: "move",
      }}
    >
      {/* 组名：左上角小标签 */}
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") { setDraft(label); setEditing(false); }
          }}
          onPointerDown={(e) => e.stopPropagation()}
          spellCheck={false}
          placeholder="组名"
          style={{
            position: "absolute",
            top: 8,
            left: 10,
            width: "calc(100% - 20px)",
            border: "none",
            outline: "none",
            background: "transparent",
            color: "var(--text-muted)",
            fontSize: 11,
            fontFamily: "inherit",
            padding: 0,
            cursor: "text",
          }}
        />
      ) : label ? (
        <span
          style={{
            position: "absolute",
            top: 8,
            left: 10,
            maxWidth: "calc(100% - 20px)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-dim)",
            letterSpacing: 0.3,
            userSelect: "none",
            pointerEvents: "none",
          }}
        >
          {label}
        </span>
      ) : null}
    </div>
  );
}

/** memo 化导出 */
export const GroupNode = memoBoardNode(GroupNodeImpl);
