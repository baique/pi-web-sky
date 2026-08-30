"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor, TLArrowShape, TLShape, TLShapePartial } from "tldraw";
import { createShapeId } from "tldraw";
import type { BoardCanvas, BoardInfo, BoardNode, BoardEdge, RunningSnapshot, RunningSessionState } from "@/lib/board-types";
import { SYSTEM_RUNNING_BOARD_ID } from "@/lib/board-types";
import { shouldRemoveEndedCard } from "@/lib/board-utils";

/** 会话摘要（卡片展示用）：标题/消息数/项目/最后回复 */
export type SessionSummary = {
  title: string;
  messageCount: number;
  projectName: string;
  lastReply: string;
};

/** 看板卡片最后回复/标题轮询间隔（ms）——会话在跑时卡片内容持续刷新 */
const SUMMARY_POLL_MS = 10000;

/** 收合卡默认尺寸（与 spec §3.1 一致） */
export const CARD_W = 340;
export const CARD_H = 160;
// 旧默认收合尺寸（280×120）→ hydrate 时升级到新默认，容纳 3 行最后回复
const LEGACY_CARD_W = 280;
const LEGACY_CARD_H = 120;
/** 展开工作台默认尺寸（spec §3.2） */
export const WORKBENCH_W = 760;
export const WORKBENCH_H = 600;

export interface SessionCardShapeMeta {
  sessionId: string;
}

export type CanvasPhase = "waiting_model" | "running_tools" | "running_command" | "waiting_input" | "idle" | "just-ended";

/**
 * 看板画布状态机：
 * - 加载 board canvas（nodes/edges/view）→ 物化为 tldraw shapes
 * - tldraw store 变更 → 防抖全量保存到 PUT /canvas（单飞）
 * - 运行中快照轮询 → 更新卡片 phase/runningMs + 运行中看板自动聚合
 * - 会话失效 → 灰化；清理失效节点
 */
