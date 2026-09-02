"use client";

/**
 * 看板画布节点操作上下文：把 Y.Doc 的 nodes/edges 写操作暴露给自定义节点组件。
 * 自定义节点（会话卡/任务卡/便笺）编辑时调用，写回 Y.Map（CRDT 增量合并 + 广播）。
 */
import { createContext, useContext } from "react";
import type { Node, Edge } from "@xyflow/react";

export interface BoardCanvasOps {
  /** 更新节点（部分 data/style/position） */
  updateNode: (id: string, patch: Partial<Node>) => void;
  /** 删除节点（确认制由调用方处理） */
  deleteNode: (id: string) => void;
  /** 删除边（手绘线可删，派生边由后端 reconcile 保护） */
  deleteEdge: (id: string) => void;
  /** 新增边（连线） */
  addEdge: (edge: Edge) => void;
  /** 新增节点（新建便笺/任务卡等） */
  addNode: (node: Node) => void;
  /** 当前看板 id */
  boardId: string | null;
}

const BoardCanvasContext = createContext<BoardCanvasOps | null>(null);

export function BoardCanvasProvider({ value, children }: { value: BoardCanvasOps; children: React.ReactNode }) {
  return <BoardCanvasContext.Provider value={value}>{children}</BoardCanvasContext.Provider>;
}

export function useBoardCanvasOps(): BoardCanvasOps {
  const ctx = useContext(BoardCanvasContext);
  if (!ctx) return { updateNode: () => {}, deleteNode: () => {}, deleteEdge: () => {}, addEdge: () => {}, addNode: () => {}, boardId: null };
  return ctx;
}
