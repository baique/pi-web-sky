"use client";

/**
 * 看板右键菜单（玻璃配方）—— 替代 tldraw SyncedContextMenu。
 * - 节点右键：删除（会话/任务卡走确认制，便笺/文字/图片/分组直接删）
 * - 派生边右键：只读提示（exec/依赖线由后端 reconcile 权威维护，不可删）
 * - 空白右键：新建便笺 / 新建任务卡 / 新建文字 / 新建图片 / 创建分组（多选时）
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Node } from "@xyflow/react";
import { useReactFlow } from "@xyflow/react";
import { useBoardCanvasOps } from "@/components/board/BoardCanvasContext";

export interface BoardMenuState {
  x: number;
  y: number;
  node: Node | null;
  edgeId: string | null;
  /** 边是否为派生边（exec/依赖线，由后端 reconcile 权威维护，不可删） */
  edgeDerived?: boolean;
}

export function BoardContextMenu({ menu, onClose }: { menu: BoardMenuState; onClose: () => void }) {
  const ops = useBoardCanvasOps();
  const { getNodes } = useReactFlow();
  const { node, edgeId, x, y, edgeDerived } = menu;
  const menuRef = useRef<HTMLDivElement>(null);

  // 全局消失：左键点菜单外部任意位置（节点/输入框/工具栏/小地图/画布）→ 关闭。
  // capture 阶段拦截，早于 RF 的节点选中/拖拽/画布平移，避免菜单残留。
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return; // 仅左键；右键留给 onXxxContextMenu 换位
      const el = menuRef.current;
      if (el && e.target instanceof Element && el.contains(e.target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose]);

  // 派生边判断：edgeId 对应的 edge 是否 exec/依赖（由 CanvasStage 计算传入）
  const isDerivedEdge = Boolean(edgeId && edgeDerived);

  const handleDeleteNode = useCallback(() => {
    if (node) ops.deleteNode(node.id);
    onClose();
  }, [node, ops, onClose]);

  const handleDeleteEdge = useCallback(() => {
    if (edgeId && !isDerivedEdge) ops.deleteEdge(edgeId);
    onClose();
  }, [edgeId, isDerivedEdge, ops, onClose]);

  const addNote = useCallback(() => {
    ops.addNode({
      id: crypto.randomUUID(),
      type: "sticky-note",
      position: { x, y },
      style: { width: 338, height: 230 },
      data: { text: "", badge: "blue" },
    });
    onClose();
  }, [ops, x, y, onClose]);

  const addText = useCallback(() => {
    ops.addNode({
      id: crypto.randomUUID(),
      type: "text-node",
      position: { x, y },
      style: { width: 240, height: 60 },
      data: { text: "", autofocus: true },
    });
    onClose();
  }, [ops, x, y, onClose]);

  const addImage = useCallback(() => {
    onClose();
    // 打开图片选择（触发 CanvasStage 的隐藏 input 由菜单关闭后的点击流）
    // 简单方案：直接触发一个自定义事件让 CanvasStage 打开文件选择
    window.dispatchEvent(new CustomEvent("pi:board-pick-image"));
  }, [onClose]);

  const addTaskCard = useCallback(() => {
    ops.addNode({
      id: crypto.randomUUID(),
      type: "task-card",
      position: { x, y },
      style: { width: 380, height: 270 },
      data: {
        cardId: "", number: 0, name: "新建任务", description: "",
        readyStatus: "draft", priority: 0,
        expanded: false, w: 380, h: 270, expandedW: 0, expandedH: 0, collapsedW: 0, collapsedH: 0,
      },
    });
    onClose();
  }, [ops, x, y, onClose]);

  // ---- 分组（次级）：多选节点 → 创建分组 / 取消分组 ----
  // 当前选中集合（RF store，含刚右键的节点）
  const selectedNodes = useMemo(() => {
    const nodes = getNodes() as Array<Node & { selected?: boolean }>;
    return nodes.filter((n) => n.selected);
  }, [getNodes]);
  const multiSelect = selectedNodes.length > 1;
  // 右键的是 group 容器 → 提供「取消分组」
  const isGroup = node?.type === "group-node";
  // 选中集合里含 group 且不全是 group → 提供「取消分组（选中）」
  const selHasGroup = selectedNodes.some((n) => n.type === "group-node") && !selectedNodes.every((n) => n.type === "group-node");

  const createGroup = useCallback(() => {
    onClose();
    // 交由 CanvasStage 的统一分组逻辑处理（需要 RF 全节点包围盒计算）
    window.dispatchEvent(new CustomEvent("pi:board-create-group"));
  }, [onClose]);

  const ungroup = useCallback(() => {
    onClose();
    if (isGroup && node) {
      window.dispatchEvent(new CustomEvent("pi:board-ungroup", { detail: { groupId: node.id } }));
      return;
    }
    window.dispatchEvent(new CustomEvent("pi:board-ungroup-selected"));
  }, [onClose, isGroup, node]);

  // 节点类型判断
  const nodeType = node?.type ?? null;
  const isSession = nodeType === "session-card";
  const isTask = nodeType === "task-card";
  const isNote = nodeType === "sticky-note" || nodeType === "text";
  const isTextNode = nodeType === "text-node";
  const isImage = nodeType === "image-node";
  const isFreeElement = isNote || isTextNode || isImage;

  const deleteLabel = isSession
    ? (ops.isTaskBoard ? "删除会话" : "移除会话卡片")
    : isTask ? "删除任务卡"
    : isGroup ? "删除分组"
    : isFreeElement ? "删除"
    : "删除";

  return (
    <div
      ref={menuRef}
      className="glass-popover"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 1200,
        minWidth: 168,
        padding: 4,
        borderRadius: 10,
        border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
        boxShadow: "0 8px 30px -8px rgba(0,0,0,0.4)",
        color: "var(--text)",
        fontSize: 12.5,
        userSelect: "none",
      }}
    >
      {edgeId &&
        (isDerivedEdge ? (
          <MenuItem disabled label="派生连线（自动生成，不可删除）" />
        ) : (
          <MenuItem danger label="删除连线" onClick={handleDeleteEdge} />
        ))}
      {node && (
        <MenuItem
          label={deleteLabel}
          danger
          onClick={handleDeleteNode}
        />
      )}
      {node && isGroup && (
        <MenuItem label="取消分组" onClick={ungroup} />
      )}
      {!node && !edgeId && multiSelect && (
        <>
          <MenuItem label="创建分组" onClick={createGroup} />
          {selHasGroup && <MenuItem label="取消分组（选中）" onClick={ungroup} />}
        </>
      )}
      {!node && !edgeId && (
        <>
          <MenuItem label="新建文字" onClick={addText} />
          <MenuItem label="新建便笺" onClick={addNote} />
          <MenuItem label="新建图片" onClick={addImage} />
          <MenuItem label="新建任务卡" onClick={addTaskCard} />
        </>
      )}
    </div>
  );
}

function MenuItem({ label, onClick, danger, disabled }: { label: string; onClick?: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        width: "100%",
        padding: "6px 10px",
        border: "none",
        borderRadius: 7,
        background: "transparent",
        color: danger ? "#ef4444" : disabled ? "var(--text-dim)" : "var(--text)",
        fontSize: 12.5,
        textAlign: "left",
        cursor: disabled ? "default" : "pointer",
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 14%, transparent)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
    >
      {label}
    </button>
  );
}
