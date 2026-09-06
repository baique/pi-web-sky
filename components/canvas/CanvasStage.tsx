"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, MiniMap, useReactFlow, type NodeTypes, type EdgeTypes, type OnConnect, type Node, type Viewport } from "@xyflow/react";
import { computeSnap, type SnapResult } from "@/lib/board-align";
import "@xyflow/react/dist/style.css";
import type { UseBoardCanvasReturn } from "@/hooks/useBoardCanvas";
import { useI18n } from "@/hooks/useI18n";
import { SessionCardNode } from "@/components/board/SessionCardNode";
import { StickyNoteNode } from "@/components/board/StickyNoteNode";
import { TaskCardNode } from "@/components/board/TaskCardNode";
import { TextNode } from "@/components/board/TextNode";
import { ImageNode } from "@/components/board/ImageNode";
import { SendNoteEdge } from "@/components/board/SendNoteEdge";
import { BoardCanvasProvider, type BoardCanvasOps } from "@/components/board/BoardCanvasContext";
import { BoardContextMenu, type BoardMenuState } from "@/components/board/BoardContextMenu";
import { BoardLoading } from "./BoardLoading";
import { BoardControls } from "./BoardControls";
import { uploadBoardImage } from "@/lib/board-assets";
import { dispatchBoardCwdSwitch } from "@/lib/board-events";
import { boardFloatGlass } from "./board-glass";

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
  "text-node": TextNode,
  "image-node": ImageNode,
};

// 发送线（便笺/文本 → 会话卡）：线上「发送」按钮 + 一次性标记
const edgeTypes: EdgeTypes = {
  "send-note": SendNoteEdge,
};

// 工具栏可创建的「自由元素」类型（无业务表依赖，纯画布内容）
export type FreeNodeType = "sticky-note" | "text-node" | "task-card" | "image-node";

