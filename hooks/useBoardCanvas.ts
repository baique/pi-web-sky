"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import type { Node, Edge, NodeChange, EdgeChange } from "@xyflow/react";
import { applyNodeChanges, applyEdgeChanges } from "@xyflow/react";
import type { BoardInfo, RunningSnapshot } from "@/lib/board-types";
import { dispatchBoardSessionDeleted } from "@/lib/board-events";
import { confirm } from "@/components/canvas/ConfirmDialog";

// ============================================================================
// 看板画布数据层（yjs 版，替代 tldraw useSync）
//
// 数据模型：每看板一个 Y.Doc（Hocuspocus，服务端持久化到 sync.db）
//   - nodes: Y.Map<RF Node>    （id -> node，含 position/style/data）
//   - edges: Y.Map<RF Edge>
//   - view:  Y.Map             （{ x, y, zoom }）
//
// 职责边界（方案 rev2 核心）：
//   - 派生元素（会话卡存在性 / exec 线 / 依赖线 / 孤儿删）= 后端 reconcile（board-reconcile）
//   - 用户内容（布局 / 尺寸 / 便笺文本 / 新建会话卡）= 本 hook 写 Y.Doc（增量 set）
//   - 展示字段（phase / runningMs / 标题 / 消息数）= 本 hook 轮询写 Y.Doc（data）
//   - 前端不整表覆盖、不做孤儿清理（后端权威）→ 无乐观锁 / 409
// ============================================================================

/** 会话摘要（卡片展示用） */
export type SessionSummary = {
  title: string;
  messageCount: number;
  projectName: string;
  lastReply: string;
  lastActivityAt: number;
};

/** 卡片标题/最后回复轮询间隔（ms） */
const SUMMARY_POLL_MS = 10000;
/** running 快照轮询间隔（ms） */
const RUNNING_POLL_MS = 2500;

/** 收合卡默认尺寸 */
export const CARD_W = 340;
export const CARD_H = 160;
/** 展开工作台默认尺寸 */
export const WORKBENCH_W = 760;
export const WORKBENCH_H = 600;
/** 新会话卡默认展开尺寸 */
const NEW_SESSION_CARD_W = 840;
const NEW_SESSION_CARD_H = 600;

/**
 * sync 地址：默认跟随当前页面 origin（server.mjs 内嵌在同一端口）。
 * 独立 sync 进程场景仍用 NEXT_PUBLIC_SYNC_WS 覆盖。
 */
