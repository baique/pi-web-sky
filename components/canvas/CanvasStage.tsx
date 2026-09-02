"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, Controls, type NodeTypes, type OnConnect, BackgroundVariant } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { UseBoardCanvasReturn } from "@/hooks/useBoardCanvas";
import { useI18n } from "@/hooks/useI18n";
import { SessionCardNode } from "@/components/board/SessionCardNode";
import { StickyNoteNode } from "@/components/board/StickyNoteNode";
import { TaskCardNode } from "@/components/board/TaskCardNode";
import { BoardCanvasProvider, type BoardCanvasOps } from "@/components/board/BoardCanvasContext";

/**
 * React Flow 画布舞台：无限画布 + 工具行 + 拖放添加会话。
 * 数据层：useBoardCanvas（yjs Y.Doc → nodes/edges 受控）。
 * 派生元素（会话卡/exec线/依赖线）由后端 reconcile 权威维护，本组件只做展示 + 用户编辑增量。
 */

// nodeTypes / edgeTypes 必须模块级常量（引用稳定，避免每次渲染重建连接——同 tldraw useSync 教训）
const nodeTypes: NodeTypes = {
  "session-card": SessionCardNode,
  "task-card": TaskCardNode,
  "sticky-note": StickyNoteNode,
  text: StickyNoteNode, // 旧 tldraw text shape 降级为便笺渲染（data.text）
};

export function CanvasStage({ board, isDark }: { board: UseBoardCanvasReturn; isDark: boolean }) {
  const { t } = useI18n();
  const [dragOver, setDragOver] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  // 会话拖入画布：原生 dragover/drop（capture 阶段）
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onDragOverNative = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("text/session-id")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOver(true);
    };
    const onDragLeaveNative = () => setDragOver(false);
    const onDropNative = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("text/session-id")) return;
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      const sid = e.dataTransfer.getData("text/session-id");
      if (!sid) return;
      const rect = el.getBoundingClientRect();
      // 相对画布容器 → flow 坐标：RF 的 pane 坐标系以容器左上为原点（无 pan 时）
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      board.addSessionNode(sid, x, y);
    };
    el.addEventListener("dragover", onDragOverNative, true);
    el.addEventListener("dragleave", onDragLeaveNative, true);
    el.addEventListener("drop", onDropNative, true);
    return () => {
      el.removeEventListener("dragover", onDragOverNative, true);
      el.removeEventListener("dragleave", onDragLeaveNative, true);
      el.removeEventListener("drop", onDropNative, true);
    };
  }, [board]);

  // BoardCanvasOps：把 Y.Doc 写操作暴露给节点组件
  const ops = useMemo<BoardCanvasOps>(() => ({
    boardId: board.board?.id ?? null,
    updateNode: (id, patch) => {
      board.updateNode?.(id, patch);
    },
    deleteNode: (id) => {
      void board.deleteNodeWithConfirm?.({ id, type: "", data: {}, position: { x: 0, y: 0 } } as never);
    },
    addEdge: (edge) => board.addEdge?.(edge),
  }), [board]);

  // 删除：Delete/Backspace → 确认制（按节点类型）
  const onBeforeDelete = useCallback(async ({ nodes }: { nodes: Array<{ id: string }> }): Promise<boolean> => {
    if (!nodes || nodes.length === 0) return true;
    const node = nodes[0];
    // 通过 ops.deleteNode 走确认制（识别类型需要查 board.nodes）
    const full = board.nodes.find((n) => n.id === node.id);
    if (full) void board.deleteNodeWithConfirm?.(full);
    return false; // 阻止 RF 默认删除，由我们处理
  }, [board]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
      <div ref={stageRef} style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {/* 画布 scrim：内容层之下、壁纸之上的一层暗色承托 + 磨砂（与旧一致） */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 0,
            pointerEvents: "none",
            background: "var(--board-scrim-bg)",
            backdropFilter: "var(--board-scrim-filter, none)",
            WebkitBackdropFilter: "var(--board-scrim-filter, none)",
          }}
        />
        {dragOver && (
          <div style={{ position: "absolute", inset: 0, zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "color-mix(in srgb, var(--accent) 10%, transparent)", border: "2px dashed var(--accent)", borderRadius: 10, pointerEvents: "none", color: "var(--accent)", fontSize: 13, fontWeight: 600 }}>
            {t("boards.dropToAdd")}
          </div>
        )}
        {board.error ? (
          <div style={{ position: "absolute", inset: 0, zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: 13 }}>{board.error}</div>
        ) : board.loading ? (
          <div style={{ position: "absolute", inset: 0, zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(8, 14, 30, 0.85)", color: "rgba(255, 255, 255, 0.85)", fontSize: 13 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span aria-hidden style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid rgba(255, 255, 255, 0.18)", borderTopColor: "rgba(255, 255, 255, 0.9)", animation: "spin 0.8s linear infinite" }} />
              {t("boards.loadingCanvas")}
            </div>
          </div>
        ) : (
          <BoardCanvasProvider value={ops}>
            <ReactFlow
              nodes={board.nodes}
              edges={board.edges}
              onNodesChange={board.onNodesChange}
              onEdgesChange={board.onEdgesChange}
              onConnect={board.onConnect as OnConnect}
              nodeTypes={nodeTypes}
              onBeforeDelete={onBeforeDelete}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.1}
              maxZoom={2}
              colorMode={isDark ? "dark" : "light"}
              deleteKeyCode={["Backspace", "Delete"]}
              proOptions={{ hideAttribution: false }} // 保留 attribution（MIT 合规，决策点③）
              defaultEdgeOptions={{ markerEnd: { type: "arrowclosed" }, style: { strokeWidth: 1.5, stroke: "#8b8fa3" } }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="color-mix(in srgb, var(--border) 45%, transparent)" />
              <Controls position="bottom-right" showInteractive={false} />
            </ReactFlow>
          </BoardCanvasProvider>
        )}
      </div>
    </div>
  );
}