export function useBoardCanvas({
  boardId,
  projectKey,
  onOpenSession,
}: {
  boardId: string;
  projectKey?: string;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [board, setBoard] = useState<BoardInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 运行中快照：初值取模块级缓存（切换看板重挂时立即有上次数据，避免闪烁），
  // 轮询更新后写回缓存。
  const [running, setRunning] = useState<RunningSnapshot | null>(
    () => (globalThis as { __piRunningSnapshot?: RunningSnapshot }).__piRunningSnapshot ?? null,
  );
  const setRunningCached = useCallback((data: RunningSnapshot) => {
    (globalThis as { __piRunningSnapshot?: RunningSnapshot }).__piRunningSnapshot = data;
    setRunning(data);
  }, []);
  const editorRef = useRef<Editor | null>(null);
  const boardIdRef = useRef(boardId);
  boardIdRef.current = boardId;
  /** 乐观锁基线：本客户端读取画布时的 boards.updated。每次成功保存后更新；
   *  保存时若服务器 updated 已变化（他人改过）→ 409，不覆盖，拉最新重载。 */
  const baseUpdatedRef = useRef<number | null>(null);

  // ---- 加载看板 ----
  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [boardRes, canvasRes] = await Promise.all([
        fetch(`/api/boards/${encodeURIComponent(boardId)}`, { cache: "no-store" }),
        fetch(`/api/boards/${encodeURIComponent(boardId)}/canvas`, { cache: "no-store" }),
      ]);
      if (!boardRes.ok || !canvasRes.ok) {
        setError(`HTTP ${boardRes.status ?? canvasRes.status}`);
        return;
      }
      const b = (await boardRes.json()) as { board: BoardInfo };
      const c = (await canvasRes.json()) as BoardCanvas;
      setBoard(b.board);
      // 乐观锁基线：以本次读取的 boards.updated 为准
      baseUpdatedRef.current = b.board.updated;
      setInitialCanvas(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [boardId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 初次物化数据（editor 挂载后再用）
  const [initialCanvas, setInitialCanvas] = useState<BoardCanvas | null>(null);

  // ---- 运行中快照轮询 ----
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/agent/running", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as RunningSnapshot;
        if (stopped) return;
        setRunningCached(data);
      } catch {
        // keep last
      }
    };
    const loop = () => {
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(async () => {
        await poll();
        loop();
      }, 2500);
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
  }, []);

  // ---- 会话摘要（标题/消息数/最后回复）用于卡片展示 ----
  const [sessionTitles, setSessionTitles] = useState<Record<string, SessionSummary>>({});
  const loadSessionSummaries = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { sessions: Array<{ id: string; name?: string; firstMessage?: string; messageCount?: number; projectKey?: string; projectRoot?: string; lastReply?: string }> };
      const map: Record<string, SessionSummary> = {};
      for (const s of data.sessions) {
        map[s.id] = {
          title: s.name ?? s.firstMessage ?? "Untitled",
          messageCount: s.messageCount ?? 0,
          projectName: s.projectKey ?? s.projectRoot ?? "",
          lastReply: s.lastReply ?? "",
        };
      }
      setSessionTitles(map);
    } catch {
      // keep last
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
    // 标签页回到可见时立即刷新（不等下一个周期）
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

  // ---- tldraw 挂载 ----
  const [editorReady, setEditorReady] = useState(false);
  const onMount = useCallback((editor: Editor) => {
    editorRef.current = editor;
    setEditorReady(true);
    // 监听 shape 变更 → 防抖保存（仅普通看板）
    if (boardIdRef.current === SYSTEM_RUNNING_BOARD_ID) return;
    const unlisten = editor.store.listen(() => {
      scheduleSave(editor);
    });
    return () => {
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 摘要轮询 → 同步到画布卡片（标题/最后回复实时刷新）----
  // hydrate 只在 initialCanvas 非空时跑一次；此后 sessionTitles 每次轮询更新，
  // 都需把新标题/最后回复写回已有 session-card shape（不重建卡片）。
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !editorReady) return;
    // 摘要空（首次加载前）或初始 hydrate 未完成时不打扰
    if (Object.keys(sessionTitles).length === 0 || hydratingRef.current) return;
    const updates: TLShapePartial[] = [];
    for (const shape of editor.getCurrentPageShapes()) {
      if (shape.type !== "session-card") continue;
      const p = shape.props as SessionCardShapeProps;
      const s = sessionTitles[p.sessionId];
      if (!s) continue;
      if (p.title !== s.title || p.lastReply !== s.lastReply || p.messageCount !== s.messageCount) {
        updates.push({
          id: shape.id,
          type: "session-card",
          props: { title: s.title, lastReply: s.lastReply, messageCount: s.messageCount },
        });
      }
    }
    if (updates.length > 0) {
      editor.updateShapes(updates);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionTitles, editorReady]);

  // ---- 防抖全量保存（单飞） ----
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlightRef = useRef(false);
  const pendingSaveRef = useRef(false);
  /** hydrate 期间为 true：忽略 store 变更，避免把空画布覆盖到已保存数据 */
  const hydratingRef = useRef(false);
  /** 初始物化是否已完成：未完成前禁止自动保存（防止未加载/物化失败的空客户端覆盖看板） */
  const hydratedRef = useRef(false);

  const scheduleSave = useCallback((editor: Editor) => {
    if (hydratingRef.current || !hydratedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => void flushSave(editor), 500);
  }, []);

  // 冲突/需重载时：拉最新画布，清空现有 shapes，复用物化 effect 重新 hydrate，
  // 并刷新乐观锁基线。不保留本地过期操作——以服务器为权威，绝不覆盖。
  const reloadCanvas = useCallback(async () => {
    const editor = editorRef.current;
    const bid = boardIdRef.current;
    if (!editor) return;
    try {
      const [boardRes, canvasRes] = await Promise.all([
        fetch(`/api/boards/${encodeURIComponent(bid)}`, { cache: "no-store" }),
        fetch(`/api/boards/${encodeURIComponent(bid)}/canvas`, { cache: "no-store" }),
      ]);
      if (!boardRes.ok || !canvasRes.ok) return;
      const b = (await boardRes.json()) as { board: BoardInfo };
      const c = (await canvasRes.json()) as BoardCanvas;
      baseUpdatedRef.current = b.board.updated;
      // 清空现有 shapes：此间 store 变更必须禁止保存。hydratingRef 保持 true，
      // 由下方物化 effect 在 hydrate 完成后 800ms 统一复位（不中途复位，避免空画布窗口）。
      hydratingRef.current = true;
      editor.deleteShapes(editor.getCurrentPageShapes().map((s) => s.id));
      setInitialCanvas(c); // 复用物化 effect 重新 hydrate
    } catch (e) {
      console.error("[board] reload failed", e);
    }
  }, []);

  // 冲突计数 +1（供 UI 提示「已加载最新版本」）；409 自动重载与手动重载共用
  const [conflictCount, setConflictCount] = useState(0);
  const reloadCanvasWrap = useCallback(async () => {
    await reloadCanvas();
    setConflictCount((c) => c + 1);
  }, [reloadCanvas]);

  const flushSave = useCallback(async (editor: Editor) => {
    const bid = boardIdRef.current;
    if (bid === SYSTEM_RUNNING_BOARD_ID) return;
    // 双保险：无论谁调用，loading/hydrate 期间一律不写（防未加载完成的空/部分画布覆盖看板）
    if (!hydratedRef.current || hydratingRef.current) return;
    if (saveInFlightRef.current) {
      pendingSaveRef.current = true;
      return;
    }
    saveInFlightRef.current = true;
    try {
      const { nodes, edges } = serializeShapes(editor);
      // 空画布不提交（服务器另有 409 拒绝覆盖非空看板兜底）
      if (nodes.length === 0 && edges.length === 0) return;
      const camera = editor.getCamera();
      const res = await fetch(`/api/boards/${encodeURIComponent(bid)}/canvas`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodes, edges,
          view: { boardId: bid, cameraX: camera.x, cameraY: camera.y, cameraZ: camera.z, updated: Date.now() },
          // 乐观锁：提交时带上本客户端读取快照的 boards.updated。服务器发现已
          // 被他人改过（updated 变化）→ 409，绝不后写覆盖先写。
          baseUpdated: baseUpdatedRef.current ?? undefined,
        }),
      });
      if (res.status === 409) {
        // 冲突：他人已保存过，本地快照过期。不覆盖，拉最新重载（服务器为权威）。
        console.warn("[board] canvas save conflict (409) — reloading latest, local stale changes dropped");
        await reloadCanvasWrap();
        return;
      }
      if (!res.ok) {
        console.error("[board] canvas save failed", res.status);
        return;
      }
      // 成功：以服务器返回的 updated 刷新乐观锁基线
      const data = (await res.json().catch(() => null)) as { updated?: number } | null;
      if (data?.updated) baseUpdatedRef.current = data.updated;
    } catch (e) {
      console.error("[board] canvas save error", e);
    } finally {
      saveInFlightRef.current = false;
      if (pendingSaveRef.current) {
        pendingSaveRef.current = false;
        void flushSave(editor);
      }
    }
  }, [reloadCanvasWrap]);

  // ---- 物化：sqlite canvas → tldraw shapes ----
  const hydrateShapes = useCallback((editor: Editor, canvas: BoardCanvas, titles: Record<string, SessionSummary>) => {
    const shapes: TLShapePartial[] = [];
    for (const node of canvas.nodes) {
      if (node.kind === "shape") {
        // 通用 shape（text/note/geo/draw/group 等）：从 props 还原完整 shape
        const p = node.props as { type?: string; rotation?: number; shapeProps?: Record<string, unknown> };
        if (!p?.type || !p.shapeProps) continue;
        shapes.push({
          id: createShapeId(node.id),
          type: p.type as never,
          x: node.x,
          y: node.y,
          rotation: p.rotation ?? 0,
          props: p.shapeProps as never,
        });
        continue;
      }
      if (node.kind !== "session") continue;
      const summary = node.refId ? titles[node.refId] : undefined;
      shapes.push({
        id: createShapeId(node.id),
        type: "session-card",
        x: node.x,
        y: node.y,
        props: {
          sessionId: node.refId ?? "",
          title: summary?.title ?? "Untitled",
          projectName: summary?.projectName ?? "",
          messageCount: summary?.messageCount ?? 0,
          lastReply: summary?.lastReply ?? "",
          phase: "idle",
          runningMs: 0,
          endedAt: 0,
          stale: node.refId ? !titles[node.refId] : false,
          expanded: node.expanded,
          // 旧默认收合尺寸（280×120）升级到新默认（340×160），容纳最后回复区
          w: node.w === LEGACY_CARD_W && !node.expanded ? CARD_W : node.w || CARD_W,
          h: node.h === LEGACY_CARD_H && !node.expanded ? CARD_H : node.h || CARD_H,
        },
      });
    }
    // 节点位置索引（arrow 端点用）
    const nodeById = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (const node of canvas.nodes) {
      nodeById.set(node.id, { x: node.x, y: node.y, w: node.w || CARD_W, h: node.h || CARD_H });
    }
    for (const edge of canvas.edges) {
      const from = nodeById.get(edge.fromId);
      const to = nodeById.get(edge.toId);
      if (!from || !to) continue;
      shapes.push({
        id: createShapeId(edge.id),
        type: "arrow",
        x: 0,
        y: 0,
        props: {
          start: { x: from.x + from.w / 2, y: from.y + from.h / 2 },
          end: { x: to.x + to.w / 2, y: to.y + to.h / 2 },
          color: (edge.color as TLArrowShape["props"]["color"]) ?? "blue",
          dash: edge.dashed ? "dashed" : "solid",
          arrowheadStart: "none",
          arrowheadEnd: "arrow",
          labelColor: "black",
          font: "sans",
          richText: edge.label ? toRichText(edge.label) : toRichText(""),
          scale: 1,
          size: "m",
          bend: 0,
          kind: "elbow",
          labelPosition: 0.5,
          elbowMidPoint: 0.5,
        } as TLArrowShape["props"],
        meta: { fromId: edge.fromId, toId: edge.toId } as never,
      });
    }
    if (shapes.length > 0) {
      editor.createShapes(shapes);
    }
  }, []);

  // 初始画布就绪 + editor 已挂载 + 会话摘要就绪 → 物化 nodes/edges/view
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !editorReady || !initialCanvas) return;
    // 摘要未就绪时不物化（标题/失效态依赖它），就绪后由本 effect 重跑
    if (Object.keys(sessionTitles).length === 0 && initialCanvas.nodes.length > 0) return;
    const canvas = initialCanvas;
    console.log("[board] hydrate", canvas.nodes.length, "nodes", canvas.edges.length, "edges, titles", Object.keys(sessionTitles).length);
    hydratingRef.current = true;
    hydrateShapes(editor, canvas, sessionTitles);
    // hydrate 创建 shape 会触发 store 变更 → 防抖保存；标记后跳过，
    // 等渲染稳定（下一次真实用户交互）再恢复保存。
    setTimeout(() => { hydratingRef.current = false; }, 800);
    if (canvas.view && boardIdRef.current !== SYSTEM_RUNNING_BOARD_ID) {
      editor.setCamera({ x: canvas.view.cameraX, y: canvas.view.cameraY, z: canvas.view.cameraZ });
    }
    setInitialCanvas(null);
    // 物化完成才放行自动保存：未完成前的空/部分画布绝不允许覆盖看板
    hydratedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCanvas, sessionTitles, hydrateShapes, editorReady]);

  // ---- 序列化：tldraw shapes → sqlite canvas ----
  const serializeShapes = useCallback((editor: Editor) => {
    const nodes: BoardNode[] = [];
    const edges: BoardEdge[] = [];
    const bid = boardIdRef.current;
    const ts = Date.now();
    for (const shape of editor.getCurrentPageShapes()) {
      if (shape.type === "session-card") {
        const p = shape.props as SessionCardShapeProps;
        nodes.push({
          id: shape.id.replace("shape:", ""),
          boardId: bid,
          kind: "session",
          refId: p.sessionId || null,
          x: shape.x,
          y: shape.y,
          w: p.w,
          h: p.h,
          expanded: Boolean(p.expanded),
          props: {},
          created: ts,
          updated: ts,
        });
      } else if (shape.type === "arrow") {
        const a = shape as TLArrowShape;
        // 箭头端点从 binding 解析：binding.fromId 恒为 arrow shape 自身，
        // 真正端点由 props.terminal 区分（start/end → 绑定目标）
        const bindings = editor.getBindingsInvolvingShape(shape.id, "arrow");
        let fromId = "";
        let toId = "";
        for (const b of bindings) {
          const props = (b as { props?: { terminal?: string } }).props;
          const terminal = props?.terminal;
          if (terminal === "start") fromId = b.toId.replace("shape:", "");
          if (terminal === "end") toId = b.toId.replace("shape:", "");
        }
        edges.push({
          id: shape.id.replace("shape:", ""),
          boardId: bid,
          fromId,
          toId,
          label: a.props.richText ? richTextToString(a.props.richText) : null,
          color: a.props.color,
          dashed: a.props.dash === "dashed",
          created: ts,
          updated: ts,
        });
      } else {
        // 通用 shape（text/note/geo/draw/group 等）：整个 shape 序列化进 props，
        // 刷新后原样还原。之前只存 session-card + arrow，导致文字/图形刷新即丢。
        const s = shape as TLShape;
        const { x, y, rotation, props: shapeProps } = s;
        nodes.push({
          id: shape.id.replace("shape:", ""),
          boardId: bid,
          kind: "shape",
          refId: null,
          x,
          y,
          w: "w" in shapeProps ? Number(shapeProps.w) || 0 : 0,
          h: "h" in shapeProps ? Number(shapeProps.h) || 0 : 0,
          expanded: false,
          props: { type: s.type, rotation, shapeProps },
          created: ts,
          updated: ts,
        });
      }
    }
    return { nodes, edges };
  }, []);

  // ---- 运行中看板聚合：running snapshot → 自动物化/更新卡片 ----
  // 运行中看板：物化运行中会话 + 更新 phase + 结束后 30s 移除
  // 普通看板：仅更新已有卡片的运行状态（不创建/不删除）
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !running) return;
    if (boardId === SYSTEM_RUNNING_BOARD_ID) {
      reconcileRunningBoard(editor, running, sessionTitles);
    } else {
      updateCardRunningState(editor, running);
    }
  }, [running, boardId, sessionTitles]);

  const reconcileRunningBoard = useCallback((editor: Editor, snapshot: RunningSnapshot, titles: Record<string, SessionSummary>) => {
    const existing = new Map<string, TLShape>();
    for (const shape of editor.getCurrentPageShapes()) {
      if (shape.type === "session-card") {
        const sid = (shape.props as SessionCardShapeProps).sessionId;
        if (sid) existing.set(sid, shape);
      }
    }
    const runningIds = new Set(snapshot.runningSessionIds);
    const toCreate: TLShapePartial[] = [];
    const toUpdate: TLShapePartial[] = [];
    const now = Date.now();
    let y = 0;
    for (const sid of snapshot.runningSessionIds) {
      const state = snapshot.states[sid] as RunningSessionState | undefined;
      const shape = existing.get(sid);
      const phase = state ? (state.phase as CanvasPhase) : "waiting_model";
      const runningMs = state?.startedAt ? now - state.startedAt : 0;
      const summary = titles[sid];
      if (!shape) {
        toCreate.push({
          id: createShapeId(),
          type: "session-card",
          x: 60,
          y: 60 + y * (CARD_H + 24),
          props: {
            sessionId: sid,
            title: summary?.title ?? "Running session",
            projectName: summary?.projectName ?? "",
            messageCount: summary?.messageCount ?? 0,
            lastReply: summary?.lastReply ?? "",
            phase,
            runningMs,
            endedAt: 0,
            stale: false,
            expanded: false,
            w: CARD_W,
            h: CARD_H,
          },
        });
        y += 1;
      } else {
        toUpdate.push({
          id: shape.id,
          type: "session-card",
          props: {
            phase,
            runningMs,
            title: summary?.title ?? (shape.props as SessionCardShapeProps).title,
          },
        });
      }
    }
    // 结束后保留 30s（灰化已结束）再移除
    const nowTs = Date.now();
    for (const [sid, shape] of existing) {
      if (runningIds.has(sid)) continue;
      const p = shape.props as SessionCardShapeProps;
      if (p.phase === "just-ended") {
        // 用独立 endedAt 判定 30s（runningMs 每轮被覆盖，不能当结束时间戳）
        if (shouldRemoveEndedCard(p.phase, p.endedAt, nowTs)) {
          editor.deleteShapes([shape.id]);
        }
      } else {
        // 首次变为结束：标记 just-ended + 记录结束时刻
        toUpdate.push({ id: shape.id, type: "session-card", props: { phase: "just-ended", endedAt: nowTs } });
      }
    }
    if (toCreate.length > 0) editor.createShapes(toCreate);
    if (toUpdate.length > 0) editor.updateShapes(toUpdate);
  }, []);

  // 普通看板：按 running snapshot 更新已有卡片的 phase/runningMs（只更新，不建不删）
  const updateCardRunningState = useCallback((editor: Editor, snapshot: RunningSnapshot) => {
    const updates: TLShapePartial[] = [];
    const now = Date.now();
    for (const shape of editor.getCurrentPageShapes()) {
      if (shape.type !== "session-card") continue;
      const p = shape.props as SessionCardShapeProps;
      if (!p.sessionId) continue;
      const state = snapshot.states[p.sessionId] as RunningSessionState | undefined;
      const runningNow = snapshot.runningSessionIds.includes(p.sessionId);
      if (runningNow && state) {
        const phase = state.phase as CanvasPhase;
        const runningMs = state.startedAt ? now - state.startedAt : 0;
        // 从结束态回到运行中：清 endedAt
        if (p.phase !== phase || p.runningMs !== runningMs || p.endedAt !== 0) {
          updates.push({ id: shape.id, type: "session-card", props: { phase, runningMs, endedAt: 0 } });
        }
      } else if (!runningNow && p.phase !== "idle") {
        // 不在运行列表 → idle（普通看板不保留 just-ended 卡片，不自动删）
        updates.push({ id: shape.id, type: "session-card", props: { phase: "idle", runningMs: 0, endedAt: 0 } });
      }
    }
    if (updates.length > 0) editor.updateShapes(updates);
  }, []);

  // ---- 添加会话节点 ----
  const addSessionNode = useCallback((sessionId: string, x?: number, y?: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    const summary = sessionTitles[sessionId];
    const bid = boardIdRef.current;
    const node: BoardNode = {
      id: crypto.randomUUID(),
      boardId: bid,
      kind: "session",
      refId: sessionId,
      x: x ?? 60 + Math.random() * 120,
      y: y ?? 60 + Math.random() * 120,
      w: CARD_W,
      h: CARD_H,
      expanded: false,
      props: {},
      created: Date.now(),
      updated: Date.now(),
    };
    editor.createShapes([{
      id: createShapeId(node.id),
      type: "session-card",
      x: node.x,
      y: node.y,
      props: {
        sessionId,
        title: summary?.title ?? "Untitled",
        projectName: summary?.projectName ?? "",
        messageCount: summary?.messageCount ?? 0,
        lastReply: summary?.lastReply ?? "",
        phase: "idle",
        runningMs: 0,
        endedAt: 0,
        stale: false,
        expanded: false,
        w: CARD_W,
        h: CARD_H,
      },
    }]);
  }, [sessionTitles]);

  // ---- 连线 ----
  const connectNodes = useCallback((fromNodeId: string, toNodeId: string, label?: string, color?: string, dashed?: boolean) => {
    const editor = editorRef.current;
    if (!editor) return;
    const fromShape = editor.getShape(fromNodeId as never);
    const toShape = editor.getShape(toNodeId as never);
    if (!fromShape || !toShape || fromNodeId === toNodeId) return;
    const edgeId = crypto.randomUUID();
    editor.createShapes([{
      id: createShapeId(edgeId),
      type: "arrow",
      x: 0,
      y: 0,
      props: {
        start: { x: fromShape.x, y: fromShape.y },
        end: { x: toShape.x, y: toShape.y },
        color: (color as TLArrowShape["props"]["color"]) ?? "blue",
        dash: dashed ? "dashed" : "solid",
        arrowheadStart: "none",
        arrowheadEnd: "arrow",
        labelColor: "black",
        font: "sans",
        richText: toRichText(label ?? ""),
        scale: 1,
        size: "m",
        bend: 0,
        kind: "elbow",
        labelPosition: 0.5,
        elbowMidPoint: 0.5,
      } as TLArrowShape["props"],
      meta: { fromId: fromNodeId, toId: toNodeId } as never,
    }]);
  }, []);

  // ---- 清理失效节点 ----
  const cleanupInvalid = useCallback(async () => {
    const bid = boardIdRef.current;
    if (bid === SYSTEM_RUNNING_BOARD_ID) return;
    try {
      const res = await fetch(`/api/boards/${encodeURIComponent(bid)}/nodes/cleanup`, { method: "POST" });
      if (res.ok) {
        const data = (await res.json()) as { removed: string[] };
        const editor = editorRef.current;
        if (editor && data.removed.length > 0) {
          const ids = new Set(data.removed.map((id) => `shape:${id}`));
          const toDelete = editor.getCurrentPageShapes().filter((s) => ids.has(s.id)).map((s) => s.id);
          if (toDelete.length > 0) editor.deleteShapes(toDelete);
        }
        await load();
      }
    } catch (e) {
      console.error("[board] cleanup failed", e);
    }
  }, [load]);

  // 序列化工具导出（供 Workbench 使用）
  const getNodeIdForSession = useCallback((sessionId: string): string | null => {
    const editor = editorRef.current;
    if (!editor) return null;
    for (const shape of editor.getCurrentPageShapes()) {
      if (shape.type === "session-card" && (shape.props as SessionCardShapeProps).sessionId === sessionId) {
        return shape.id.replace("shape:", "");
      }
    }
    return null;
  }, []);

  return useMemo(() => ({
    board,
    loading,
    error,
    running,
    runningCount: running?.runningSessionIds.length ?? 0,
    onMount,
    addSessionNode,
    connectNodes,
    cleanupInvalid,
    getNodeIdForSession,
    reloadCanvas: reloadCanvasWrap,
    conflictCount,
    sessionTitles,
    loadSessionSummaries,
    hydrateShapes,
  }), [board, loading, error, running, onMount, addSessionNode, connectNodes, cleanupInvalid, getNodeIdForSession, reloadCanvasWrap, conflictCount, sessionTitles, loadSessionSummaries, hydrateShapes]);
}

export type UseBoardCanvasReturn = ReturnType<typeof useBoardCanvas>;

// ---- 辅助 ----

type SessionCardShapeProps = {
  sessionId: string;
  title: string;
  projectName: string;
  messageCount: number;
  lastReply: string;
  phase: CanvasPhase;
  runningMs: number;
  endedAt: number;
  stale: boolean;
  expanded: boolean;
  w: number;
  h: number;
};

function toRichText(text: string) {
  return {
    type: "doc" as const,
    content: text ? [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }] : [],
  };
}

function richTextToString(rt: unknown): string {
  if (!rt || typeof rt !== "object") return "";
  const doc = rt as { content?: Array<{ content?: Array<{ text?: string }> }> };
  if (!Array.isArray(doc.content)) return "";
  return doc.content
    .map((p) => (p.content ?? []).map((c) => c.text ?? "").join(""))
    .join("\n")
    .trim();
}
