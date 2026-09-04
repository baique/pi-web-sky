"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, useReactFlow, type NodeTypes, type OnConnect, BackgroundVariant, type Node, type Viewport } from "@xyflow/react";
import { computeSnap, type SnapResult } from "@/lib/board-align";
import "@xyflow/react/dist/style.css";
import type { UseBoardCanvasReturn } from "@/hooks/useBoardCanvas";
import { useI18n } from "@/hooks/useI18n";
import { SessionCardNode } from "@/components/board/SessionCardNode";
import { StickyNoteNode } from "@/components/board/StickyNoteNode";
import { TaskCardNode } from "@/components/board/TaskCardNode";
import { BoardCanvasProvider, type BoardCanvasOps } from "@/components/board/BoardCanvasContext";
import { BoardContextMenu, type BoardMenuState } from "@/components/board/BoardContextMenu";
import { BoardLoading } from "./BoardLoading";

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
  const { screenToFlowPosition, setViewport, getNodes, getViewport } = useReactFlow();
  const [dragOver, setDragOver] = useState(false);
  // 右键菜单 state
  const [menu, setMenu] = useState<BoardMenuState | null>(null);
  // 对齐参考线
  const [snapLines, setSnapLines] = useState<SnapResult["lines"]>([]);

  // 画布位置记忆：synced 后设到 yjs 记住的位置
  useEffect(() => {
    if (!board.ready) return;
    setViewport(board.viewport);
  }, [board.ready, board.viewport, setViewport]);

  // BoardCanvasOps：把 Y.Doc 写操作暴露给节点组件
  const ops = useMemo<BoardCanvasOps>(() => ({
    boardId: board.board?.id ?? null,
    isTaskBoard: Boolean(board.board?.taskId),
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
    setSnapLines: (lines) => setSnapLines(lines),
  }), [board]);

  // 新建便笺/任务卡：拖放落点或点击视口中心（flow 坐标）
  const addNodeAt = useCallback((type: "sticky-note" | "task-card", flowPos: { x: number; y: number }) => {
    if (type === "sticky-note") {
      ops.addNode({ id: crypto.randomUUID(), type, position: { x: flowPos.x, y: flowPos.y }, style: { width: 380, height: 280 }, data: { text: "", badge: "blue" } });
    } else {
      ops.addNode({ id: crypto.randomUUID(), type, position: { x: flowPos.x, y: flowPos.y }, style: { width: 380, height: 270 }, data: { cardId: "", number: 0, name: "新建任务", description: "", readyStatus: "draft", priority: 0, expanded: false, w: 380, h: 270, expandedW: 0, expandedH: 0, collapsedW: 0, collapsedH: 0 } });
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

  // 会话/工具拖入画布 —— 原生 capture 监听挂外层容器（覆盖工具栏/浮层等 RF 外元素）。
  // 用 capture 而非 React Flow props：props 只挂在 RF 根容器，松手在工具栏等兄弟浮层上时
  // drop 不会触发；外层容器 capture 阶段先于一切子元素拿到事件，任何落点都能收到。
  // stageRef 挂在画布外层容器（含工具栏），drop 位置经 screenToFlowPosition 换算。
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onDragOver = (e: DragEvent) => {
      const types = e.dataTransfer?.types ?? [];
      if (!types.includes("text/session-id") && !types.includes("text/board-tool")) return;
      e.preventDefault();
      if (e.dataTransfer) {
        // dropEffect 必须与拖拽源的 effectAllowed 匹配，否则浏览器会取消 drop（dragend 无 drop）：
        // 会话源声明 move、工具栏工具源声明 copy，各自匹配，不能一刀切成 move。
        e.dataTransfer.dropEffect = types.includes("text/board-tool") ? "copy" : "move";
      }
      setDragOver(true);
    };
    // 拖出画布 / 拖拽结束（含 Escape 取消）都要复位，避免“松手添加”浮层卡死。
    // relatedTarget 判定：移入容器内子元素（如 pane）不算离开，否则浮层会随 dragleave 闪断。
    const onDragLeave = (e: DragEvent) => {
      // 用 Element 而非 Node（Node 被 @xyflow/react 的类型占用）；
      // 移入容器内子元素（如 pane）不算离开，否则浮层会随 dragleave 闪断。
      const rt = e.relatedTarget as Element | null;
      if (rt && el.contains(rt)) return;
      setDragOver(false);
    };
    const onDragEnd = () => setDragOver(false);
    const onDrop = (e: DragEvent) => {
      const types = e.dataTransfer?.types ?? [];
      if (!types.includes("text/session-id") && !types.includes("text/board-tool")) return;
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      const dt = e.dataTransfer;
      if (!dt) return;
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const sid = dt.getData("text/session-id");
      if (sid) {
        // 任务看板拖入 = 加入任务：addSessionNode 内部先写 session_meta 归属、成功才落卡
        // （失败不落卡，不留无保护窗口卡）
        void board.addSessionNode(sid, pos.x, pos.y);
        return;
      }
      const tool = dt.getData("text/board-tool");
      if (tool === "sticky-note") addNodeAt("sticky-note", pos);
      else if (tool === "task-card") addNodeAt("task-card", pos);
    };
    el.addEventListener("dragover", onDragOver, true);
    el.addEventListener("dragleave", onDragLeave, true);
    el.addEventListener("dragend", onDragEnd, true);
    el.addEventListener("drop", onDrop, true);
    return () => {
      el.removeEventListener("dragover", onDragOver, true);
      el.removeEventListener("dragleave", onDragLeave, true);
      el.removeEventListener("dragend", onDragEnd, true);
      el.removeEventListener("drop", onDrop, true);
    };
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

  // 位置记忆：pan/zoom 结束保存
  const onMoveEnd = useCallback((_e: MouseEvent | TouchEvent | null, vp: Viewport) => {
    board.saveViewport?.(vp);
  }, [board]);

  // 右键菜单 handlers
  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, node, edgeId: null });
  }, []);
  const onPaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, node: null, edgeId: null });
  }, []);
  // 对齐参考线 handlers
  // draggingRef：守卫 onNodeDrag——拖拽停止后（含吸附修正引发的受控位置更新）
  // 迟到的 onNodeDrag 不得再画线，否则会把刚清空的参考线又画回来（抬起不消失）。
  const draggingRef = useRef(false);
  const onNodeDragStart = useCallback((_: MouseEvent | TouchEvent, node: Node) => {
    draggingRef.current = true;
    setSnapLines([]);
  }, []);

  const onNodeDrag = useCallback((_: MouseEvent | TouchEvent, node: Node) => {
    if (!draggingRef.current) return;
    const snap = computeSnap(node.id, node.position, getNodes());
    setSnapLines(snap.lines);
  }, [getNodes]);

  const onNodeDragStop = useCallback(
    (_: MouseEvent | TouchEvent, node: Node) => {
      draggingRef.current = false;
      const snap = computeSnap(node.id, node.position, getNodes());
      if (snap.snapX !== null || snap.snapY !== null) {
        board.updateNode?.(node.id, {
          position: { x: snap.snapX ?? node.position.x, y: snap.snapY ?? node.position.y },
        });
      }
      setSnapLines([]);
      // 吸附修正后 yjs 同步可能再次触发 onNodeDrag（见 draggingRef 注释），
      // rAF 兜底再清一次，确保参考线在本次事件循环后一定消失。
      requestAnimationFrame(() => setSnapLines([]));
    },
    [board, getNodes],
  );
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

  // Undo/Redo 键盘快捷键：Ctrl+Z / Ctrl+Shift+Z（仅在画布聚焦时生效）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        board.undo?.();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        board.redo?.();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
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
          <BoardLoading label={t("boards.loadingCanvas")} />
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
              onNodeContextMenu={onNodeContextMenu}
              onPaneContextMenu={onPaneContextMenu}
              onEdgeContextMenu={onEdgeContextMenu}
              onPaneClick={onPaneClick}
              onMoveEnd={onMoveEnd}
              onNodeDragStart={onNodeDragStart}
              onNodeDrag={onNodeDrag}
              onNodeDragStop={onNodeDragStop}
              zoomOnDoubleClick={false}
              minZoom={0.1}
              maxZoom={2}
              colorMode={isDark ? "dark" : "light"}
              // 不做 RF 级 onlyRenderVisibleElements：整卡卸载会让拖拽出视口的卡瞬间销毁重建（事件阻塞假卡顿）。
              // 离屏按需挂载下沉到 SessionCardNode 内部（外壳常驻 + 工作台 IO 缓冲挂载），见 SessionCardNode。
              deleteKeyCode={["Backspace", "Delete"]}
              proOptions={{ hideAttribution: false }} // 保留 attribution（MIT 合规，决策点③）
              defaultEdgeOptions={{ markerEnd: { type: "arrowclosed" }, style: { strokeWidth: 1.5, stroke: "#8b8fa3" } }}
            >
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
              {snapLines.length > 0 && (() => {
                const vp = getViewport();
                return (
                  <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible", zIndex: 20, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`, transformOrigin: "0 0" }}>
                    {snapLines.map((line, i) => (
                      <line
                        key={i}
                        className="board-align-line"
                        x1={line.x1}
                        y1={line.y1}
                        x2={line.x2}
                        y2={line.y2}
                        stroke="var(--accent)"
                        strokeWidth={1.2}
                        strokeDasharray="4 3"
                        opacity={0.7}
                      />
                    ))}
                  </svg>
                );
              })()}
            </ReactFlow>
            {menu && <BoardContextMenu menu={menu} onClose={() => setMenu(null)} />}
            {/* 工具栏：便笺/任务（底部居中玻璃浮层）。点击=当前视口中心创建；拖拽=拖放进画布落点创建 */}
            <div style={{ position: "absolute", left: "50%", transform: "translateX(-50%)", bottom: 16, zIndex: 30, display: "flex", gap: 4, padding: 4, borderRadius: 10, background: "var(--board-card-glass)", backdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))", WebkitBackdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 2px 12px -6px rgba(0,0,0,0.18)" }}>
              <ToolbarBtn label="便笺" onClick={() => addNodeAtViewport("sticky-note")} onDragStart={(e) => onToolDragStart(e, "sticky-note")} />
              <ToolbarBtn label="任务" onClick={() => addNodeAtViewport("task-card")} onDragStart={(e) => onToolDragStart(e, "task-card")} />
              <span style={{ width: 1, height: 18, background: "color-mix(in srgb, var(--border) 70%, transparent)", margin: "0 2px" }} />
              <ToolbarBtn label="撤销" onClick={() => board.undo?.()} draggable={false} />
              <ToolbarBtn label="重做" onClick={() => board.redo?.()} draggable={false} />
            </div>
          </BoardCanvasProvider>
        )}
      </div>
    </div>
  );
}

function ToolbarBtn({ label, onClick, onDragStart, draggable: draggableProp = true }: { label: string; onClick: () => void; onDragStart?: (e: React.DragEvent) => void; draggable?: boolean }) {
  return (
    <button
      type="button"
      draggable={draggableProp}
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
