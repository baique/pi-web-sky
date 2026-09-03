"use client";

import { createContext, createElement, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import type { Node, Edge, NodeChange, EdgeChange } from "@xyflow/react";
import { applyNodeChanges, applyEdgeChanges } from "@xyflow/react";
import type { BoardInfo, RunningSnapshot, TaskCardRunningState } from "@/lib/board-types";
import { dispatchBoardSessionCreated } from "@/lib/board-events";
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
  const [viewport, setViewport] = useState<{ x: number; y: number; zoom: number }>({ x: 0, y: 0, zoom: 1 });

  // ---- Hocuspocus provider：连接看板文档 ----
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const nodesMapRef = useRef<Y.Map<Node> | null>(null);
  const edgesMapRef = useRef<Y.Map<Edge> | null>(null);
  const viewMapRef = useRef<Y.Map<number> | null>(null);
  const readyRef = useRef(false);
  readyRef.current = ready;

  const boardIdRef = useRef(boardId);
  boardIdRef.current = boardId;
  // 任务看板 taskId：prop 可能在 URL 直达时为空，看板元信息(board.board.taskId)恒有 —— 归属用两者兜底
  const boardRef = useRef<BoardInfo | null>(null);
  boardRef.current = board;
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
    const viewMap = p.document.getMap<number>("view");
    nodesMapRef.current = nodesMap;
    edgesMapRef.current = edgesMap;
    viewMapRef.current = viewMap;

    const syncNodes = (changes?: Y.YMapEvent<Node>) => {
      // yjs 铁律：changes 只能在 observe 回调同步阶段访问（事务结束后抛错），
      // 必须在这里先取出变化的 key 集合，再传给异步的 setNodes reducer。
      const changedIds = changes ? new Set(Array.from(changes.keys.keys())) : null;
      setNodes((prev) => {
        // selected/dragging 是 UI 态：只存活于本地 state，绝不进 yjs。
        // 回灌时从上一帧保留同 id 节点的选中/拖拽态，并剥掉 yjs 可能的历史残留
        // （曾误将 select 写回 yjs → reload 后节点依然选中）。
        const uiNode = (x: Node) => x as Node & { selected?: boolean; dragging?: boolean };
        const prevSelected = new Set(prev.filter((n) => uiNode(n).selected).map((n) => n.id));
        const prevDragging = new Set(prev.filter((n) => uiNode(n).dragging).map((n) => n.id));
        // yjs Y.Map 每次 get 都 JSON decode 出全新对象（data 引用全变 →
        // 节点组件 memo 失效 → 拖一张卡全部卡每帧重渲染）。
        // 只重建本次变化的节点，未变节点复用上一帧对象 → data 引用稳定。
        const prevById = new Map(prev.map((n) => [n.id, n]));
        return Array.from(nodesMap.values()).map((n) => {
          if (changedIds && !changedIds.has(n.id)) {
            const old = prevById.get(n.id);
            if (old) return old; // 未变：整对象复用（含 selected/dragging/引用）
          }
          const out = { ...n } as Node & { selected?: boolean; dragging?: boolean };
          // 剥掉 yjs 残留的 UI 态字段
          delete out.selected;
          delete out.dragging;
          // 从上一帧恢复本地 UI 态
          if (prevSelected.has(n.id)) out.selected = true;
          if (prevDragging.has(n.id)) out.dragging = true;
          return out;
        });
      });
    };
    const syncEdges = () => setEdges(Array.from(edgesMap.values()));
    const syncView = () => {
      const vm = viewMapRef.current;
      if (!vm) return;
      setViewport({
        x: vm.get("x") ?? 0,
        y: vm.get("y") ?? 0,
        zoom: vm.get("zoom") ?? 1,
      });
    };
    const onSynced = () => {
      syncView();
      setReady(true);
    };
    nodesMap.observe(syncNodes as (e: unknown) => void);
    edgesMap.observe(syncEdges);
    viewMap.observe(syncView);
    p.on("synced", onSynced);
    syncNodes();
    syncEdges();

    return () => {
      nodesMap.unobserve(syncNodes);
      edgesMap.unobserve(syncEdges);
      viewMap.unobserve(syncView);
      p.off("synced", onSynced);
      p.destroy();
      providerRef.current = null;
      nodesMapRef.current = null;
      edgesMapRef.current = null;
      viewMapRef.current = null;
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

  /** 强制重载画布：触发后端 reconcile（画布对齐业务表：补缺/删孤儿/建线）→ 刷新看板元信息。
   *  reconcile 写 yjs 文档，已连接的 provider 通过 CRDT 广播自动收到并重渲染。
   *  切换看板（key 重挂载）/刷新页面（整页重载）各自走独立生命周期，此方法不依赖它们。 */
  const reloadCanvas = useCallback(async () => {
    try {
      await fetch(`/api/boards/${encodeURIComponent(boardId)}/reconcile`, { method: "POST" });
    } catch {
      // reconcile 失败不影响后续元信息刷新
    }
    await load();
  }, [boardId, load]);

  // ---- 运行中快照轮询：更新会话卡 phase/runningMs + 可见任务卡状态 ----------------
  const [running, setRunning] = useState<RunningSnapshot | null>(
    () => (globalThis as { __piRunningSnapshot?: RunningSnapshot }).__piRunningSnapshot ?? null,
  );
  const setRunningCached = useCallback((data: RunningSnapshot) => {
    (globalThis as { __piRunningSnapshot?: RunningSnapshot }).__piRunningSnapshot = data;
    setRunning(data);
  }, []);
  const runningPollInFlightRef = useRef(false);

  // ---- 可见任务卡注册表：任务卡组件 mount/unmount 时注册/注销自己的 cardId ----
  // 轮询携带这些 cardId（?boardId&cardIds=）请求**全量**状态（含 failed/done），
  // 写 taskCardStatus（DB 真相的展示镜像）供 TaskCardNode 徽章读取。
  // yjs 不再承载 execStatus —— 这就是「状态从卡分离」的接入点。
  const visibleTaskCardIdsRef = useRef<Set<string>>(new Set());
  const [taskCardStatus, setTaskCardStatus] = useState<Record<string, TaskCardRunningState>>({});
  const registerVisibleTaskCard = useCallback((cardId: string) => {
    visibleTaskCardIdsRef.current.add(cardId);
  }, []);
  const unregisterVisibleTaskCard = useCallback((cardId: string) => {
    visibleTaskCardIdsRef.current.delete(cardId);
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (stopped || runningPollInFlightRef.current || document.visibilityState !== "visible") return;
      runningPollInFlightRef.current = true;
      try {
        // 可见任务卡：带 cardIds 请求全量状态；无可见卡则不带参（左侧栏语义不变）
        const visibleIds = Array.from(visibleTaskCardIdsRef.current);
        const qs = visibleIds.length > 0 && boardIdRef.current
          ? `?boardId=${encodeURIComponent(boardIdRef.current)}&cardIds=${encodeURIComponent(visibleIds.join(","))}`
          : "";
        const res = await fetch(`/api/agent/running${qs}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as RunningSnapshot;
        if (stopped) return;
        setRunningCached(data);
        // 任务卡状态镜像（不写 yjs）：仅保留仍在可见集合内的卡，避免状态残留。
        // 关键：只在内容**实际变化**时 setState（否则每次轮询都新建对象引用 →
        // 下游 useMemo 依赖引用变化 → 整树重渲染 → 拖拽卡顿，memo 被击穿）。
        const applyTaskCards = (merge: (prev: Record<string, TaskCardRunningState>) => Record<string, TaskCardRunningState>) => {
          setTaskCardStatus((prev) => {
            const next = merge(prev);
            if (next === prev) return prev;
            const prevKeys = Object.keys(prev);
            const nextKeys = Object.keys(next);
            if (prevKeys.length === nextKeys.length && prevKeys.every((k) => next[k] === prev[k])) return prev;
            return next;
          });
        };
        if (data.taskCards.length > 0) {
          applyTaskCards((prev) => {
            let changed = false;
            const next = { ...prev };
            for (const c of data.taskCards) {
              if (next[c.cardId] !== c) { next[c.cardId] = c; changed = true; }
            }
            return changed ? next : prev;
          });
        } else if (visibleIds.length > 0) {
          // 请求了可见卡但后端一条没回 → 这些卡已被删 → 从镜像清掉
          applyTaskCards((prev) => {
            let changed = false;
            const next = { ...prev };
            for (const id of visibleIds) {
              if (next[id]) { delete next[id]; changed = true; }
            }
            return changed ? next : prev;
          });
        }
        const nodesMap = nodesMapRef.current;
        if (!nodesMap) return;
        // 会话卡：phase/runningMs 仍写回 Y.Map（CRDT 广播，供多端一致展示运行态）
        for (const node of Array.from(nodesMap.values())) {
          if (node.type !== "session-card") continue;
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
    // select：UI 态，只在本地 state 应用（绝不写 yjs——避免持久化/广播选中）。
    // 下次 yjs 回灌（syncNodes）会从上一帧 state 保留 selected，不丢选中。
    const selectChanges = changes.filter((c) => c.type === "select") as Extract<NodeChange, { type: "select" }>[];
    if (selectChanges.length) {
      setNodes((prev) => applyNodeChanges(selectChanges, prev));
    }
    const dataChanges = changes.filter((c) => c.type !== "select");
    if (dataChanges.length === 0) return;
    const current = Array.from(nodesMap.values());
    const next = applyNodeChanges(dataChanges, current);
    for (const c of dataChanges) {
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
        if (n) {
          // 剥掉 dragging（UI 态，不落文档；RF 拖拽态由本地 store 管）
          const { dragging: _d, ...clean } = n;
          nodesMap.set(c.id, clean);
        }
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
  const addNewSessionCard = useCallback((flowPos?: { x: number; y: number }) => {
    const nodesMap = nodesMapRef.current;
    if (!nodesMap) return;
    const w = NEW_SESSION_CARD_W;
    const h = NEW_SESSION_CARD_H;
    const sessionId = crypto.randomUUID();
    const id = crypto.randomUUID();
    // 落点：传入的 flowPos 视为卡片【中心】坐标（NewSessionButton 传视口中心）→
    // position 是左上角，需减去卡片宽高的一半让卡片居中。未传则画布原点附近 + 级联偏移。
    const cx = flowPos?.x ?? 60;
    const cy = flowPos?.y ?? 60;
    const x = cx - w / 2 + (nodesMap.size % 3) * 24;
    const y = cy - h / 2 + (nodesMap.size % 3) * 24;
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

  // ---- 拖入会话（看板）----
  /**
   * 拖入会话卡。任务看板：拖入 = 加入当前任务 —— 先落卡（用户立即可见），再异步归属任务，
   * 否则 10s reconcile 会把非任务会话当孤儿删（board-reconcile allSessionIds 只含任务会话）。
   * 普通看板：直接落卡（无派生 reconcile，不删）。
   * 注意：落卡在前，归属在后 —— 归属是网络请求，若先 await 会阻塞落卡（拖入无反应假象）。
   */
  const addSessionNode = useCallback((sessionId: string, x: number, y: number) => {
    const nodesMap = nodesMapRef.current;
    if (!nodesMap) return;
    // 先落卡（同步，用户松手立即看到卡）
    const summary = sessionTitlesRef.current[sessionId];
    const id = `session-${sessionId}`;
    // 归属目标：任务看板拖入 = 加入本任务。落卡即写 data.taskId——reconcile 孤儿删放行它
    // （归属异步完成前不把卡当孤儿删）；普通看板 taskId 为空。
    const taskId = taskIdRef.current ?? boardRef.current?.taskId ?? null;
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
        taskId: taskId ?? "",
        w: CARD_W, h: CARD_H, expandedW: 0, expandedH: 0, collapsedW: 0, collapsedH: 0,
      },
    });
    // 任务看板：归属到任务（避免 reconcile 孤儿删）—— 异步后台做，不阻塞落卡
    if (taskId) {
      void (async () => {
        try {
          const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { cache: "no-store" });
          const d = (await res.json()) as { task?: { sessionIds?: string[] } };
          const sessionIds = d.task?.sessionIds ?? [];
          if (!sessionIds.includes(sessionId)) {
            await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionIds: [...sessionIds, sessionId] }),
            });
            // 归属成功 → 通知侧栏刷新：会话从游离区移入该任务分组下
            dispatchBoardSessionCreated(sessionId);
          }
        } catch (error) {
          console.warn(`[board] 拖入会话归属任务失败 ${sessionId}:`, error instanceof Error ? error.message : error);
        } finally {
          // 归属 settle（成败皆清）：撤掉落卡时的 taskId 声明。
          // 成功后会话已入本任务 sessionIds（reconcile 不再当孤儿）；
          // 失败后卡回到无保护态，下轮 reconcile 正确按成员关系清理（与 WIP 注释一致）。
          const nodesMap = nodesMapRef.current;
          if (nodesMap?.has(id)) {
            const cur = nodesMap.get(id);
            if (cur && (cur.data as Record<string, unknown>)?.taskId) {
              nodesMap.set(id, { ...cur, data: { ...cur.data, taskId: "" } });
            }
          }
        }
      })();
    }
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
      const ok = await confirm({ message: "移除该会话卡片？\n会话本身将保留在会话列表中，可随时重新拖入。" });
      if (!ok) return;
      nodesMap.delete(node.id);
      for (const e of Array.from(edgesMap.values())) {
        if (e.source === node.id || e.target === node.id) edgesMap.delete(e.id);
      }
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

  /**
   * 规范化节点 id：新建任务卡派发成功后，把随机 UUID 节点 id 改成确定性 `task-<cardId>`，
   * 避免与后端 reconcile 补出的 task-<cardId> 节点并存（重复卡）。yjs 删旧建新 + 级联更新边端点。
   */
  const normalizeNodeId = useCallback((oldId: string, newId: string) => {
    const nodesMap = nodesMapRef.current;
    if (!nodesMap || !oldId || oldId === newId) return;
    const node = nodesMap.get(oldId);
    if (!node) return;
    nodesMap.delete(oldId);
    nodesMap.set(newId, { ...node, id: newId });
    // 级联：以旧 id 为端点的边改指向新 id
    const edgesMap = edgesMapRef.current;
    if (edgesMap) {
      for (const e of Array.from(edgesMap.values())) {
        if (e.source === oldId || e.target === oldId) {
          edgesMap.set(e.id, { ...e, source: e.source === oldId ? newId : e.source, target: e.target === oldId ? newId : e.target });
        }
      }
    }
  }, []);

  const addEdge = useCallback((edge: Edge) => {
    const edgesMap = edgesMapRef.current;
    if (!edgesMap) return;
    edgesMap.set(edge.id, edge);
  }, []);

  const addNode = useCallback((node: Node) => {
    const nodesMap = nodesMapRef.current;
    if (!nodesMap) return;
    nodesMap.set(node.id, node);
  }, []);

  // ---- 清空画布 ----
  const clearBoard = useCallback(async () => {
    const nodesMap = nodesMapRef.current;
    const edgesMap = edgesMapRef.current;
    if (!nodesMap || !edgesMap) return;
    const isTaskBoard = Boolean(taskIdRef.current ?? boardRef.current?.taskId);
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

  const saveViewport = useCallback((vp: { x: number; y: number; zoom: number }) => {
    const vm = viewMapRef.current;
    if (!vm) return;
    vm.set("x", vp.x);
    vm.set("y", vp.y);
    vm.set("zoom", vp.zoom);
  }, []);

  return useMemo(
    () => ({
      board,
      loading,
      error,
      running,
      runningCount: running?.runningSessionIds.length ?? 0,
      // 可见任务卡状态镜像（DB 真相的展示快照，running 轮询维护）
      taskCardStatus,
      registerVisibleTaskCard,
      unregisterVisibleTaskCard,
      // React Flow 受控数据
      nodes,
      edges,
      viewport,
      saveViewport,
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
      normalizeNodeId,
      addEdge,
      addNode,
      clearBoard,
      sessionTitles,
      loadSessionSummaries,
      reloadCanvas,
    }),
    [board, loading, error, running, nodes, edges, viewport, saveViewport, onNodesChange, onEdgesChange, onConnect, provider, ready, addSessionNode, addNewSessionCard, deleteNodeWithConfirm, updateNode, normalizeNodeId, addEdge, addNode, clearBoard, sessionTitles, loadSessionSummaries, reloadCanvas, load, taskCardStatus, registerVisibleTaskCard, unregisterVisibleTaskCard],
  );
}

export type UseBoardCanvasReturn = ReturnType<typeof useBoardCanvas>;

// ============================================================================
// 任务卡状态上下文（状态分离的核心接入点）
//
// 设计：任务卡 execStatus 不在 yjs 数据中承载（不再写回、不再作为真相），
// 而由 running 轮询（?cardIds=）拉取 DB 快照到 taskCardStatus map，经此 context
// 提供给 TaskCardNode 徽章 / BoardTopbar 执行队列。数据库是唯一真相源；
// 可见卡在 TaskCardNode mount 时 register、unmount 时 unregister，驱动轮询参数。
// ============================================================================

/** 任务卡状态查询 + 可见注册（SessionCanvas 提供，RF 节点经此读取） */
export interface TaskCardStatusValue {
  /** 单卡状态（DB 真相镜像）；未拉到/不存在 → null */
  getStatus: (cardId: string) => TaskCardRunningState | undefined;
  /** 已建卡（cardId 非空）进入视口时注册；画布据此携带 cardIds 请求 */
  register: (cardId: string) => void;
  /** 卡片卸载时注销 */
  unregister: (cardId: string) => void;
}

const TaskCardStatusContext = createContext<TaskCardStatusValue | null>(null);

/** 供 SessionCanvas 包住 ReactFlow：把 useBoardCanvas 的状态镜像桥接给 RF 节点 */
export function TaskCardStatusProvider({ value, children }: { value: TaskCardStatusValue; children: ReactNode }) {
  return createElement(TaskCardStatusContext.Provider, { value }, children);
}

/** 读取单卡实时状态（TaskCardNode 徽章 / BoardTopbar 用） */
export function useTaskCardStatus(cardId: string | null): TaskCardRunningState | undefined {
  const ctx = useContext(TaskCardStatusContext);
  return cardId && ctx ? ctx.getStatus(cardId) : undefined;
}

/** 注册/注销可见卡（TaskCardNode mount/unmount 调用） */
export function useTaskCardVisibility() {
  const ctx = useContext(TaskCardStatusContext);
  return {
    register: ctx?.register ?? (() => {}),
    unregister: ctx?.unregister ?? (() => {}),
  };
}
