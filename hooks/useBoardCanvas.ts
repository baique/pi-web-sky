"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor, TLShapePartial } from "tldraw";
import { createShapeId, defaultShapeUtils } from "tldraw";
import { useSync } from "@tldraw/sync";
import { inlineBase64AssetStore } from "@tldraw/editor";
import type { BoardInfo, RunningSnapshot } from "@/lib/board-types";
import { dispatchBoardSessionDeleted } from "@/lib/board-events";
import { confirm } from "@/components/canvas/ConfirmDialog";
import { SessionCardUtil } from "@/components/canvas/SessionCardShape";
import { StickyNoteUtil } from "@/components/canvas/StickyNoteShape";
import { TaskCardUtil } from "@/components/canvas/TaskCardShape";

// ============================================================================
// 看板画布（tldraw sync 版）
//
// 数据层：useSync 连接文档（每看板一个 TLSocketRoom，CRDT 自动合并冲突）。
//   前端不再 hydrate/serialize/全量保存/乐观锁/409 重灌——画布即文档，
//   任何编辑（拖拽/增删/缩放）经 CRDT 同步到所有客户端并持久化。
//
// 业务层：
//   - 补卡 + 派生边（exec 线）由前端 reconcile 渲染：读业务数据
//     （任务会话 / 任务卡 sessionId）→ diff 画布 → editor 创建 shape
//     （确定性 id → 幂等，CRDT 合并，不冲突）。
//   - 运行状态/会话摘要：轮询更新 shape props（同步到文档，多端一致）。
//   - 删除（会话/任务卡）：确认制 → editor 删 shape（CRDT）+ 调业务 API。
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

/** 收合卡默认尺寸 */
export const CARD_W = 340;
export const CARD_H = 160;
/** 展开工作台默认尺寸 */
export const WORKBENCH_W = 760;
export const WORKBENCH_H = 600;
/** 新会话卡默认展开尺寸（与 SessionCardShape EXPANDED_DEFAULT 一致） */
const NEW_SESSION_CARD_W = 840;
const NEW_SESSION_CARD_H = 600;

/** sync 地址：默认同端口（server.mjs 内嵌，独立进程场景可用 NEXT_PUBLIC_SYNC_WS 覆盖） */
const SYNC_BASE = process.env.NEXT_PUBLIC_SYNC_WS ?? "ws://127.0.0.1:30143";

export type CanvasPhase = "waiting_model" | "running_tools" | "running_command" | "waiting_input" | "idle" | "just-ended";

/** 自定义 shape 列表（与 sync-server schema 对齐）——模块级常量，useSync 依赖稳定引用 */
const BOARD_SHAPE_UTILS = [...defaultShapeUtils, SessionCardUtil, StickyNoteUtil, TaskCardUtil];

type SessionCardProps = {
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
  expandedW?: number;
  expandedH?: number;
  collapsedW?: number;
  collapsedH?: number;
};

