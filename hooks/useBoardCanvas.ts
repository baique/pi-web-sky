"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor, TLArrowShape, TLShape, TLShapePartial } from "tldraw";
import { createShapeId } from "tldraw";
import type { BoardCanvas, BoardInfo, BoardNode, BoardEdge, RunningSnapshot, RunningSessionState } from "@/lib/board-types";
import { SYSTEM_RUNNING_BOARD_ID } from "@/lib/board-types";

/** 收合卡默认尺寸（与 spec §3.1 一致） */
export const CARD_W = 280;
export const CARD_H = 120;
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
  const [running, setRunning] = useState<RunningSnapshot | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const boardIdRef = useRef(boardId);
  boardIdRef.current = boardId;

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
  const initialCanvasRef = useRef<BoardCanvas | null>(null);
  const setInitialCanvas = useCallback((c: BoardCanvas) => {
    initialCanvasRef.current = c;
  }, []);

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
        setRunning(data);
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

  // ---- 会话摘要（标题/消息数）用于卡片展示 ----
  const [sessionTitles, setSessionTitles] = useState<Record<string, { title: string; messageCount: number; projectName: string }>>({});
  const loadSessionSummaries = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { sessions: Array<{ id: string; name?: string; firstMessage?: string; messageCount?: number; projectKey?: string; projectRoot?: string }> };
      const map: Record<string, { title: string; messageCount: number; projectName: string }> = {};
      for (const s of data.sessions) {
        map[s.id] = {
          title: s.name ?? s.firstMessage ?? "Untitled",
          messageCount: s.messageCount ?? 0,
          projectName: s.projectKey ?? s.projectRoot ?? "",
        };
      }
      setSessionTitles(map);
    } catch {
      // keep last
    }
  }, []);

  useEffect(() => {
    void loadSessionSummaries();
  }, [loadSessionSummaries]);

  // ---- tldraw 挂载 ----
  const onMount = useCallback((editor: Editor) => {
    editorRef.current = editor;
    const initial = initialCanvasRef.current;
    if (initial) {
      hydrateShapes(editor, initial, sessionTitles);
      if (initial.view && boardIdRef.current !== SYSTEM_RUNNING_BOARD_ID) {
        editor.setCamera({ x: initial.view.cameraX, y: initial.view.cameraY, z: initial.view.cameraZ });
      }
    }
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

  // ---- 防抖全量保存（单飞） ----
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlightRef = useRef(false);
  const pendingSaveRef = useRef(false);

  const scheduleSave = useCallback((editor: Editor) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => void flushSave(editor), 500);
  }, []);

  const flushSave = useCallback(async (editor: Editor) => {
    const bid = boardIdRef.current;
    if (bid === SYSTEM_RUNNING_BOARD_ID) return;
    if (saveInFlightRef.current) {
      pendingSaveRef.current = true;
      return;
    }
    saveInFlightRef.current = true;
    try {
      const { nodes, edges } = serializeShapes(editor);
      const camera = editor.getCamera();
      const res = await fetch(`/api/boards/${encodeURIComponent(bid)}/canvas`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodes, edges, view: { boardId: bid, cameraX: camera.x, cameraY: camera.y, cameraZ: camera.z, updated: Date.now() } }),
      });
      if (!res.ok) {
        console.error("[board] canvas save failed", res.status);
      }
    } catch (e) {
      console.error("[board] canvas save error", e);
    } finally {
      saveInFlightRef.current = false;
      if (pendingSaveRef.current) {
        pendingSaveRef.current = false;
        void flushSave(editor);
      }
    }
  }, []);

  // ---- 物化：sqlite canvas → tldraw shapes ----
  const hydrateShapes = useCallback((editor: Editor, canvas: BoardCanvas, titles: Record<string, { title: string; messageCount: number; projectName: string }>) => {
    const shapes: TLShapePartial[] = [];
    for (const node of canvas.nodes) {
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
          phase: "idle",
          runningMs: 0,
          stale: node.refId ? !titles[node.refId] : false,
          expanded: node.expanded,
          w: node.w || CARD_W,
          h: node.h || CARD_H,
        },
      });
    }
    for (const edge of canvas.edges) {
      shapes.push({
        id: createShapeId(edge.id),
        type: "arrow",
        x: 0,
        y: 0,
        props: {
          start: { x: 0, y: 0 },
          end: { x: 0, y: 0 },
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
        const meta = (shape.meta ?? {}) as { fromId?: string; toId?: string };
        edges.push({
          id: shape.id.replace("shape:", ""),
          boardId: bid,
          fromId: meta.fromId ?? "",
          toId: meta.toId ?? "",
          label: a.props.richText ? richTextToString(a.props.richText) : null,
          color: a.props.color,
          dashed: a.props.dash === "dashed",
          created: ts,
          updated: ts,
        });
      }
    }
    return { nodes, edges };
  }, []);

  // ---- 运行中看板聚合：running snapshot → 自动物化/更新卡片 ----
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (boardId === SYSTEM_RUNNING_BOARD_ID && running) {
      reconcileRunningBoard(editor, running, sessionTitles);
    }
  }, [running, boardId, sessionTitles]);

  const reconcileRunningBoard = useCallback((editor: Editor, snapshot: RunningSnapshot, titles: Record<string, { title: string; messageCount: number; projectName: string }>) => {
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
            phase,
            runningMs,
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
      if (p.phase === "just-ended" && p.runningMs > 0 && nowTs - p.runningMs > 30_000) {
        toUpdate.push({ id: shape.id, type: "session-card", props: { stale: true } });
        editor.deleteShapes([shape.id]);
      } else if (!runningIds.has(sid)) {
        // 首次变为结束：标记 just-ended（脉冲）。30s 后由下一轮移除。
        if (p.phase !== "just-ended") {
          toUpdate.push({ id: shape.id, type: "session-card", props: { phase: "just-ended", runningMs: nowTs } });
        }
      }
    }
    if (toCreate.length > 0) editor.createShapes(toCreate);
    if (toUpdate.length > 0) editor.updateShapes(toUpdate);
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
        phase: "idle",
        runningMs: 0,
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
    sessionTitles,
    loadSessionSummaries,
    hydrateShapes,
  }), [board, loading, error, running, onMount, addSessionNode, connectNodes, cleanupInvalid, getNodeIdForSession, sessionTitles, loadSessionSummaries, hydrateShapes]);
}

export type UseBoardCanvasReturn = ReturnType<typeof useBoardCanvas>;

// ---- 辅助 ----

type SessionCardShapeProps = {
  sessionId: string;
  title: string;
  projectName: string;
  messageCount: number;
  phase: CanvasPhase;
  runningMs: number;
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
