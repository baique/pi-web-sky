"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, useReactFlow, type NodeTypes, type OnConnect, BackgroundVariant, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { UseBoardCanvasReturn } from "@/hooks/useBoardCanvas";
import { useI18n } from "@/hooks/useI18n";
import { SessionCardNode } from "@/components/board/SessionCardNode";
import { StickyNoteNode } from "@/components/board/StickyNoteNode";
import { TaskCardNode } from "@/components/board/TaskCardNode";
import { BoardCanvasProvider, type BoardCanvasOps } from "@/components/board/BoardCanvasContext";
import { BoardContextMenu, type BoardMenuState } from "@/components/board/BoardContextMenu";

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
  // RF 坐标转换：屏幕坐标（clientX/Y）→ flow 坐标（节点 position）。
  // 新建节点/拖放落点都经它换算，保证放到“鼠标所指/视口中心”的位置。
  const { screenToFlowPosition } = useReactFlow();
  const [dragOver, setDragOver] = useState(false);
  // 右键菜单 state
  const [menu, setMenu] = useState<BoardMenuState | null>(null);

  // BoardCanvasOps：把 Y.Doc 写操作暴露给节点组件
  const ops = useMemo<BoardCanvasOps>(() => ({
    boardId: board.board?.id ?? null,
    updateNode: (id, patch) => {
      board.updateNode?.(id, patch);
    },
    deleteNode: (id) => {
      // 传完整 node 给确认制（识别类型决定删会话/任务卡/便笺），不能只传 id
      const full = board.nodes.find((n) => n.id === id);
      if (full) void board.deleteNodeWithConfirm?.(full);
    },
    normalizeNodeId: (oldId, newId) => {
      board.normalizeNodeId?.(oldId, newId);
    },
    deleteEdge: (id) => {
      // 复用 onEdgesChange 的 remove（派生边由后端 reconcile 保护，此处自动跳过）
      board.onEdgesChange?.([{ type: "remove", id }]);
    },
    addEdge: (edge) => board.addEdge?.(edge),
    addNode: (node) => board.addNode?.(node),
  }), [board]);

  // 新建便笺/任务卡：拖放落点或点击视口中心（flow 坐标）
  const addNodeAt = useCallback((type: "sticky-note" | "task-card", flowPos: { x: number; y: number }) => {
    if (type === "sticky-note") {
      ops.addNode({ id: crypto.randomUUID(), type, position: { x: flowPos.x, y: flowPos.y }, style: { width: 380, height: 280 }, data: { text: "", badge: "blue" } });
    } else {
      ops.addNode({ id: crypto.randomUUID(), type, position: { x: flowPos.x, y: flowPos.y }, style: { width: 380, height: 270 }, data: { cardId: "", number: 0, name: "新建任务", description: "", readyStatus: "draft", execStatus: "not_started", priority: 0, expanded: false, w: 380, h: 270, expandedW: 0, expandedH: 0, collapsedW: 0, collapsedH: 0 } });
    }
  }, [ops]);

  // 点击工具栏按钮：节点出现在当前视口中心（方便用户继续调整位置）
  const addNodeAtViewportCenter = useCallback((type: "sticky-note" | "task-card") => {
    const pane = document.querySelector(".react-flow__pane");
    const rect = pane?.getBoundingClientRect();
    const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    addNodeAt(type, screenToFlowPosition({ x: cx, y: cy }));
  }, [addNodeAt, screenToFlowPosition]);

  // 工具栏按钮拖拽：标记工具类型（text/board-tool），画布 drop 时按落点创建
  const onToolDragStart = useCallback((e: React.DragEvent, tool: string) => {
    e.dataTransfer.setData("text/board-tool", tool);
    e.dataTransfer.effectAllowed = "copy";
  }, []);

  // 会话/工具拖入画布 —— React Flow 官方 DragAndDrop 示例写法：
  // onDragOver / onDrop 直接作为 <ReactFlow> 的 props。
  // ReactFlowProps extends HTMLAttributes<HTMLDivElement>，RF 透传到画布根容器。
  const onDragOver = useCallback((e: React.DragEvent) => {
    // 官方示例：无条件 preventDefault，保持画布为可 drop 目标
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const types = e.dataTransfer?.types ?? [];
    setDragOver(types.includes("text/session-id") || types.includes("text/board-tool"));
  }, []);
  const onDrop = useCallback((e: React.DragEvent) => {
    const types = e.dataTransfer?.types ?? [];
    if (!types.includes("text/session-id") && !types.includes("text/board-tool")) return;
    e.preventDefault();
    setDragOver(false);
    const dt = e.dataTransfer;
    if (!dt) return;
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const sid = dt.getData("text/session-id");
    if (sid) {
      // 任务看板拖入 = 加入任务：addSessionNode 内部先落卡再异步归属（防 reconcile 当孤儿删）
      board.addSessionNode(sid, pos.x, pos.y);
      return;
    }
    const tool = dt.getData("text/board-tool");
    if (tool === "sticky-note") addNodeAt("sticky-note", pos);
    else if (tool === "task-card") addNodeAt("task-card", pos);
  }, [board, screenToFlowPosition, addNodeAt]);

  // 删除：Delete/Backspace → 确认制（按节点类型）
  const onBeforeDelete = useCallback(async ({ nodes }: { nodes: Array<{ id: string }> }): Promise<boolean> => {
    if (!nodes || nodes.length === 0) return true;
    const node = nodes[0];
    // 通过 ops.deleteNode 走确认制（识别类型需要查 board.nodes）
    const full = board.nodes.find((n) => n.id === node.id);
    if (full) void board.deleteNodeWithConfirm?.(full);
    return false; // 阻止 RF 默认删除，由我们处理
  }, [board]);

  // 双击空白 → 添加便笺（替代 RF 默认双击缩放）。
  // RF 12 无 onPaneDoubleClick，用 onPaneClick 手动判连续两次快速点击（只在空白触发，天然排除节点）。
  const lastPaneClickRef = useRef<{ t: number } | null>(null);
  const onPaneClick = useCallback((e: React.MouseEvent) => {
    setMenu(null);
    const now = Date.now();
    const last = lastPaneClickRef.current;
    if (last && now - last.t < 320) {
      lastPaneClickRef.current = null;
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addNodeAt("sticky-note", pos);
      return;
    }
    lastPaneClickRef.current = { t: now };
  }, [screenToFlowPosition, addNodeAt]);

  // 右键菜单 handlers
  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, node, edgeId: null });
  }, []);
  const onPaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, node: null, edgeId: null });
  }, []);
  const onEdgeContextMenu = useCallback((e: React.MouseEvent, edge: { id: string }) => {
    e.preventDefault();
    // 找到 edge 的 data 判断派生边
    const full = board.edges.find((ed) => ed.id === edge.id);
    const d = full?.data as { execLink?: boolean; taskLink?: string } | undefined;
    setMenu({ x: e.clientX, y: e.clientY, node: null, edgeId: full?.id ?? null, edgeDerived: Boolean(d?.execLink || d?.taskLink) });
  }, [board.edges]);

  // 工具栏：新建便笺/任务（去掉文本工具）—— 点击=当前视口中心创建，拖拽=拖放进画布落点创建
  const addNodeAtViewport = useCallback((type: "sticky-note" | "task-card") => {
    addNodeAtViewportCenter(type);
  }, [addNodeAtViewportCenter]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
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
              onDragOver={onDragOver}
              onDrop={onDrop}
              onNodeContextMenu={onNodeContextMenu}
              onPaneContextMenu={onPaneContextMenu}
              onEdgeContextMenu={onEdgeContextMenu}
              onPaneClick={onPaneClick}
              zoomOnDoubleClick={false}
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
              <Controls position="bottom-left" showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                style={{
                  background: "var(--board-card-glass)",
                  backdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
                  WebkitBackdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
                  border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
                  borderRadius: 12,
                  boxShadow: "0 2px 12px -6px rgba(0,0,0,0.18)",
                  overflow: "hidden",
                }}
                maskColor="color-mix(in srgb, var(--board-card-glass) 78%, transparent)"
                nodeColor={() => "color-mix(in srgb, var(--accent) 50%, transparent)"}
                nodeStrokeColor={() => "var(--accent)"}
              />
            </ReactFlow>
            {menu && <BoardContextMenu menu={menu} onClose={() => setMenu(null)} />}
            {/* 工具栏：便笺/任务（底部居中玻璃浮层）。点击=当前视口中心创建；拖拽=拖放进画布落点创建 */}
            <div style={{ position: "absolute", left: "50%", transform: "translateX(-50%)", bottom: 16, zIndex: 30, display: "flex", gap: 4, padding: 4, borderRadius: 10, background: "var(--board-card-glass)", backdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))", WebkitBackdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 2px 12px -6px rgba(0,0,0,0.18)" }}>
              <ToolbarBtn label="便笺" onClick={() => addNodeAtViewport("sticky-note")} onDragStart={(e) => onToolDragStart(e, "sticky-note")} />
              <ToolbarBtn label="任务" onClick={() => addNodeAtViewport("task-card")} onDragStart={(e) => onToolDragStart(e, "task-card")} />
            </div>
          </BoardCanvasProvider>
        )}
      </div>
    </div>
  );
}

function ToolbarBtn({ label, onClick, onDragStart }: { label: string; onClick: () => void; onDragStart: (e: React.DragEvent) => void }) {
  return (
    <button
      type="button"
      draggable
      title={label}
      aria-label={label}
      onClick={onClick}
      onDragStart={onDragStart}
      style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "6px 14px", border: "none", borderRadius: 7, background: "transparent", color: "var(--text-muted)", fontSize: 12.5, cursor: "grab", userSelect: "none", transition: "background 0.12s, color 0.12s" }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 12%, transparent)"; e.currentTarget.style.color = "var(--accent)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
    >
      {label}
    </button>
  );
}