const SYNC_BASE =
  process.env.NEXT_PUBLIC_SYNC_WS ??
  (typeof window !== "undefined"
    ? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`
    : "");

export type CanvasPhase = "waiting_model" | "running_tools" | "running_command" | "waiting_input" | "idle" | "just-ended";

/** 会话卡 data（与后端 reconcile 的 node.data 对齐） */
export interface SessionCardData extends Record<string, unknown> {
  sessionId: string;
  title: string;
  projectName: string;
  messageCount: number;
  lastReply: string;
  phase: CanvasPhase;
  runningMs: number;
  endedAt: number;
  lastActivityAt: number;
  stale: boolean;
  expanded: boolean;
  cwd?: string;
  taskId?: string;
  w: number;
  h: number;
  expandedW: number;
  expandedH: number;
  collapsedW: number;
  collapsedH: number;
}

/** 后端 reconcile 会用确定性 id（session-<sid>）补卡；前端新建用 UUID */
function isNewSessionNode(node: Node | undefined): boolean {
  const d = node?.data as { cwd?: string } | undefined;
  return Boolean(node && d && typeof d.cwd === "string" && d.cwd.length > 0);
}

export function useBoardCanvas({
  boardId,
  taskId,
  newSessionCwd,
}: {
  boardId: string;
  taskId?: string;
  newSessionCwd?: string;
}) {
  const [board, setBoard] = useState<BoardInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  // ---- Hocuspocus provider：连接看板文档 ----
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const nodesMapRef = useRef<Y.Map<Node> | null>(null);
  const edgesMapRef = useRef<Y.Map<Edge> | null>(null);
  const readyRef = useRef(false);
  readyRef.current = ready;

  const boardIdRef = useRef(boardId);
  boardIdRef.current = boardId;
  const taskIdRef = useRef(taskId ?? null);
  taskIdRef.current = taskId ?? null;
  const newSessionCwdRef = useRef(newSessionCwd);
  newSessionCwdRef.current = newSessionCwd;

  // 同步地址（稳定引用，避免每次渲染重建）
  const syncUri = useMemo(() => `${SYNC_BASE}/connect`, []);

  // 建立连接（boardId 变化时重建）
  useEffect(() => {
    const p = new HocuspocusProvider({
      url: syncUri,
      name: boardId,
      forceSyncInterval: false,
    });
    providerRef.current = p;
    setProvider(p);
    const nodesMap = p.document.getMap<Node>("nodes");
    const edgesMap = p.document.getMap<Edge>("edges");
    nodesMapRef.current = nodesMap;
    edgesMapRef.current = edgesMap;

    const syncNodes = () => setNodes(Array.from(nodesMap.values()));
    const syncEdges = () => setEdges(Array.from(edgesMap.values()));
    const onSynced = () => setReady(true);
    nodesMap.observe(syncNodes);
    edgesMap.observe(syncEdges);
    p.on("synced", onSynced);
    syncNodes();
    syncEdges();

    return () => {
      nodesMap.unobserve(syncNodes);
      edgesMap.unobserve(syncEdges);
      p.off("synced", onSynced);
      p.destroy();
      providerRef.current = null;
      nodesMapRef.current = null;
      edgesMapRef.current = null;
      setReady(false);
    };
  }, [syncUri, boardId]);

  // ---- 看板元信息 ----
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}`, { cache: "no-store" });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const b = (await res.json()) as { board: BoardInfo };
      setBoard(b.board);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [boardId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- 运行中快照轮询：更新卡片 phase/runningMs + 任务卡 execStatus + 即时补卡 ----
  const [running, setRunning] = useState<RunningSnapshot | null>(
    () => (globalThis as { __piRunningSnapshot?: RunningSnapshot }).__piRunningSnapshot ?? null,
  );
  const setRunningCached = useCallback((data: RunningSnapshot) => {
    (globalThis as { __piRunningSnapshot?: RunningSnapshot }).__piRunningSnapshot = data;
    setRunning(data);
  }, []);
  const runningPollInFlightRef = useRef(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (stopped || runningPollInFlightRef.current || document.visibilityState !== "visible") return;
      runningPollInFlightRef.current = true;
      try {
        const res = await fetch("/api/agent/running", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as RunningSnapshot;
        if (stopped) return;
        setRunningCached(data);
        const nodesMap = nodesMapRef.current;
        if (!nodesMap) return;
        // 增量更新：running 状态写回 Y.Map（CRDT 广播到多端）
        for (const node of Array.from(nodesMap.values())) {
          if (node.type === "session-card") {
            const d = node.data as SessionCardData;
            if (!d.sessionId) continue;
            const state = data.states[d.sessionId] as { phase?: CanvasPhase; startedAt?: number } | undefined;
            const runningNow = data.runningSessionIds.includes(d.sessionId);
            if (runningNow && state) {
              const phase = (state.phase as CanvasPhase) ?? "waiting_model";
              const runningMs = state.startedAt ? Date.now() - state.startedAt : 0;
              if (d.phase !== phase || d.runningMs !== runningMs || d.endedAt !== 0) {
                nodesMap.set(node.id, { ...node, data: { ...d, phase, runningMs, endedAt: 0 } });
              }
            } else if (!runningNow && d.phase !== "idle") {
              nodesMap.set(node.id, { ...node, data: { ...d, phase: "idle", runningMs: 0, endedAt: 0 } });
            }
          } else if (node.type === "task-card") {
            const d = node.data as { cardId?: string; execStatus?: string };
            if (!d.cardId) continue;
            const st = data.taskCards?.find((c) => c.cardId === d.cardId && c.boardId === boardIdRef.current);
            if (st && st.execStatus !== d.execStatus) {
              nodesMap.set(node.id, { ...node, data: { ...d, execStatus: st.execStatus } });
            }
          }
        }
      } catch {
        // keep last
      } finally {
        runningPollInFlightRef.current = false;
      }
    };
    const loop = () => {
      if (stopped) return;
      timer = setTimeout(async () => {
        await poll();
        loop();
      }, RUNNING_POLL_MS);
    };
    void poll();
    loop();
    const onVis = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [setRunningCached]);

  // ---- 会话摘要（标题/消息数/最后回复）----
  const [sessionTitles, setSessionTitles] = useState<Record<string, SessionSummary>>({});
  const sessionTitlesRef = useRef<Record<string, SessionSummary>>({});
  sessionTitlesRef.current = sessionTitles;
  const summariesInFlightRef = useRef(false);
  const loadSessionSummaries = useCallback(async () => {
    if (summariesInFlightRef.current) return;
    summariesInFlightRef.current = true;
    try {
      const res = await fetch("/api/sessions", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { sessions: Array<{ id: string; name?: string; firstMessage?: string; messageCount?: number; projectKey?: string; projectRoot?: string; lastReply?: string; modified?: string }> };
      const map: Record<string, SessionSummary> = {};
      for (const s of data.sessions) {
        map[s.id] = {
          title: s.name ?? s.firstMessage ?? "Untitled",
          messageCount: s.messageCount ?? 0,
          projectName: s.projectKey ?? s.projectRoot ?? "",
          lastReply: s.lastReply ?? "",
          lastActivityAt: s.modified ? Date.parse(s.modified) : 0,
        };
      }
      setSessionTitles(map);
    } catch {
      // keep last
    } finally {
      summariesInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      await loadSessionSummaries();
      if (!stopped) timer = setTimeout(run, SUMMARY_POLL_MS);
    };
    void run();
    const onVis = () => {
      if (document.visibilityState === "visible") {
        if (timer) clearTimeout(timer);
        void run();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadSessionSummaries]);

  // 摘要 → 写回节点 data（标题/最后回复实时刷新，CRDT 同步到多端）
  useEffect(() => {
    const nodesMap = nodesMapRef.current;
    if (!nodesMap || !readyRef.current) return;
    if (Object.keys(sessionTitles).length === 0) return;
    for (const node of Array.from(nodesMap.values())) {
      if (node.type !== "session-card") continue;
      const d = node.data as SessionCardData;
      const s = sessionTitles[d.sessionId];
      if (!s) continue;
      if (d.title !== s.title || d.lastReply !== s.lastReply || d.messageCount !== s.messageCount || d.lastActivityAt !== s.lastActivityAt) {
        nodesMap.set(node.id, { ...node, data: { ...d, title: s.title, lastReply: s.lastReply, messageCount: s.messageCount, lastActivityAt: s.lastActivityAt } });
      }
    }
  }, [sessionTitles, ready]);

  // ---- 前端编辑：增量写回 Y.Map ----
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const nodesMap = nodesMapRef.current;
    if (!nodesMap) return;
    const current = Array.from(nodesMap.values());
    const next = applyNodeChanges(changes, current);
    for (const c of changes) {
      if (c.type === "add" || c.type === "replace") {
        nodesMap.set(c.item.id, c.item);
      } else if (c.type === "remove" && nodesMap.has(c.id)) {
        nodesMap.delete(c.id);
        // 级联删以它为端点的边（本地），派生边由后端 reconcile 兜底
        const edgesMap = edgesMapRef.current;
        if (edgesMap) {
          for (const e of Array.from(edgesMap.values())) {
            if (e.source === c.id || e.target === c.id) edgesMap.delete(e.id);
          }
        }
      } else if (c.type === "position" || c.type === "dimensions") {
        const n = next.find((x) => x.id === c.id);
        if (n) nodesMap.set(c.id, n);
      }
    }
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const edgesMap = edgesMapRef.current;
    if (!edgesMap) return;
    const current = Array.from(edgesMap.values());
    const next = applyEdgeChanges(changes, current);
    for (const c of changes) {
      if (c.type === "add" || c.type === "replace") {
        edgesMap.set(c.item.id, c.item);
      } else if (c.type === "remove" && edgesMap.has(c.id)) {
        // 派生边（exec/依赖）禁删：由后端 reconcile 兜底补回；这里跳过
        const e = edgesMap.get(c.id);
        if (e && (e.data as { execLink?: boolean; taskLink?: boolean } | undefined)?.execLink) continue;
        if (e && (e.data as { taskLink?: string } | undefined)?.taskLink) continue;
        edgesMap.delete(c.id);
      } else {
        const e = next.find((x) => x.id === c.id);
        if (e) edgesMap.set(c.id, e);
      }
    }
  }, []);

  const onConnect = useCallback((conn: { source: string; target: string }) => {
    const edgesMap = edgesMapRef.current;
    if (!edgesMap) return;
    const id = `edge-${conn.source}-${conn.target}-${Date.now()}`;
    edgesMap.set(id, {
      id,
      source: conn.source,
      target: conn.target,
      type: "default",
      markerEnd: { type: "arrowclosed" },
      style: { strokeWidth: 1.5, stroke: "#8b8fa3" },
    });
  }, []);

  // ---- 新会话卡（用户点 + 创建）----
  const addNewSessionCard = useCallback(() => {
    const nodesMap = nodesMapRef.current;
    if (!nodesMap) return;
    const w = NEW_SESSION_CARD_W;
    const h = NEW_SESSION_CARD_H;
    const viewport = { x: 0, y: 0 }; // 简单落点（首屏中心由 view 计算，简化：固定偏移）
    const sessionId = crypto.randomUUID();
    const id = crypto.randomUUID();
    // 新建会话卡在视口中心附近（简化用画布原点 + 级联偏移）
    const x = viewport.x + 60 + (nodesMap.size % 3) * 24;
    const y = viewport.y + 60 + (nodesMap.size % 3) * 24;
    nodesMap.set(id, {
      id,
      type: "session-card",
      position: { x, y },
      style: { width: w, height: h },
      data: {
        sessionId,
        title: "",
        projectName: "",
        messageCount: 0,
        lastReply: "",
        phase: "idle",
        runningMs: 0,
        endedAt: 0,
        lastActivityAt: 0,
        stale: false,
        expanded: true,
        cwd: newSessionCwdRef.current ?? "",
        taskId: taskIdRef.current ?? "",
        w, h, expandedW: 0, expandedH: 0, collapsedW: 0, collapsedH: 0,
      },
    });
  }, []);

  // ---- 拖入会话（普通看板）----
  const addSessionNode = useCallback((sessionId: string, x: number, y: number) => {
    const nodesMap = nodesMapRef.current;
    if (!nodesMap) return;
    const summary = sessionTitlesRef.current[sessionId];
    const id = `session-${sessionId}`;
    nodesMap.set(id, {
      id,
      type: "session-card",
      position: { x, y },
      style: { width: CARD_W, height: CARD_H },
      data: {
        sessionId,
        title: summary?.title ?? "Untitled",
        projectName: summary?.projectName ?? "",
        messageCount: summary?.messageCount ?? 0,
        lastReply: summary?.lastReply ?? "",
        lastActivityAt: summary?.lastActivityAt ?? 0,
        phase: "idle",
        runningMs: 0,
        endedAt: 0,
        stale: false,
        expanded: false,
        w: CARD_W, h: CARD_H, expandedW: 0, expandedH: 0, collapsedW: 0, collapsedH: 0,
      },
    });
  }, []);

  // ---- 删除（确认制）：删会话/任务卡 → 确认 → 删 Y.Doc 节点 + 调删除 API ----
  const deleteNodeWithConfirm = useCallback(async (node: Node) => {
    const nodesMap = nodesMapRef.current;
    const edgesMap = edgesMapRef.current;
    if (!nodesMap || !edgesMap) return;
    if (node.type === "session-card") {
      const d = node.data as { sessionId?: string; cwd?: string };
      // 新会话卡（cwd 非空）：直接删（会话未创建）
      if (!d.sessionId || d.cwd) {
        nodesMap.delete(node.id);
        for (const e of Array.from(edgesMap.values())) {
          if (e.source === node.id || e.target === node.id) edgesMap.delete(e.id);
        }
        return;
      }
      const ok = await confirm({ message: "删除该会话？\n将同时删除画布卡片并断开任务卡关联。此操作不可撤销。" });
      if (!ok) return;
      nodesMap.delete(node.id);
      for (const e of Array.from(edgesMap.values())) {
        if (e.source === node.id || e.target === node.id) edgesMap.delete(e.id);
      }
      fetch(`/api/sessions/${encodeURIComponent(d.sessionId)}`, { method: "DELETE" })
        .then(() => dispatchBoardSessionDeleted(d.sessionId!))
        .catch((e) => console.warn(`[board] 删除会话 ${d.sessionId} 异常`, e));
    } else if (node.type === "task-card") {
      const d = node.data as { cardId?: string };
      if (!d.cardId) {
        nodesMap.delete(node.id);
        return;
      }
      const ok = await confirm({ message: "删除该任务卡？\n将删除任务卡、依赖线与执行会话连线；关联的执行会话保留。此操作不可撤销。" });
      if (!ok) return;
      nodesMap.delete(node.id);
      for (const e of Array.from(edgesMap.values())) {
        if (e.source === node.id || e.target === node.id) edgesMap.delete(e.id);
      }
      fetch(`/api/task-cards/${encodeURIComponent(d.cardId)}`, { method: "DELETE" }).catch((e) =>
        console.warn(`[board] 删除任务卡 ${d.cardId} 异常`, e),
      );
    } else {
      // 便笺/文本：直接删
      nodesMap.delete(node.id);
    }
  }, []);

  // ---- 节点/边操作：暴露给自定义节点组件（写 Y.Map 增量）----
  const updateNode = useCallback((id: string, patch: Partial<Node>) => {
    const nodesMap = nodesMapRef.current;
    if (!nodesMap) return;
    const cur = nodesMap.get(id);
    if (!cur) return;
    nodesMap.set(id, { ...cur, ...patch });
  }, []);

  const addEdge = useCallback((edge: Edge) => {
    const edgesMap = edgesMapRef.current;
    if (!edgesMap) return;
    edgesMap.set(edge.id, edge);
  }, []);

  // ---- 清空画布 ----
  const clearBoard = useCallback(async () => {
    const nodesMap = nodesMapRef.current;
    const edgesMap = edgesMapRef.current;
    if (!nodesMap || !edgesMap) return;
    const isTaskBoard = Boolean(taskIdRef.current);
    const toDelete = Array.from(nodesMap.values()).filter((n) => (isTaskBoard ? n.type !== "session-card" : true));
    for (const n of toDelete) {
      nodesMap.delete(n.id);
      for (const e of Array.from(edgesMap.values())) {
        if (e.source === n.id || e.target === n.id) edgesMap.delete(e.id);
      }
    }
    // 任务看板：会话卡保留，派生边由后端 reconcile 补回
  }, []);

  const loading = !ready;

  return useMemo(
    () => ({
      board,
      loading,
      error,
      running,
      runningCount: running?.runningSessionIds.length ?? 0,
      // React Flow 受控数据
      nodes,
      edges,
      onNodesChange,
      onEdgesChange,
      onConnect,
      provider,
      /** 是否已同步（替代原 syncStore.status === "synced-remote"） */
      ready,
      addSessionNode,
      addNewSessionCard,
      deleteNodeWithConfirm,
      updateNode,
      addEdge,
      clearBoard,
      sessionTitles,
      loadSessionSummaries,
      reloadCanvas: load,
    }),
    [board, loading, error, running, nodes, edges, onNodesChange, onEdgesChange, onConnect, provider, ready, addSessionNode, addNewSessionCard, deleteNodeWithConfirm, updateNode, addEdge, clearBoard, sessionTitles, loadSessionSummaries, load],
  );
}

export type UseBoardCanvasReturn = ReturnType<typeof useBoardCanvas>;