export function useBoardCanvas({
  boardId,
  taskId,
  newSessionCwd,
}: {
  boardId: string;
  /** 任务看板模式：非空时按任务内会话自动补卡 + 补派生边（任务即看板） */
  taskId?: string;
  /** 看板新建会话绑定的工作目录（来自左侧栏选中目录 activeCwd） */
  newSessionCwd?: string;
}) {
  const [board, setBoard] = useState<BoardInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const editorRef = useRef<Editor | null>(null);
  const boardIdRef = useRef(boardId);
  boardIdRef.current = boardId;
  // 任务看板 id：prop taskId 优先；URL ?board= 恢复任务看板时 board.taskId 兜底
  const boardTaskId = board?.taskId ?? null;
  const effectiveTaskId = taskId ?? boardTaskId;
  const taskIdRef = useRef(effectiveTaskId);
  taskIdRef.current = effectiveTaskId;
  const newSessionCwdRef = useRef(newSessionCwd);
  newSessionCwdRef.current = newSessionCwd;

  // ---- useSync：连接看板文档（CRDT 同步 + SQLite 持久化）----
  const syncStore = useSync({
    uri: `${SYNC_BASE}/connect/${encodeURIComponent(boardId)}`,
    assets: inlineBase64AssetStore,
    shapeUtils: BOARD_SHAPE_UTILS,
  });

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

  // ---- 运行中快照轮询：更新卡片 phase/runningMs + 任务卡徽章 + 即时补卡 ----
  const [running, setRunning] = useState<RunningSnapshot | null>(
    () => (globalThis as { __piRunningSnapshot?: RunningSnapshot }).__piRunningSnapshot ?? null,
  );
  const setRunningCached = useCallback((data: RunningSnapshot) => {
    (globalThis as { __piRunningSnapshot?: RunningSnapshot }).__piRunningSnapshot = data;
    setRunning(data);
  }, []);
  const runningPollInFlightRef = useRef(false);
  const runningReconcileAtRef = useRef(0);
  const runningTaskCardIdsRef = useRef<Set<string>>(new Set());
  const reconcileRef = useRef<() => Promise<void>>(async () => {});
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
        const editor = editorRef.current;
        if (!editor) return;
        const updates: TLShapePartial[] = [];
        for (const shape of editor.getCurrentPageShapes()) {
          if (shape.type === "session-card") {
            const p = shape.props as SessionCardProps;
            if (!p.sessionId) continue;
            const state = data.states[p.sessionId] as { phase?: CanvasPhase; startedAt?: number } | undefined;
            const runningNow = data.runningSessionIds.includes(p.sessionId);
            if (runningNow && state) {
              const phase = (state.phase as CanvasPhase) ?? "waiting_model";
              const runningMs = state.startedAt ? Date.now() - state.startedAt : 0;
              if (p.phase !== phase || p.runningMs !== runningMs || p.endedAt !== 0) {
                updates.push({ id: shape.id, type: "session-card", props: { phase, runningMs, endedAt: 0 } });
              }
            } else if (!runningNow && p.phase !== "idle") {
              updates.push({ id: shape.id, type: "session-card", props: { phase: "idle", runningMs: 0, endedAt: 0 } });
            }
          } else if (shape.type === "task-card") {
            const p = shape.props as { cardId?: string; execStatus?: string };
            if (!p.cardId) continue;
            const st = data.taskCards?.find((c) => c.cardId === p.cardId && c.boardId === boardIdRef.current);
            if (st && st.execStatus !== p.execStatus) {
              updates.push({ id: shape.id, type: "task-card", props: { execStatus: st.execStatus as never } });
            }
          }
        }
        if (updates.length > 0) editor.updateShapes(updates);
        // 新进入 running 的任务卡 → 即时补卡/补线（压到 running 2.5s）
        const known = runningTaskCardIdsRef.current;
        const newlyRunning = (data.taskCards ?? []).some(
          (c) => c.boardId === boardIdRef.current && c.execStatus === "running" && !known.has(c.cardId),
        );
        for (const c of data.taskCards ?? []) known.add(c.cardId);
        if (newlyRunning && Date.now() - runningReconcileAtRef.current > 2000) {
          runningReconcileAtRef.current = Date.now();
          void reconcileRef.current();
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

  // 摘要 → 写回 session-card shape（标题/最后回复实时刷新；同步到文档）
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !editorReady) return;
    if (Object.keys(sessionTitles).length === 0) return;
    const updates: TLShapePartial[] = [];
    for (const shape of editor.getCurrentPageShapes()) {
      if (shape.type !== "session-card") continue;
      const p = shape.props as SessionCardProps;
      const s = sessionTitles[p.sessionId];
      if (!s) continue;
      if (p.title !== s.title || p.lastReply !== s.lastReply || p.messageCount !== s.messageCount || p.lastActivityAt !== s.lastActivityAt) {
        updates.push({
          id: shape.id,
          type: "session-card",
          props: { title: s.title, lastReply: s.lastReply, messageCount: s.messageCount, lastActivityAt: s.lastActivityAt },
        });
      }
    }
    if (updates.length > 0) editor.updateShapes(updates);
  }, [sessionTitles, editorReady]);

  // ---- tldraw 挂载 ----
  const onMount = useCallback((editor: Editor) => {
    editorRef.current = editor;
    setEditorReady(true);
    // 删除语义（原子-链接，确认制）：
    // - 派生边（taskLinkLabel / execLinkLabel）：禁删（由 reconcile 补回）
    // - 会话卡 / 任务卡：合并一次确认 → 删 shape（CRDT 同步）+ 调删除 API
    // - 其余（便笺/普通线/草稿卡）：直接删
    const origDeleteShapes = editor.deleteShapes.bind(editor);
    editor.deleteShapes = ((ids: Parameters<typeof origDeleteShapes>[0]) => {
      const idArr = Array.isArray(ids) ? ids : [ids];
      const directDelete: string[] = [];
      const sessionDelete: Array<{ sid: string; shapeId: string }> = [];
      const cardDelete: Array<{ cid: string; shapeId: string }> = [];
      for (const id of idArr) {
        const idStr = typeof id === "string" ? id : id.id;
        const shape = editor.getShape(idStr);
        if (!shape) { directDelete.push(idStr); continue; }
        if (shape.type === "arrow") {
          const am = shape.meta as { taskLinkLabel?: string; execLinkLabel?: string } | undefined;
          if (am?.taskLinkLabel || am?.execLinkLabel) continue; // 派生边禁删
          directDelete.push(idStr);
          continue;
        }
        if (shape.type === "session-card") {
          const p = shape.props as { sessionId?: string; cwd?: string };
          // 新会话卡（cwd 非空 = 会话尚未创建）：直接删 shape，不调删除 API（会话文件不存在）
          if (p.sessionId && !p.cwd) sessionDelete.push({ sid: p.sessionId, shapeId: idStr });
          else directDelete.push(idStr);
          continue;
        }
        if (shape.type === "task-card") {
          const cid = (shape.props as { cardId?: string }).cardId;
          if (cid) cardDelete.push({ cid, shapeId: idStr });
          else directDelete.push(idStr); // 空卡直接删
          continue;
        }
        directDelete.push(idStr);
      }
      if (sessionDelete.length > 0 || cardDelete.length > 0) {
        let message: string;
        if (sessionDelete.length > 0 && cardDelete.length > 0) {
          message = `删除 ${sessionDelete.length} 个会话和 ${cardDelete.length} 张任务卡？\n将同时清理画布卡片与关联关系。此操作不可撤销。`;
        } else if (sessionDelete.length > 1) {
          message = `删除 ${sessionDelete.length} 个会话？\n将同时删除画布卡片并断开任务卡关联。此操作不可撤销。`;
        } else if (sessionDelete.length === 1) {
          message = "删除该会话？\n将同时删除画布卡片并断开任务卡关联。此操作不可撤销。";
        } else if (cardDelete.length > 1) {
          message = `删除 ${cardDelete.length} 张任务卡？\n将删除卡/依赖线/执行会话连线；关联的执行会话保留。`;
        } else {
          message = "删除该任务卡？\n将删除任务卡、依赖线与执行会话连线；关联的执行会话保留。此操作不可撤销。";
        }
        void confirm({ message }).then((ok) => {
          if (!ok) return;
          // 确认即删 shape（CRDT 同步）+ 级联删绑定 arrow
          const entityIds = [...sessionDelete.map((d) => d.shapeId), ...cardDelete.map((d) => d.shapeId)];
          const boundArrowIds = new Set<string>();
          for (const sid of entityIds) {
            for (const b of editor.getBindingsInvolvingShape(sid as never, "arrow")) {
              boundArrowIds.add(b.fromId);
            }
          }
          editor.store.remove([...entityIds, ...boundArrowIds, ...directDelete] as never);
          for (const d of sessionDelete) {
            fetch(`/api/sessions/${encodeURIComponent(d.sid)}`, { method: "DELETE" })
              .then(() => dispatchBoardSessionDeleted(d.sid))
              .catch((e) => console.warn(`[board] 删除会话 ${d.sid} 异常`, e));
          }
          for (const d of cardDelete) {
            fetch(`/api/task-cards/${encodeURIComponent(d.cid)}`, { method: "DELETE" }).catch((e) =>
              console.warn(`[board] 删除任务卡 ${d.cid} 异常`, e),
            );
          }
        });
        return editor;
      }
      if (directDelete.length > 0) origDeleteShapes(directDelete as never);
      return editor;
    }) as typeof origDeleteShapes;
  }, []);

  const findFreeSpot = useCallback((editor: Editor): { x: number; y: number } => {
    const STEP = 24;
    const PER_ROW = 4;
    const occupied = editor
      .getCurrentPageShapes()
      .filter((s) => s.type === "session-card")
      .map((s) => ({ x: s.x, y: s.y, w: (s.props as SessionCardProps).w || CARD_W, h: (s.props as SessionCardProps).h || CARD_H }));
    const overlaps = (x: number, y: number) =>
      occupied.some((o) => x < o.x + o.w + STEP && x + CARD_W + STEP > o.x && y < o.y + o.h + STEP && y + CARD_H + STEP > o.y);
    let y = 60;
    let guard = 0;
    while (guard < 2000) {
      for (let col = 0; col < PER_ROW; col += 1) {
        const x = 60 + col * (CARD_W + STEP);
        if (!overlaps(x, y)) return { x, y };
      }
      y += CARD_H + STEP;
      guard += 1;
    }
    return { x: 60 + Math.random() * 120, y: 60 + Math.random() * 120 };
  }, []);

  // ---- 派生边 reconcile（核心）：补卡 + exec 线 + 依赖线 + 孤儿清理 ----
  const reconcileInFlightRef = useRef(false);
  const reconcile = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || reconcileInFlightRef.current) return;
    const tid = taskIdRef.current;
    const bid = boardIdRef.current;
    if (!tid) return; // 只对任务看板补卡/补线；普通看板会话卡由用户拖入/新建管理
    reconcileInFlightRef.current = true;
    try {
      const [taskRes, cardsRes] = await Promise.all([
        fetch(`/api/tasks/${encodeURIComponent(tid)}`, { cache: "no-store" }).catch(() => null),
        fetch(`/api/task-cards?boardId=${encodeURIComponent(bid)}`, { cache: "no-store" }).catch(() => null),
      ]);
      if (!taskRes?.ok || !cardsRes?.ok) return;
      const taskData = (await taskRes.json()) as { task?: { sessionIds?: string[] } | null };
      const cardsData = (await cardsRes.json()) as { cards: Array<{
        id: string; sessionId: string | null; name: string; number: number;
        links?: Array<{ targetCardId: string; kind: string }>;
      }> };

      const shapes = editor.getCurrentPageShapes();
      // 1) 补/清会话卡：任务会话缺卡 → createShape；孤儿卡（非任务会话且非新会话卡）→ 删
      //    确定性 id（session-<sid>）→ 幂等。
      const existingSessions = new Map<string, string>(); // sid -> shapeId
      const sessionShapes = new Map<string, string>(); // sid -> shapeId
      for (const s of shapes) {
        if (s.type !== "session-card") continue;
        const sid = (s.props as SessionCardProps).sessionId;
        if (!sid) continue; // 无 sessionId 的旧数据跳过
        existingSessions.set(sid, s.id);
        sessionShapes.set(sid, s.id);
      }
      const sessionIds = new Set(taskData.task?.sessionIds ?? []);
      // 孤儿卡：任务会话里没有 → 删（任务看板会话卡都由任务驱动）
      // 跳过新会话卡（cwd 非空 = 会话尚未创建，sessionId 不在任务列表是正常的）
      for (const [sid, shapeId] of existingSessions) {
        if (sessionIds.has(sid)) continue;
        const p = editor.getShape(shapeId as never);
        if (p && (p.props as SessionCardProps).cwd) continue;
        editor.deleteShapes([shapeId as never]);
      }
      // 新会话卡占位：任务看板下 cwd 非空 且 taskId 匹配本任务的卡正在创建
      //（用户刚点 +、首条消息尚未发出/正在创建）→ 跳过补卡，避免与真实会话卡并存
      const hasPendingNew = shapes.some(
        (s) => s.type === "session-card" && (s.props as SessionCardProps).cwd && (s.props as SessionCardProps).taskId === tid,
      );
      if (!hasPendingNew) {
        for (const sid of sessionIds) {
          if (existingSessions.has(sid)) continue;
          const summary = sessionTitlesRef.current[sid];
          const p = findFreeSpot(editor);
          editor.createShape({
            id: createShapeId(`session-${sid}`),
            type: "session-card",
            x: p.x,
            y: p.y,
            props: {
              sessionId: sid, title: summary?.title ?? "Untitled", projectName: summary?.projectName ?? "",
              messageCount: summary?.messageCount ?? 0, lastReply: summary?.lastReply ?? "",
              lastActivityAt: summary?.lastActivityAt ?? 0, phase: "idle", runningMs: 0, endedAt: 0,
              stale: false, expanded: false, w: CARD_W, h: CARD_H,
            } as never,
          });
        }
      }
      // 2) 补/同步 exec 线：任务卡 sessionId → 卡节点 + 会话节点都存在 → 建线；
      //    卡已绑定但线指向旧会话（重绑定）→ 删旧线换新线。
      //    meta.execLinkLabel 标记禁删；确定性 id（exec-<cardId>-<sessionId>）→ 幂等。
      const cardShapes = new Map<string, string>(); // cardId -> shapeId
      for (const s of shapes) {
        if (s.type === "task-card") {
          const cid = (s.props as { cardId?: string }).cardId;
          if (cid) cardShapes.set(cid, s.id);
        }
      }
      // 按卡分组的现有 exec 线：fromShapeId -> [{ toShapeId, arrowId }]
      const execByCard = new Map<string, Array<{ to: string; arrowId: string }>>();
      for (const s of shapes) {
        if (s.type !== "arrow") continue;
        const m = s.meta as { execLinkLabel?: string } | undefined;
        if (!m?.execLinkLabel) continue;
        const bindings = editor.getBindingsInvolvingShape(s.id, "arrow");
        let from = "", to = "";
        for (const b of bindings) {
          const t = (b.props as { terminal?: string }).terminal;
          if (t === "start") from = b.toId;
          if (t === "end") to = b.toId;
        }
        if (from) {
          const list = execByCard.get(from) ?? [];
          list.push({ to, arrowId: s.id });
          execByCard.set(from, list);
        }
      }
      for (const card of cardsData.cards) {
        const cardShapeId = cardShapes.get(card.id);
        if (!cardShapeId) continue;
        const wanted = card.sessionId ? sessionShapes.get(card.sessionId) : null;
        const existing = execByCard.get(cardShapeId) ?? [];
        // 删端点不匹配的旧线（cardId 相同但 sessionId 变了 / sessionId 已清空）
        for (const e of existing) {
          if (e.to !== wanted) {
            editor.deleteShapes([e.arrowId as never]);
          }
        }
        if (!wanted || existing.some((e) => e.to === wanted)) continue;
        createExecEdge(editor, cardShapeId, wanted, card.id, card.sessionId!);
      }
      // 3) 依赖线（prerequisite/related）：业务 links → 画布 arrow（taskLinkLabel）；
      //    缺补多删（派生边禁删语义由 reconcile 保证）。
      const existingLinks = new Map<string, string>(); // "<from>-><to>:<kind>" -> arrowShapeId
      for (const s of shapes) {
        if (s.type !== "arrow") continue;
        const m = s.meta as { taskLinkLabel?: string } | undefined;
        if (!m?.taskLinkLabel) continue;
        const bindings = editor.getBindingsInvolvingShape(s.id, "arrow");
        let from = "", to = "";
        for (const b of bindings) {
          const t = (b.props as { terminal?: string }).terminal;
          if (t === "start") from = b.toId;
          if (t === "end") to = b.toId;
        }
        if (from && to) existingLinks.set(`${from}->${to}:${m.taskLinkLabel}`, s.id);
      }
      const wantLinks = new Set<string>();
      for (const card of cardsData.cards) {
        const fromShape = cardShapes.get(card.id);
        if (!fromShape) continue;
        for (const link of card.links ?? []) {
          const toShape = cardShapes.get(link.targetCardId);
          if (!toShape) continue;
          const key = `${fromShape}->${toShape}:${link.kind}`;
          wantLinks.add(key);
          if (!existingLinks.has(key)) {
            createLinkEdge(editor, fromShape, toShape, link.kind);
          }
        }
      }
      for (const [key, arrowId] of existingLinks) {
        if (!wantLinks.has(key)) {
          editor.deleteShapes([arrowId as never]);
        }
      }
    } catch {
      // 网络失败静默，下轮重试
    } finally {
      reconcileInFlightRef.current = false;
    }
  }, [findFreeSpot]);

  useEffect(() => {
    reconcileRef.current = reconcile;
  }, [reconcile]);

  // 任务看板打开/10s 轮询触发 reconcile（board 加载后 effectiveTaskId 才完整）
  useEffect(() => {
    if (!effectiveTaskId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      await reconcile();
      if (!stopped) timer = setTimeout(run, SUMMARY_POLL_MS);
    };
    const first = setTimeout(() => void run(), 1200); // 避开 editor 挂载窗口
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
      clearTimeout(first);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [effectiveTaskId, editorReady, reconcile]);

  // ---- 看板新建会话卡：用户点 + 创建一张带 UUID sessionId 的卡（见 addNewSessionCard）。
  // 卡片 sessionId 发起时即确定，ChatWindow isNew 模式发首条消息时直接指定该 ID；
  // 会话创建成功（文件落盘）后由 SessionWorkbench 清 cwd 字段转正为普通卡（CRDT 同步）。
  // 无需事件桥 / 轮询转正。
  const newSessionCascadeRef = useRef(0);
  const addNewSessionCard = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const w = NEW_SESSION_CARD_W;
    const h = NEW_SESSION_CARD_H;
    const vp = editor.getViewportPageBounds();
    let x = vp.minX + (vp.width - w) / 2;
    let y = vp.minY + (vp.height - h) / 2;
    if (h > vp.height) y = vp.minY + 16;
    if (w > vp.width) x = vp.minX + 16;
    const cascade = (newSessionCascadeRef.current % 3) * 24;
    newSessionCascadeRef.current += 1;
    // 新建会话的 ID 发起时即确定（UUID）：卡片从出生就有 sessionId，
    // 用户发首条消息时 ensure_session 直接携带该 ID，服务端用指定 ID 创建会话。
    const sessionId = crypto.randomUUID();
    editor.createShape({
      id: createShapeId(),
      type: "session-card",
      x: x + cascade,
      y: y + cascade,
      props: {
        sessionId, title: "", projectName: "", messageCount: 0, lastReply: "",
        phase: "idle", runningMs: 0, endedAt: 0, lastActivityAt: 0, stale: false,
        expanded: true, cwd: newSessionCwdRef.current ?? "", taskId: taskIdRef.current ?? "",
        w, h,
      } as never,
    });
  }, []);

  // ---- 拖入会话（普通看板）----
  const addSessionNode = useCallback((sessionId: string, x: number, y: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    const summary = sessionTitlesRef.current[sessionId];
    editor.createShape({
      id: createShapeId(`session-${sessionId}`),
      type: "session-card",
      x,
      y,
      props: {
        sessionId, title: summary?.title ?? "Untitled", projectName: summary?.projectName ?? "",
        messageCount: summary?.messageCount ?? 0, lastReply: summary?.lastReply ?? "",
        lastActivityAt: summary?.lastActivityAt ?? 0, phase: "idle", runningMs: 0, endedAt: 0,
        stale: false, expanded: false, w: CARD_W, h: CARD_H,
      } as never,
    });
  }, []);

  // ---- 清空画布 ----
  const clearBoard = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    const isTaskBoard = Boolean(taskIdRef.current);
    const targets = editor.getCurrentPageShapes();
    const toDelete = isTaskBoard
      ? targets.filter((s) => s.type !== "session-card").map((s) => s.id)
      : targets.map((s) => s.id);
    if (toDelete.length > 0) editor.deleteShapes(toDelete);
    if (isTaskBoard) void reconcile();
  }, [reconcile]);

  const loading = syncStore.status !== "synced-remote";

  return useMemo(
    () => ({
      board,
      loading,
      error,
      running,
      runningCount: running?.runningSessionIds.length ?? 0,
      editor: editorReady ? editorRef.current : null,
      /** useSync 返回的 synced store（CanvasStage 传给 <Tldraw store>） */
      syncStore,
      onMount,
      addSessionNode,
      addNewSessionCard,
      clearBoard,
      sessionTitles,
      loadSessionSummaries,
      /** 手动重载：重新拉业务元信息（文档本身 CRDT 自愈，无需重连） */
      reloadCanvas: load,
    }),
    [board, loading, error, running, editorReady, syncStore, onMount, addSessionNode, addNewSessionCard, clearBoard, sessionTitles, loadSessionSummaries, load],
  );
}