// 剪贴板数据标记：看板节点复制
const BOARD_CLIP_MIME = "application/x-pi-board-nodes";

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
  // 图片文件选择 input（工具栏「图片」按钮触发）
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 画布位置记忆：只在看板 ready（进入/切换）时恢复 yjs 记住的位置一次。
  // 不做持续覆盖（不监听 board.viewport 变化）——否则 running 轮询等 yjs 回灌
  // 会触发本 effect 用旧值 setViewport，覆盖用户拖拽/定位的当前视口（回跳/定位失效）。
  useEffect(() => {
    if (!board.ready) return;
    setViewport(board.viewport);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅 ready 时恢复一次
  }, [board.ready]);

  // BoardCanvasOps：把 Y.Doc 写操作暴露给节点组件
  const ops = useMemo<BoardCanvasOps>(() => ({
    boardId: board.board?.id ?? null,
    isTaskBoard: Boolean(board.board?.taskId),
    updateNode: (id, patch) => {
      board.updateNode?.(id, patch);
    },
    updateNodeDebounced: (id, patch, delay) => {
      board.updateNodeDebounced?.(id, patch, delay);
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
    updateEdge: (id, patch) => board.updateEdge?.(id, patch),
    addNode: (node) => board.addNode?.(node),
    setSnapLines: (lines) => setSnapLines(lines),
  }), [board]);

  /** 新建自由元素（便笺/文字/任务卡/图片）：拖放落点或视口中心（flow 坐标） */
  const addNodeAt = useCallback((type: FreeNodeType, flowPos: { x: number; y: number }, extra?: { src?: string; naturalW?: number; naturalH?: number; name?: string }) => {
    const id = crypto.randomUUID();
    if (type === "sticky-note") {
      ops.addNode({ id, type, position: { x: flowPos.x, y: flowPos.y }, style: { width: 380, height: 280 }, data: { text: "", badge: "blue", emoji: "📝" } });
    } else if (type === "text-node") {
      ops.addNode({ id, type, position: { x: flowPos.x, y: flowPos.y }, style: { width: 240, height: 60 }, data: { text: "", autofocus: true } });
    } else if (type === "task-card") {
      ops.addNode({ id, type, position: { x: flowPos.x, y: flowPos.y }, style: { width: 380, height: 270 }, data: { cardId: "", number: 0, name: "新建任务", description: "", readyStatus: "draft", priority: 0, expanded: false, w: 380, h: 270, expandedW: 0, expandedH: 0, collapsedW: 0, collapsedH: 0, emoji: "✅" } });
    } else if (type === "image-node" && extra?.src) {
      // 图片：有原始尺寸按等比（最长边 400）落位；无则默认 240x180
      let w = 240;
      let h = 180;
      if (extra.naturalW && extra.naturalH) {
        const maxSide = 400;
        const ratio = Math.min(1, maxSide / Math.max(extra.naturalW, extra.naturalH));
        w = Math.max(80, Math.round(extra.naturalW * ratio));
        h = Math.max(80, Math.round(extra.naturalH * ratio));
      }
      ops.addNode({ id, type, position: { x: flowPos.x, y: flowPos.y }, style: { width: w, height: h }, data: { src: extra.src, naturalW: extra.naturalW, naturalH: extra.naturalH, name: extra.name } });
    }
  }, [ops]);

  /** 图片上传 + 落点建卡（工具栏按钮/拖放文件/粘贴共用） */
  const addImageFromFile = useCallback(async (file: File, flowPos: { x: number; y: number }) => {
    const src = await uploadBoardImage(file);
    if (!src) return;
    // 预读原始尺寸（等比落位）
    const natural: { naturalW?: number; naturalH?: number } = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ naturalW: img.naturalWidth, naturalH: img.naturalHeight });
      img.onerror = () => resolve({});
      img.src = src;
    });
    addNodeAt("image-node", flowPos, { src, name: file.name, ...natural });
  }, [addNodeAt]);

  /** 点击工具栏按钮：节点出现在当前视口中心（方便用户继续调整位置） */
  const addNodeAtViewportCenter = useCallback((type: FreeNodeType) => {
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
      const hasFileImage = Array.from(e.dataTransfer?.files ?? []).some((f) => f.type.startsWith("image/"));
      if (!types.includes("text/session-id") && !types.includes("text/board-tool") && !hasFileImage) return;
      e.preventDefault();
      if (e.dataTransfer) {
        // dropEffect 必须与拖拽源的 effectAllowed 匹配，否则浏览器会取消 drop（dragend 无 drop）：
        // 会话源声明 move、工具栏工具源声明 copy、文件复制 copy，各自匹配，不能一刀切成 move。
        e.dataTransfer.dropEffect = hasFileImage || types.includes("text/board-tool") ? "copy" : "move";
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
      const dt = e.dataTransfer;
      const hasFileImage = Array.from(dt?.files ?? []).some((f) => f.type.startsWith("image/"));
      if (!types.includes("text/session-id") && !types.includes("text/board-tool") && !hasFileImage) return;
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (!dt) return;
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      // 图片文件：上传并贴图
      const images = Array.from(dt.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (images.length > 0) {
        images.forEach((f, i) => {
          void addImageFromFile(f, { x: pos.x + i * 20, y: pos.y + i * 20 });
        });
        return;
      }
      const sid = dt.getData("text/session-id");
      if (sid) {
        // 任务看板拖入 = 加入任务：addSessionNode 内部先写 session_meta 归属、成功才落卡
        // （失败不落卡，不留无保护窗口卡）
        void board.addSessionNode(sid, pos.x, pos.y);
        return;
      }
      const tool = dt.getData("text/board-tool");
      if (tool === "sticky-note") addNodeAt("sticky-note", pos);
      else if (tool === "text-node") addNodeAt("text-node", pos);
      else if (tool === "task-card") addNodeAt("task-card", pos);
      else if (tool === "image-node") {
        // 图片工具按钮拖拽：打开文件选择（拖拽本身不携带文件）
        fileInputRef.current?.click();
      } else if (tool === "session-card") {
        board.addNewSessionCard(pos);
      }
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
  }, [board, screenToFlowPosition, addNodeAt, addImageFromFile]);

  // 删除：Delete/Backspace → 确认制（按节点类型）；多选时逐个处理（每个类型走各自确认）
  const onBeforeDelete = useCallback(async ({ nodes }: { nodes: Array<{ id: string }> }): Promise<boolean> => {
    if (!nodes || nodes.length === 0) return true;
    for (const node of nodes) {
      const full = board.nodes.find((n) => n.id === node.id);
      if (full) void board.deleteNodeWithConfirm?.(full);
    }
    return false; // 阻止 RF 默认删除，由我们处理
  }, [board]);

  // 双击空白 → 添加文字（替代 RF 默认双击缩放 / 旧逻辑的便笺）。
  // RF 12 无 onPaneDoubleClick，用 onPaneClick 手动判连续两次快速点击（只在空白触发，天然排除节点）。
  const lastPaneClickRef = useRef<{ t: number } | null>(null);
  const onPaneClick = useCallback((e: React.MouseEvent) => {
    setMenu(null);
    const now = Date.now();
    const last = lastPaneClickRef.current;
    if (last && now - last.t < 320) {
      lastPaneClickRef.current = null;
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addNodeAt("text-node", pos);
      return;
    }
    lastPaneClickRef.current = { t: now };
  }, [screenToFlowPosition, addNodeAt]);

  // 位置记忆：pan/zoom 结束保存
  const onMoveEnd = useCallback((_e: MouseEvent | TouchEvent | null, vp: Viewport) => {
    board.saveViewport?.(vp);
  }, [board]);

  // 右键菜单 handlers：菜单本体用 screen 坐标定位（fixed）；新建节点落点用
  // screenToFlowPosition 换算的 flow 坐标（同一 screen 坐标不能当 flow 坐标用，
  // 平移/缩放后落点会错位）。
  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault();
    const fp = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    setMenu({ x: e.clientX, y: e.clientY, flowX: fp.x, flowY: fp.y, node, edgeId: null });
  }, [screenToFlowPosition]);
  const onPaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    const fp = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    setMenu({ x: e.clientX, y: e.clientY, flowX: fp.x, flowY: fp.y, node: null, edgeId: null });
  }, [screenToFlowPosition]);
  // 对齐参考线 handlers
  // draggingRef：守卫 onNodeDrag——拖拽停止后（含吸附修正引发的受控位置更新）
  // 迟到的 onNodeDrag 不得再画线，否则会把刚清空的参考线又画回来（抬起不消失）。
  const draggingRef = useRef(false);
  const onNodeDragStart = useCallback(() => {
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
      // 拖拽期间 position 只更新本地 state（见 useBoardCanvas onNodesChange position 分支），
      // 松手时一次性写入 yjs 最终位置（含吸附修正）——避免每帧写导致 CRDT 历史爆炸。
      board.updateNode?.(node.id, {
        position: { x: snap.snapX ?? node.position.x, y: snap.snapY ?? node.position.y },
      });
      setSnapLines([]);
      // 吸附修正后 yjs 同步可能再次触发 onNodeDrag（见 draggingRef 注释），
      // rAF 兜底再清一次，确保参考线在本次事件循环后一定消失。
      requestAnimationFrame(() => setSnapLines([]));
    },
    [board, getNodes],
  );
  // 单击已展开的会话卡 = 激活该会话 → 触发全局标准切换（左侧文件区跟随该会话 worktree）。
  // 约定：仅展开态会话卡单击；收起态/新建占位卡不触发。RF onNodeClick 在 wrapper 层捕获，拖拽不误触。
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (node.type !== "session-card") return;
    const d = node.data as Record<string, unknown> | undefined;
    if (!d || !d.sessionId) return;
    const sessionId = String(d.sessionId);
    const expanded = Boolean(d.expanded);
    if (!expanded) return;
    if (d.cwd) return; // 新建占位卡不是激活既有会话
    const summary = board.sessionTitles?.[sessionId];
    const actCwd = summary?.cwd || summary?.projectRoot || "";
    if (actCwd) dispatchBoardCwdSwitch(actCwd);
  }, [board.sessionTitles]);

  const onEdgeContextMenu = useCallback((e: React.MouseEvent, edge: { id: string }) => {
    e.preventDefault();
    // 找到 edge 的 data 判断派生边
    const full = board.edges.find((ed) => ed.id === edge.id);
    const d = full?.data as { execLink?: boolean; taskLink?: string } | undefined;
    const fp = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    setMenu({ x: e.clientX, y: e.clientY, flowX: fp.x, flowY: fp.y, node: null, edgeId: full?.id ?? null, edgeDerived: Boolean(d?.execLink || d?.taskLink) });
  }, [board.edges, screenToFlowPosition]);

  // 工具栏：新建便笺/任务/文字/图片/会话 —— 点击=当前视口中心创建，拖拽=拖放进画布落点创建
  const addNodeAtViewport = useCallback((type: FreeNodeType) => {
    addNodeAtViewportCenter(type);
  }, [addNodeAtViewportCenter]);

  // 会话：点击=视口中心新建会话卡（复用 BoardTopbar 同款视口中心换算）
  const addSessionAtViewportCenter = useCallback(() => {
    const pane = document.querySelector(".react-flow__pane");
    const rect = pane?.getBoundingClientRect();
    if (!rect) return;
    const flowPos = screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    board.addNewSessionCard(flowPos);
  }, [board, screenToFlowPosition]);

  // ---- 复制/粘贴（除会话卡外）：Ctrl+C / Ctrl+V ----
  // 复制：选中的非会话卡节点序列化为 JSON（含类型/data/style，剥 UI 态）。
  // 任务卡只复制表单内容，不复制业务标识（cardId/number/状态）→ 粘贴生成新待派发卡。
  const copySelected = useCallback(async () => {
    const selected = board.nodes.filter((n) => (n as Node & { selected?: boolean }).selected && n.type !== "session-card");
    if (selected.length === 0) return false;
    const payload = selected.map((n) => ({
      type: n.type,
      data: n.data,
      style: n.style,
      width: n.measured?.width ?? (n.style as { width?: number } | undefined)?.width,
      height: n.measured?.height ?? (n.style as { height?: number } | undefined)?.height,
    }));
    try {
      await navigator.clipboard.writeText(JSON.stringify({ app: BOARD_CLIP_MIME, nodes: payload }));
      return true;
    } catch {
      return false;
    }
  }, [board.nodes]);

  // 粘贴：读剪贴板 JSON → 按落点偏移重建节点（新 id，新业务标识）。图片节点 src 复用 URL（资产已持久化）。
  const pasteNodes = useCallback(async (flowPos?: { x: number; y: number }) => {
    let raw = "";
    try {
      raw = await navigator.clipboard.readText();
    } catch {
      return false;
    }
    let parsed: { app?: string; nodes?: Array<{ type?: string; data?: Record<string, unknown>; style?: unknown; width?: number; height?: number }> };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    if (parsed?.app !== BOARD_CLIP_MIME || !Array.isArray(parsed.nodes) || parsed.nodes.length === 0) return false;
    // 落点：传入 flowPos（鼠标/视口中心），否则视口中心
    let base = flowPos;
    if (!base) {
      const pane = document.querySelector(".react-flow__pane");
      const rect = pane?.getBoundingClientRect();
      const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
      const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
      base = screenToFlowPosition({ x: cx, y: cy });
    }
    // 复制节点包围盒居中到落点（多节点粘贴不叠在鼠标上）
    const widths = parsed.nodes.map((n) => n.width ?? 0);
    const heights = parsed.nodes.map((n) => n.height ?? 0);
    const totalW = Math.max(0, ...widths);
    const totalH = Math.max(0, ...heights);
    let offsetX = base.x - totalW / 2;
    let offsetY = base.y - totalH / 2;
    for (const n of parsed.nodes) {
      if (!n.type) continue;
      // 剥 UI 态字段（selected/dragging）与 autofocus（粘贴不自动进编辑）
      const clean = { ...(n.data ?? {}) } as Record<string, unknown>;
      delete clean.selected;
      delete clean.dragging;
      delete clean.autofocus;
      // 任务卡：清掉业务标识（cardId/number/状态），粘贴 = 新的待派发草稿卡，
      // 内容（名称/描述/优先级等）沿用被复制卡。避免新旧卡共享 cardId 导致
      // 删除一张连带另一张（画布 reconcile 按 cardId 判定孤儿）。
      if (n.type === "task-card") {
        delete clean.cardId;
        clean.number = 0;
        clean.name = (clean.name as string | undefined) ?? "新建任务";
        clean.description = (clean.description as string | undefined) ?? "";
        clean.readyStatus = "draft";
        clean.priority = (clean.priority as number | undefined) ?? 0;
        clean.expanded = false;
        clean.w = (clean.w as number | undefined) ?? 380;
        clean.h = (clean.h as number | undefined) ?? 270;
        clean.expandedW = 0;
        clean.expandedH = 0;
        clean.collapsedW = 0;
        clean.collapsedH = 0;
      }
      board.addNode?.({
        id: crypto.randomUUID(),
        type: n.type,
        position: { x: offsetX, y: offsetY },
        style: (n.style as Record<string, unknown> | undefined) ?? {},
        data: clean,
      });
      offsetX += 24;
      offsetY += 24;
    }
    return true;
  }, [board, screenToFlowPosition]);

  // 键盘：复制/粘贴/撤销/重做（画布聚焦时生效；输入框内不拦截）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      // 输入框/编辑态（textarea、input、contenteditable）不拦截——原生复制粘贴照常
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
      if (key === "c") {
        // 有非空文本选区（如便笺/卡片文本选中复制）→ 放行浏览器原生复制，不劫持成节点复制
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return;
        void copySelected();
      } else if (key === "v") {
        void pasteNodes();
      } else if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        board.undo?.();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        board.redo?.();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [board, copySelected, pasteNodes]);

  // 剪贴板粘贴外部图片（Ctrl+V）：非输入框焦点时拦截 paste，检测到图片文件 → 上传贴图。
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // 输入框/编辑态不拦截（原生粘贴文字/图片到编辑器）
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
        .map((it) => it.getAsFile())
        .filter((f): f is File => Boolean(f));
      if (files.length === 0) return;
      e.preventDefault();
      const pane = document.querySelector(".react-flow__pane");
      const rect = pane?.getBoundingClientRect();
      const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
      const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
      const pos = screenToFlowPosition({ x: cx, y: cy });
      files.forEach((f, i) => {
        void addImageFromFile(f, { x: pos.x + i * 20, y: pos.y + i * 20 });
      });
    };
    window.addEventListener("paste", onPaste, true);
    return () => window.removeEventListener("paste", onPaste, true);
  }, [addImageFromFile, screenToFlowPosition]);

  // 工具栏图片按钮：文件选择 → 上传 → 视口中心贴图
  const onFileSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许连续选同一文件
    if (!file) return;
    addImageFromFile(file, screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
  }, [addImageFromFile, screenToFlowPosition]);

  // 右键菜单跨组件事件（BoardContextMenu 发起）：新建图片
  useEffect(() => {
    const onPickImage = () => fileInputRef.current?.click();
    window.addEventListener("pi:board-pick-image", onPickImage);
    return () => window.removeEventListener("pi:board-pick-image", onPickImage);
  }, []);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
      <div ref={stageRef} style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {/* 画布 scrim：内容层之下、壁纸之上的一层暗色承托 + 磨砂（与旧一致）。
          混合渲染（任务卡 #17）：背景图 = 视口对齐的 scrim 档预模糊壁纸切片
          （--glass-bg-image-scrim，由 useGlassWallpaper 生成，fixed 对齐视口），
          零实时 blur；backdrop-filter 保留作实时预览——磨砂滑块拖动时 blur 即时
          生效（applyWallpaperCss 写 --board-scrim-filter），生成成功后摘掉 → 稳态。
          无壁纸图时纯色跟随主题 + blur 实时磨砂。 */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 0,
            pointerEvents: "none",
            backgroundColor: "var(--board-scrim-bg)",
            backgroundImage: "var(--glass-bg-image-scrim, none)",
            backgroundAttachment: "fixed",
            backgroundSize: "100% 100%, 100% 100%",
            backgroundRepeat: "no-repeat, no-repeat",
            backgroundPosition: "0 0, 0 0",
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
              edgeTypes={edgeTypes}
              onBeforeDelete={onBeforeDelete}
              onNodeContextMenu={onNodeContextMenu}
              onNodeClick={onNodeClick}
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
              <MiniMap
                pannable
                zoomable
                style={{
                  ...boardFloatGlass,
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
            {/* 左下角工具区：放大/缩小/fit/进行中（玻璃质感，替代 RF 默认 Controls） */}
            <BoardControls nodes={board.nodes as Array<{ id: string; type: string; data: Record<string, unknown> }>} sessionRunning={board.sessionRunning} />
            {/* 工具栏：会话/便笺/任务/文字/图片（底部居中玻璃浮层）。点击=当前视口中心创建；拖拽=拖放进画布落点创建 */}
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 16, margin: "0 auto", width: "fit-content", zIndex: 30, display: "flex", gap: 4, padding: 4, borderRadius: 10, ...boardFloatGlass, border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 2px 12px -6px rgba(0,0,0,0.18)" }}>
              <ToolbarBtn label="会话" onClick={addSessionAtViewportCenter} onDragStart={(e) => onToolDragStart(e, "session-card")} />
              <span style={{ width: 1, height: 18, background: "color-mix(in srgb, var(--border) 70%, transparent)", margin: "0 2px" }} />
              <ToolbarBtn label="便笺" onClick={() => addNodeAtViewport("sticky-note")} onDragStart={(e) => onToolDragStart(e, "sticky-note")} />
              <ToolbarBtn label="任务" onClick={() => addNodeAtViewport("task-card")} onDragStart={(e) => onToolDragStart(e, "task-card")} />
              <ToolbarBtn label="文字" onClick={() => addNodeAtViewport("text-node")} onDragStart={(e) => onToolDragStart(e, "text-node")} />
              <ToolbarBtn label="图片" onClick={() => fileInputRef.current?.click()} onDragStart={(e) => onToolDragStart(e, "image-node")} />
              <span style={{ width: 1, height: 18, background: "color-mix(in srgb, var(--border) 70%, transparent)", margin: "0 2px" }} />
              <ToolbarBtn label="撤销" onClick={() => board.undo?.()} draggable={false} />
              <ToolbarBtn label="重做" onClick={() => board.redo?.()} draggable={false} />
            </div>
            {/* 图片文件选择（隐藏 input，工具栏「图片」/拖拽触发） */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple={false}
              onChange={onFileSelected}
              style={{ display: "none" }}
              aria-hidden
              tabIndex={-1}
            />
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
