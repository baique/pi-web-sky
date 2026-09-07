"use client";

/**
 * 看板右键菜单（玻璃配方）—— 替代 tldraw SyncedContextMenu。
 * - 节点右键：删除（会话/任务卡走确认制，便笺/文字/图片直接删）
 * - 派生边右键：只读提示（exec/依赖线由后端 reconcile 权威维护，不可删）
 * - 空白右键：新建便笺 / 新建任务卡 / 新建图片
 */
import { useCallback, useEffect, useRef } from "react";
import type { Node } from "@xyflow/react";
import { useBoardCanvasOps } from "@/components/board/BoardCanvasContext";

export interface BoardMenuState {
  /** 菜单渲染位置（screen 坐标，用于 fixed 定位菜单本体） */
  x: number;
  y: number;
  /** 新建节点落点（flow 坐标，已由 CanvasStage screenToFlowPosition 换算；
   * 与 x/y 分离——同一 screen 坐标不能当 flow 坐标用，平移/缩放后会错位） */
  flowX?: number;
  flowY?: number;
  node: Node | null;
  edgeId: string | null;
  /** 边是否为派生边（exec/依赖线，由后端 reconcile 权威维护，不可删） */
  edgeDerived?: boolean;
}

export function BoardContextMenu({ menu, onClose }: { menu: BoardMenuState; onClose: () => void }) {
  const ops = useBoardCanvasOps();
  const { node, edgeId, x, y, flowX, flowY, edgeDerived } = menu;
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
      position: { x: flowX ?? 0, y: flowY ?? 0 },
      style: { width: 380, height: 280 },
      data: { text: "", badge: "blue", emoji: "📝", autofocus: true },
    });
    onClose();
  }, [ops, flowX, flowY, onClose]);

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
      position: { x: flowX ?? 0, y: flowY ?? 0 },
      style: { width: 380, height: 270 },
      data: {
        cardId: "", number: 0, name: "新建任务", description: "",
        readyStatus: "draft", priority: 0,
        expanded: false, w: 380, h: 270, expandedW: 0, expandedH: 0, collapsedW: 0, collapsedH: 0,
        emoji: "✅",
      },
    });
    onClose();
  }, [ops, flowX, flowY, onClose]);

  // ---- 分组相关（已移除）：多选创建分组 / 取消分组不再支持 ----
  // 节点类型判断
  const nodeType = node?.type ?? null;
  const isSession = nodeType === "session-card";
  const isTask = nodeType === "task-card";
  const isNote = nodeType === "sticky-note" || nodeType === "text" || nodeType === "text-node"; // text-node 旧数据降级为便笺渲染
  const isImage = nodeType === "image-node";
  const isFreeElement = isNote || isImage;

  const deleteLabel = isSession
    ? (ops.isTaskBoard ? "删除会话" : "移除会话卡片")
    : isTask ? "删除任务卡"
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
      {!node && !edgeId && (
        <>
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