export type UseBoardCanvasReturn = ReturnType<typeof useBoardCanvas>;

/** 建 exec 线（派生边）：arrow shape（dashed + meta.execLinkLabel 标记禁删）+ binding 随卡片移动 */
function createExecEdge(editor: Editor, fromShapeId: string, toShapeId: string, cardId: string, sessionId: string): void {
  // id 含 sessionId：卡重绑定（换执行会话）时新 id，配合 reconcile 删旧线
  createDerivedEdge(editor, fromShapeId, toShapeId, `exec-${cardId}-${sessionId}`, { execLinkLabel: "exec" }, true);
}

/** 建依赖线（派生边）：arrow shape（实线 + meta.taskLinkLabel 标记禁删）+ binding */
function createLinkEdge(editor: Editor, fromShapeId: string, toShapeId: string, kind: string): void {
  createDerivedEdge(editor, fromShapeId, toShapeId, `link-${fromShapeId}-${toShapeId}-${kind}`, { taskLinkLabel: kind }, false);
}

function createDerivedEdge(
  editor: Editor,
  fromShapeId: string,
  toShapeId: string,
  idKey: string,
  meta: Record<string, string>,
  dashed: boolean,
): void {
  const id = createShapeId(idKey);
  editor.createShape({
    id,
    type: "arrow",
    x: 0,
    y: 0,
    meta: meta as never,
    props: {
      start: { x: 0, y: 0 },
      end: { x: 0, y: 0 },
      color: "blue",
      fill: "none",
      dash: dashed ? "dashed" : "solid",
      arrowheadStart: "none",
      arrowheadEnd: "arrow",
      labelColor: "black",
      font: "sans",
      richText: { type: "doc", content: [] },
      scale: 1,
      size: "m",
      bend: 0,
      kind: "elbow",
      labelPosition: 0.5,
      elbowMidPoint: 0.5,
    } as never,
  });
  editor.createBindings([
    {
      type: "arrow",
      fromId: id,
      toId: fromShapeId,
      props: { terminal: "start", isPrecise: false, isExact: false, normalizedAnchor: { x: 0.5, y: 0.5 }, snap: "none" },
    } as never,
    {
      type: "arrow",
      fromId: id,
      toId: toShapeId,
      props: { terminal: "end", isPrecise: false, isExact: false, normalizedAnchor: { x: 0.5, y: 0.5 }, snap: "none" },
    } as never,
  ]);
}
