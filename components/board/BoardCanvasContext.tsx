"use client";

/**
 * 看板画布节点操作上下文：把 Y.Doc 的 nodes/edges 写操作暴露给自定义节点组件。
 * 自定义节点（会话卡/任务卡/便笺）编辑时调用，写回 Y.Map（CRDT 增量合并 + 广播）。
 */
import { createContext, useContext } from "react";
import type { Node, Edge } from "@xyflow/react";
import type { SnapResult } from "@/lib/board-align";

export interface BoardCanvasOps {
  /** 更新节点（部分 data/style/position） */
  updateNode: (id: string, patch: Partial<Node>) => void;
  /** 防抖更新节点（表单连续输入用；窗口内合并多次 patch，400ms 一次写 yjs） */
  updateNodeDebounced: (id: string, patch: Partial<Node>, delay?: number) => void;
  /** 删除节点（确认制由调用方处理） */
  deleteNode: (id: string) => void;
  /** 规范化节点 id（新建任务卡派发后改用确定性 task-<cardId>，避免与 reconcile 重复） */
  normalizeNodeId: (oldId: string, newId: string) => void;
  /** 删除边（手绘线可删，派生边由后端 reconcile 保护） */
  deleteEdge: (id: string) => void;
  /** 新增边（连线） */
  addEdge: (edge: Edge) => void;
  /** 新增节点（新建便笺/任务卡等） */
  addNode: (node: Node) => void;
  /** 设置对齐参考线（resize/drag 时显示） */
  setSnapLines: (lines: SnapResult["lines"]) => void;
  /** 当前看板 id */
  boardId: string | null;
  /** 是否为任务看板（任务看板删会话卡=删会话本体，普通看板只删卡） */
  isTaskBoard: boolean;
}

const BoardCanvasContext = createContext<BoardCanvasOps | null>(null);

export function BoardCanvasProvider({ value, children }: { value: BoardCanvasOps; children: React.ReactNode }) {
  return <BoardCanvasContext.Provider value={value}>{children}</BoardCanvasContext.Provider>;
}

export function useBoardCanvasOps(): BoardCanvasOps {
  const ctx = useContext(BoardCanvasContext);
  if (!ctx) return { updateNode: () => {}, updateNodeDebounced: () => {}, deleteNode: () => {}, normalizeNodeId: () => {}, deleteEdge: () => {}, addEdge: () => {}, addNode: () => {}, setSnapLines: () => {}, boardId: null, isTaskBoard: false };
  return ctx;
}
