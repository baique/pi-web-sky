"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor, TLArrowShape, TLShape, TLShapePartial } from "tldraw";
import { createShapeId } from "tldraw";
import { isPageId } from "@tldraw/editor";
import type { BoardCanvas, BoardInfo, BoardNode, BoardEdge, BoardView, RunningSnapshot, RunningSessionState } from "@/lib/board-types";
import { SYSTEM_RUNNING_BOARD_ID } from "@/lib/board-types";
import { shouldRemoveEndedCard } from "@/lib/board-utils";
import { dispatchBoardCanvasChanged } from "@/lib/board-events";

/** 会话摘要（卡片展示用）：标题/消息数/项目/最后回复/最后活动时间 */
export type SessionSummary = {
  title: string;
  messageCount: number;
  projectName: string;
  lastReply: string;
  /** 最后一条消息时间（会话文件 mtime，ms epoch） */
  lastActivityAt: number;
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
/** draft 新建会话默认展开尺寸（与 SessionCardShape EXPANDED_DEFAULT 一致：840×600） */
const EXPANDED_DRAFT_W = 840;
const EXPANDED_DRAFT_H = 600;

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
  taskId,
  newSessionCwd,
  onOpenSession,
}: {
  boardId: string;
  projectKey?: string;
  /** 任务看板模式：非空时按任务内会话自动补卡（任务即看板） */
  taskId?: string;
  /** 看板新建会话绑定的工作目录（来自左侧栏选中目录 activeCwd） */
  newSessionCwd?: string;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [board, setBoard] = useState<BoardInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 是否已完成首次物化（渲染用镜像，驱动加载覆盖层）：
  // 覆盖层持续到「数据拉取 + 卡片物化」全部完成，消除空画布窗口，数据安全最大化。
  // 与保护用 hydratedRef 同步（ref 实时读不触发渲染，state 用于 UI）。
  const [hydrated, setHydrated] = useState(false);
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
      // 重新加载即视为未物化：覆盖层持续到本次物化完成（防重载期间空画布/覆盖保存）
      setHydrated(false);
      // 懒加载清理：先删孤儿卡片（左栏删会话后遗留的卡片/连线），再读画布，
      // 确保本次进入不出现孤儿。无孤儿时幂等，开销可忽略。
      await fetch("/api/boards/purge-orphans", { method: "POST", cache: "no-store" }).catch(() => {});
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

  // 任务卡 API 操作（建卡/改依赖/删卡）会 bump boards.updated：监听事件刷新乐观锁基线。
  // 否则本客户端携带旧基线的防抖全量保存会被 409 拒绝 → 触发 reloadCanvasWrap →
  // 弹「保存冲突」提示 + reloadCanvas 全量删 shape 又误触「禁止删除会话」拦截。
  useEffect(() => {
    const onBaseUpdated = (e: Event) => {
      const detail = (e as CustomEvent<{ boardId: string; updated: number }>).detail;
      if (!detail || typeof detail.updated !== "number") return;
      if (detail.boardId !== boardIdRef.current) return;
      baseUpdatedRef.current = detail.updated;
    };
    window.addEventListener("pi-web:board-base-updated", onBaseUpdated);
    return () => window.removeEventListener("pi-web:board-base-updated", onBaseUpdated);
  }, []);

  // 初次物化数据（editor 挂载后再用）
  const [initialCanvas, setInitialCanvas] = useState<BoardCanvas | null>(null);

  // running 轮询触发即时补卡的节流（距上次 ≥2s；reconcile 幂等，补上后不再缺）
  const runningReconcileAtRef = useRef(0);
  // 已见过的 running 任务卡 id 集合（增量检测：新进入 running 的卡才触发补卡）
  const runningTaskCardIdsRef = useRef<Set<string>>(new Set());

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
        // 任务卡状态同步：快照里的活跃卡若属于本画布 → 更新对应 task-card shape 的 execStatus（头部徽章自动刷新）
        const bid = boardIdRef.current;
        const editor = editorRef.current;
        if (bid && editor && data.taskCards?.length) {
          const mine = data.taskCards.filter((c) => c.boardId === bid);
          if (mine.length > 0) {
            const updates: TLShapePartial[] = [];
            for (const shape of editor.getCurrentPageShapes()) {
              if (shape.type !== "task-card") continue;
              const p = shape.props as { cardId?: string; execStatus?: string };
              if (!p.cardId) continue;
              const st = mine.find((c) => c.cardId === p.cardId);
              if (st && st.execStatus !== p.execStatus) {
                updates.push({ id: shape.id, type: "task-card", props: { execStatus: st.execStatus as never } });
              }
            }
            if (updates.length > 0) editor.updateShapes(updates);
          }
          // 任务卡派发即时补卡：running 快照发现「新进入执行中的任务卡」→ 立即触发
          // reconcile 补它的执行会话卡（"挂到任务可见"从 reconcile 10s 压到 running 2.5s；
          // 原子-链接：执行会话在画布上就是普通会话卡）。reconcile 幂等，补上后不再缺。
          const knownIds = runningTaskCardIdsRef.current;
          const newlyRunning = mine.some((c) => c.execStatus === "running" && !knownIds.has(c.cardId));
          for (const c of mine) knownIds.add(c.cardId);
          const nowTs = Date.now();
          if (newlyRunning && nowTs - runningReconcileAtRef.current > 2000) {
            runningReconcileAtRef.current = nowTs;
            void reconcileTaskSessionsRef.current();
          }
        }
      } catch {
        // keep last
      }
    };
    // loop 永远自续（不因 hidden 链断）：hidden 时仅跳过 poll，恢复可见自动继续。
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
  }, []);

  // ---- 会话摘要（标题/消息数/最后回复）用于卡片展示 ----
  const [sessionTitles, setSessionTitles] = useState<Record<string, SessionSummary>>({});
  /** 会话摘要的实时 ref（供 onMount 删除保护等只挂载一次处读取最新值） */
  const sessionTitlesRef = useRef<Record<string, SessionSummary>>({});
  sessionTitlesRef.current = sessionTitles;
  const loadSessionSummaries = useCallback(async () => {
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
    // 画布重挂即视为未物化：HMR 时 Tldraw 会卸载重挂，挂载的是全新空画布。
    // 若保留旧 hydratedRef=true，任务看板自动补卡会在空窗期把默认排列
    // 保存覆盖服务器（用户自定义内容丢失）。复位后，物化完成前的任何
    // createShapes（含补卡）都被 scheduleSave 拒绝写入。
    hydratedRef.current = false;
    hydratingRef.current = false;
    setHydrated(false);
    // 删除语义（原子-链接，确认制）：
    // - 派生边（依赖 taskLinkLabel / 执行会话 execLinkLabel）：禁删（由真相源 reconcile）
    // - 会话卡（sessionId 非空）：确认 → DELETE /api/sessions/[id]（服务端事务清理画布卡/exec 线/任务卡引用/会话文件）→ 删 shape
    // - 任务卡（cardId 非空）：确认 → DELETE /api/task-cards/[id]（级联删依赖/exec 线）→ 删 shape
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
          if (am?.taskLinkLabel || am?.execLinkLabel) continue; // 派生边禁删（跳过）
          directDelete.push(idStr);
          continue;
        }
        if (shape.type === "session-card") {
          const sid = (shape.props as { sessionId?: string }).sessionId;
          if (sid) sessionDelete.push({ sid, shapeId: idStr });
          else directDelete.push(idStr); // draft 卡（未绑定）直接删
          continue;
        }
        if (shape.type === "task-card") {
          const cid = (shape.props as { cardId?: string }).cardId;
          if (cid) cardDelete.push({ cid, shapeId: idStr });
          else directDelete.push(idStr); // 空卡（未建）直接删
          continue;
        }
        directDelete.push(idStr);
      }
      // 会话删除：确认（合并一次）→ 逐个调删除 API（服务端事务清理）→ 成功删 shape
      if (sessionDelete.length > 0) {
        const msg = sessionDelete.length > 1
          ? `删除 ${sessionDelete.length} 个会话？将同时删除画布卡片并断开任务卡关联。此操作不可撤销。`
          : "删除该会话？将同时删除画布卡片并断开任务卡关联。此操作不可撤销。";
        if (window.confirm(msg)) {
          for (const d of sessionDelete) {
            void (async () => {
              try {
                const res = await fetch(`/api/sessions/${encodeURIComponent(d.sid)}`, { method: "DELETE" });
                if (res.ok) origDeleteShapes([d.shapeId as never]);
              } catch { /* 删除失败静默，卡保留 */ }
            })();
          }
        }
      }
      // 任务卡删除：确认 → 逐个调删除 API → 成功删 shape
      if (cardDelete.length > 0) {
        const msg = cardDelete.length > 1
          ? `删除 ${cardDelete.length} 张任务卡？将删除卡/依赖线/执行会话连线；关联的执行会话保留。`
          : "删除该任务卡？将删除任务卡、依赖线与执行会话连线；关联的执行会话保留。此操作不可撤销。";
        if (window.confirm(msg)) {
          for (const d of cardDelete) {
            void (async () => {
              try {
                const res = await fetch(`/api/task-cards/${encodeURIComponent(d.cid)}`, { method: "DELETE" });
                if (res.ok) origDeleteShapes([d.shapeId as never]);
              } catch { /* 静默 */ }
            })();
          }
        }
      }
      // 其余直接删
      if (directDelete.length > 0) origDeleteShapes(directDelete as never);
      return editor;
    }) as typeof origDeleteShapes;
    // 监听 shape 变更 → 防抖保存（仅普通看板）
    if (boardIdRef.current === SYSTEM_RUNNING_BOARD_ID) return;
    const unlisten = editor.store.listen(() => {
      scheduleSave(editor);
    });
    // 切看板/组件卸载时兜底补写：500ms 防抖窗口内切板会把 pending 保存静默丢弃
    // （tldraw dispose 在 store.dispose 之前 emit 'unmount'，此刻 editor 仍可序列化）。
    // 若保存正在途中（saveInFlight），把最终 payload 暂存，由 flushSave 结束后发送
    // （携带最新乐观锁基线，避免被 409 拒绝；也避免对已 dispose 的 editor 反序列化）。
    const onUnmount = () => {
      if (!hydratedRef.current || hydratingRef.current) return;
      const bid = boardIdRef.current;
      if (bid === SYSTEM_RUNNING_BOARD_ID) return;
      const hadPending = Boolean(saveTimerRef.current || pendingSaveRef.current);
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (!hadPending) return;
      let payload: { nodes: BoardNode[]; edges: BoardEdge[]; view: BoardView } | null = null;
      try {
        const { nodes, edges } = serializeShapes(editor);
        if (nodes.length === 0 && edges.length === 0) return;
        const camera = editor.getCamera();
        payload = {
          nodes,
          edges,
          view: { boardId: bid, cameraX: camera.x, cameraY: camera.y, cameraZ: camera.z, updated: Date.now() },
        };
      } catch {
        return;
      }
      if (saveInFlightRef.current) {
        pendingFinalPayloadRef.current = payload;
        return;
      }
      void sendFinalPayload(bid, payload);
    };
    editor.on("unmount", onUnmount);
    return () => {
      unlisten?.();
      editor.off("unmount", onUnmount);
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
      if (p.title !== s.title || p.lastReply !== s.lastReply || p.messageCount !== s.messageCount || p.lastActivityAt !== s.lastActivityAt) {
        updates.push({
          id: shape.id,
          type: "session-card",
          props: { title: s.title, lastReply: s.lastReply, messageCount: s.messageCount, lastActivityAt: s.lastActivityAt },
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
  /** 卸载兜底补写暂存：在途保存进行中时卸载，存下最终 payload，由 flushSave 结束后发送 */
  const pendingFinalPayloadRef = useRef<{ nodes: BoardNode[]; edges: BoardEdge[]; view: BoardView } | null>(null);
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
      // 同时复位 hydratedRef——清空后画布即“未物化”，自动补卡/保存一律跳过，
      // 直到重新物化完成（防 reloadCanvas 窗口内补卡重建默认排列）。
      hydratingRef.current = true;
      hydratedRef.current = false;
      setHydrated(false);
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

  /** 卸载兜底补写：发送最终画布快照（不依赖 editor，卸载后也可调用）。
   *  带最新乐观锁基线；409（他人并发保存）则放弃，绝不覆盖。 */
  const sendFinalPayload = useCallback(async (bid: string, payload: { nodes: BoardNode[]; edges: BoardEdge[]; view: BoardView }) => {
    try {
      const res = await fetch(`/api/boards/${encodeURIComponent(bid)}/canvas`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          baseUpdated: baseUpdatedRef.current ?? undefined,
        }),
      });
      if (!res.ok) {
        if (res.status !== 409) console.error("[board] final flush failed", res.status);
        return;
      }
      const data = (await res.json().catch(() => null)) as { updated?: number } | null;
      if (data?.updated) baseUpdatedRef.current = data.updated;
    } catch {
      // 卸载后的补写失败：静默（防抖路径已尽力，不阻塞）
    }
  }, []);

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
      // 卸载兜底补写优先：卸载时若保存仍在途中，unmount 已把最终 payload 暂存，
      // 此处以最新乐观锁基线发送（editor 可能已 dispose，不能反序列化）。
      const finalPayload = pendingFinalPayloadRef.current;
      if (finalPayload) {
        pendingFinalPayloadRef.current = null;
        const bid = boardIdRef.current;
        void sendFinalPayload(bid, finalPayload);
      } else if (pendingSaveRef.current) {
        pendingSaveRef.current = false;
        void flushSave(editor);
      }
    }
  }, [reloadCanvasWrap, sendFinalPayload]);

  // ---- 物化：sqlite canvas → tldraw shapes ----
  const hydrateShapes = useCallback((editor: Editor, canvas: BoardCanvas, titles: Record<string, SessionSummary>) => {
    const shapes: TLShapePartial[] = [];
    // 节点位置索引（arrow 端点用；父子同节点算一次）
    const nodeById = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (const node of canvas.nodes) {
      nodeById.set(node.id, { x: node.x, y: node.y, w: node.w || CARD_W, h: node.h || CARD_H });
    }
    // 通用 shape 先建（父先子后：sorted 顺序即父先于子；parentId 直接传给 createShapes）
    for (const node of canvas.nodes) {
      if (node.kind !== "shape") continue;
      const p = node.props as { type?: string; rotation?: number; shapeProps?: Record<string, unknown>; parentId?: string | null };
      if (!p?.type || !p.shapeProps) continue;
      shapes.push({
        id: createShapeId(node.id),
        type: p.type as never,
        x: node.x,
        y: node.y,
        rotation: p.rotation ?? 0,
        parentId: p.parentId ? createShapeId(p.parentId) : undefined,
        props: p.shapeProps as never,
      });
    }
    for (const node of canvas.nodes) {
      if (node.kind !== "session") continue;
      const summary = node.refId ? titles[node.refId] : undefined;
      const pp = node.props as { parentId?: string | null };
      shapes.push({
        id: createShapeId(node.id),
        type: "session-card",
        x: node.x,
        y: node.y,
        parentId: pp.parentId ? createShapeId(pp.parentId) : undefined,
        props: {
          sessionId: node.refId ?? "",
          title: summary?.title ?? "Untitled",
          projectName: summary?.projectName ?? "",
          messageCount: summary?.messageCount ?? 0,
          lastReply: summary?.lastReply ?? "",
          lastActivityAt: summary?.lastActivityAt ?? 0,
          phase: "idle",
          runningMs: 0,
          endedAt: 0,
          stale: node.refId ? !titles[node.refId] : false,
          expanded: node.expanded,
          cwd: (node.props as { cwd?: string }).cwd ?? "",
          taskId: (node.props as { taskId?: string }).taskId ?? "",
          // 展开/收合两态手动尺寸：从 board_nodes.props 还原（老数据缺省 → 0 = 用默认）
          expandedW: (node.props as { expandedW?: number }).expandedW ?? 0,
          expandedH: (node.props as { expandedH?: number }).expandedH ?? 0,
          collapsedW: (node.props as { collapsedW?: number }).collapsedW ?? 0,
          collapsedH: (node.props as { collapsedH?: number }).collapsedH ?? 0,
          // 旧默认收合尺寸（280×120）升级到新默认（340×160），容纳最后回复区
          w: node.w === LEGACY_CARD_W && !node.expanded ? CARD_W : node.w || CARD_W,
          h: node.h === LEGACY_CARD_H && !node.expanded ? CARD_H : node.h || CARD_H,
        },
      });
    }
    for (const node of canvas.nodes) {
      // 任务卡：shapeProps 全量恢复（含 cardId/名称/状态/展开等），
      // refId 是服务端绑定的 cardId（转正为准，覆盖 shapeProps 里的旧值）
      if (node.kind !== "taskcard") continue;
      const pp = node.props as { shapeProps?: Record<string, unknown>; parentId?: string | null };
      if (!pp.shapeProps) continue;
      shapes.push({
        id: createShapeId(node.id),
        type: "task-card",
        x: node.x,
        y: node.y,
        parentId: pp.parentId ? createShapeId(pp.parentId) : undefined,
        props: {
          ...(pp.shapeProps as object),
          cardId: node.refId ?? "",
          // 展开/收合两态手动尺寸：从 shapeProps 还原（旧数据缺省 → 0 = 用默认）
          expandedW: (pp.shapeProps?.expandedW as number) ?? 0,
          expandedH: (pp.shapeProps?.expandedH as number) ?? 0,
          collapsedW: (pp.shapeProps?.collapsedW as number) ?? 0,
          collapsedH: (pp.shapeProps?.collapsedH as number) ?? 0,
          w: node.w || (pp.shapeProps.w as number) || 220,
          h: node.h || (pp.shapeProps.h as number) || 120,
        } as never,
      });
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
        // 派生边标记：依赖线（task_card_links）→ taskLinkLabel；执行会话线（exec）→ execLinkLabel。
        // 供右键菜单禁删识别 + deleteShapes 拦截（见 onMount）。
        meta: edge.label === "prerequisite" || edge.label === "related"
          ? { taskLinkLabel: edge.label }
          : edge.label === "exec"
            ? { execLinkLabel: "exec" }
            : undefined,
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
      });
    }
    if (shapes.length > 0) {
      editor.createShapes(shapes);
    }
    // arrow 重建 binding：绑定到目标节点，拖动卡片连线跟随（tldraw 原生管理）。
    // 端点从节点中心（isPrecise:false → 吸附到形状边缘），与序列化端 getBindingsInvolvingShape 闭环。
    const bindingPartials: Parameters<typeof editor.createBindings>[0] = [];
    for (const edge of canvas.edges) {
      if (!nodeById.has(edge.fromId) || !nodeById.has(edge.toId)) continue;
      bindingPartials.push(
        { type: "arrow", fromId: createShapeId(edge.id), toId: createShapeId(edge.fromId), props: { terminal: "start", isPrecise: false, isExact: false, normalizedAnchor: { x: 0.5, y: 0.5 }, snap: "none" } },
        { type: "arrow", fromId: createShapeId(edge.id), toId: createShapeId(edge.toId), props: { terminal: "end", isPrecise: false, isExact: false, normalizedAnchor: { x: 0.5, y: 0.5 }, snap: "none" } },
      );
    }
    if (bindingPartials.length > 0) {
      editor.createBindings(bindingPartials);
    }
  }, []);

  // 初始画布就绪 + editor 已挂载 + 会话摘要就绪 → 物化 nodes/edges/view
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !editorReady || !initialCanvas) return;
    // 摘要未就绪时不物化（标题/失效态依赖它），就绪后由本 effect 重跑。
    // 例外：画布只有 draft 卡（refId 全空）时不依赖摘要，直接物化。
    const needsTitles = initialCanvas.nodes.some((n) => n.kind === "session" && n.refId);
    if (needsTitles && Object.keys(sessionTitles).length === 0) return;
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
    setHydrated(true);
    // 画布加载后兜底 reconcile 任务卡派生边（依赖线 + exec 线）：历史数据补线，幂等。
    // reconcile 建边会 bump boards.updated → 用返回值刷新乐观锁基线，防后续防抖保存 409。
    if (boardIdRef.current !== SYSTEM_RUNNING_BOARD_ID) {
      void (async () => {
        try {
          const res = await fetch(`/api/boards/${encodeURIComponent(boardIdRef.current)}/reconcile-task-edges`, {
            method: "POST",
            cache: "no-store",
          });
          if (res.ok) {
            const d = (await res.json().catch(() => null)) as { updated?: number } | null;
            if (d?.updated) baseUpdatedRef.current = d.updated;
          }
        } catch {
          // 兜底静默：无派生边/网络失败不影响画布
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCanvas, sessionTitles, hydrateShapes, editorReady]);

  // ---- 序列化：tldraw shapes → sqlite canvas ----
  const serializeShapes = useCallback((editor: Editor) => {
    const nodes: BoardNode[] = [];
    const edges: BoardEdge[] = [];
    const bid = boardIdRef.current;
    const ts = Date.now();
    // 用 Sorted（含 group/container 内部子 shape）而非顶层，否则 group 内 shape 全丢。
    // Sorted 顺序为父先子后的 DFS，存 parentId 后 hydrate 可按同序重建。
    const pageShapes = editor.getCurrentPageShapesSorted();
    for (const shape of pageShapes) {
      const parentId = isPageId(shape.parentId) ? null : shape.parentId.replace("shape:", "");
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
          props: {
            parentId,
            cwd: p.cwd ?? "",
            taskId: p.taskId ?? "",
            // 展开/收合两态手动尺寸随节点 props 持久化（刷新不丢）
            expandedW: p.expandedW ?? 0,
            expandedH: p.expandedH ?? 0,
            collapsedW: p.collapsedW ?? 0,
            collapsedH: p.collapsedH ?? 0,
          },
          created: ts,
          updated: ts,
        });
      } else if (shape.type === "task-card") {
        // 任务卡：kind=taskcard，refId=cardId（空卡 cardId 为空串→null）。
        // 建卡后由服务端绑定 refId（不新建 node），shape props 全量存 shapeProps 供 hydrate 恢复。
        const p = shape.props as { cardId?: string; expanded?: boolean; w?: number; h?: number };
        nodes.push({
          id: shape.id.replace("shape:", ""),
          boardId: bid,
          kind: "taskcard",
          refId: p.cardId || null,
          x: shape.x,
          y: shape.y,
          w: p.w ?? 0,
          h: p.h ?? 0,
          expanded: Boolean(p.expanded),
          props: { parentId, shapeProps: { ...shape.props } },
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
          props: { type: s.type, rotation, shapeProps, parentId },
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
            lastActivityAt: summary?.lastActivityAt ?? 0,
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
            lastActivityAt: summary?.lastActivityAt ?? (shape.props as SessionCardShapeProps).lastActivityAt ?? 0,
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
        lastActivityAt: summary?.lastActivityAt ?? 0,
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

  // ---- 自动摆放：画布内找第一个不遮挡的空位 ----
  // 从 (60, 60) 起逐行扫描（y 递增、x 递增），候选矩形与所有现有
  // session-card 不重叠且间隙 ≥ 24 即返回。画布无限，最坏也很快。
  const findFreeSpot = useCallback((editor: Editor): { x: number; y: number } => {
    const STEP = 24;
    const PER_ROW = 4; // 每行最多 4 张卡片
    const occupied = editor.getCurrentPageShapes()
      .filter((s) => s.type === "session-card")
      .map((s) => ({ x: s.x, y: s.y, w: (s.props as SessionCardShapeProps).w || CARD_W, h: (s.props as SessionCardShapeProps).h || CARD_H }));
    const overlaps = (x: number, y: number) => occupied.some(
      (o) => x < o.x + o.w + STEP && x + CARD_W + STEP > o.x && y < o.y + o.h + STEP && y + CARD_H + STEP > o.y,
    );
    let y = 60;
    let guard = 0;
    while (guard < 2000) {
      // 每行固定 4 列：第 1 行 (60, 60)，第 2 行 (60, 60+行高)，依此类推
      for (let col = 0; col < PER_ROW; col += 1) {
        const x = 60 + col * (CARD_W + STEP);
        if (!overlaps(x, y)) return { x, y };
      }
      y += CARD_H + STEP;
      guard += 1;
    }
    // 兜底：几乎不可能走到，给个偏移位置避免与 (60,60) 重叠
    return { x: 60 + Math.random() * 120, y: 60 + Math.random() * 120 };
  }, []);

  // ---- 新建会话 draft 卡 ----
  // 看板右上角 + 按钮：在视口中心创建一张展开态 draft 卡（sessionId=""，宽 840 高 600），
  // 内部直接是新建会话工作台 + 输入框。用户在卡内发送消息 → ChatWindow 走
  // ensure_session 拿到 realId → bindDraftSession 把卡片 sessionId 写回转正。
  // 连续新建的级联偏移计数（避免多张卡完全重叠在视口中心）。
  const draftCascadeRef = useRef(0);
  const addDraftCard = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const w = EXPANDED_DRAFT_W;
    const h = EXPANDED_DRAFT_H;
    // 视口页坐标（含相机）：新建会话出现在用户眼前（视口中心），不按画布空位扫描。
    const vp = editor.getViewportPageBounds();
    let x = vp.minX + (vp.width - w) / 2;
    let y = vp.minY + (vp.height - h) / 2;
    // 卡片比视口大：顶部/左侧对齐视口边缘（留 16 间隙），保证标题栏/收起按钮可见
    if (h > vp.height) y = vp.minY + 16;
    if (w > vp.width) x = vp.minX + 16;
    // 级联：连续新建小幅右移下移，避免完全重叠
    const cascade = (draftCascadeRef.current % 3) * 24;
    draftCascadeRef.current += 1;
    x += cascade;
    y += cascade;
    editor.createShapes([{
      id: createShapeId(),
      type: "session-card",
      x,
      y,
      props: {
        sessionId: "",
        title: "",
        projectName: "",
        messageCount: 0,
        lastReply: "",
        phase: "idle",
        runningMs: 0,
        endedAt: 0,
        stale: false,
        expanded: true,
        cwd: newSessionCwdRef.current ?? "",
        taskId: effectiveTaskIdRef.current ?? "",
        w,
        h,
      },
    }]);
  }, []);

  // draft 卡转正：用户发出首条消息、ensure_session 返回 realId 后调用。
  // 更新卡片 sessionId（随 store 变更自动持久化）。
  const bindDraftSession = useCallback((nodeId: string, sessionId: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.updateShapes([{
      id: createShapeId(nodeId),
      type: "session-card",
      props: { sessionId },
    }]);
  }, []);

  // draft 卡转正事件：SessionWorkbench 内 ChatWindow 拿到 realId 后派发
  // board-session-created，本 hook 监听并把对应卡片 sessionId 写回（转正）。
  // 同时清掉 cwd/taskId（不再需要），store 变更自动持久化。
  useEffect(() => {
    const onCreated = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId: string; nodeId?: string }>).detail;
      if (!detail?.sessionId || !detail?.nodeId) return;
      const sessionId = detail.sessionId;
      const nodeId = detail.nodeId;
      const editor = editorRef.current;
      if (!editor) return;
      const shapeId = createShapeId(nodeId);
      const shape = editor.getShape(shapeId);
      if (!shape || shape.type !== "session-card") return;
      editor.updateShapes([{
        id: shapeId,
        type: "session-card",
        props: { sessionId, cwd: "", taskId: "" },
      }]);
      // 转正绑定定向持久化：立即把节点 refId 写库，不依赖 500ms 防抖全量保存
      // （切板窗口内防抖保存会被丢弃，导致切回后卡片仍是 draft「New session」）。
      // PATCH 会 bump boards.updated → 携带旧基线的迟到全量保存会被 409 拒绝，
      // 不会回头把绑定覆盖回 draft。成功后刷新乐观锁基线避免下次保存误报 409。
      const bid = boardIdRef.current;
      if (bid !== SYSTEM_RUNNING_BOARD_ID) {
        void (async () => {
          try {
            const res = await fetch(`/api/boards/${encodeURIComponent(bid)}/nodes/${encodeURIComponent(nodeId)}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ refId: sessionId }),
            });
            if (res.ok) {
              const data = (await res.json().catch(() => null)) as { updated?: number } | null;
              if (data?.updated) baseUpdatedRef.current = data.updated;
            }
          } catch {
            // 兜底：内存已转正，防抖全量保存会带正确 refId
          }
        })();
      }
      // 转正后立即拉一次摘要，让标题/消息数立刻到位（不等 10s 轮询）
      void loadSessionSummaries();
    };
    window.addEventListener("pi-web:board-session-created", onCreated);
    return () => window.removeEventListener("pi-web:board-session-created", onCreated);
  }, [loadSessionSummaries]);

  // ---- 任务看板自动补卡（任务即看板）----
  // 拉取任务内会话 id（根会话集合）→ 与画布现有 session-card 差集 → 自动创建卡片。
  // 旧会话坐标已由 hydrate 从 board_nodes 恢复，这里只补“任务里有、画布上没有”的新会话。
  const reconcileTaskSessions = useCallback(async () => {
    const editor = editorRef.current;
    const tid = effectiveTaskIdRef.current;
    if (!editor || !tid) return;
    // 空窗保护：画布未物化（首次加载 / HMR 重挂 / 409 重载后的空窗期）时跳过补卡。
    // 此刻画布空是“未加载完成”，不是“会话缺失”——补卡会用默认排列重建
    // 并保存覆盖服务器（用户自定义内容丢失）。物化完成（hydratedRef=true）后
    // 由下一轮轮询正常补“任务里有、画布上确实没有”的新会话。
    if (!hydratedRef.current) return;
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(tid)}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { task?: { sessionIds?: string[] } | null };
      const sessionIds = data.task?.sessionIds ?? [];
      const existing = new Set<string>();
      // draft 卡（taskId 匹配本任务）视为已占位：该卡正在转正（ensure_session
      // 已把会话挂到任务下、但卡片 sessionId 尚未写回），补卡会重复建卡。
      let hasPendingDraft = false;
      for (const shape of editor.getCurrentPageShapes()) {
        if (shape.type !== "session-card") continue;
        const p = shape.props as SessionCardShapeProps;
        if (p.sessionId) {
          existing.add(p.sessionId);
        } else if (p.taskId === tid) {
          hasPendingDraft = true;
        }
      }
      // 有待转正 draft 卡时跳过本轮补卡（下轮轮询再校验，避免重复卡）
      if (hasPendingDraft) return;
      // 原子-链接：补所有任务会话（含任务卡的执行会话，occupied 已废除）——
      // 执行会话在画布上就是普通会话卡，任务卡通过 exec 线引用它，不在这里删卡。
      const missing = sessionIds.filter((sid) => !existing.has(sid));
      if (missing.length === 0) return;
      // 只补有效会话：会话文件必须真实存在（在 sessionTitles 里）。
      // 僵尸会话（meta 残留、文件已删）不补卡——补了只会灰化且删不掉。
      // sessionTitles 未就绪时 filter 自然得出空集（不补），无需单独判空。
      const validMissing = missing.filter((sid) => Boolean(sessionTitles[sid]));
      if (validMissing.length === 0) return;
      for (const sid of validMissing) {
        const spot = findFreeSpot(editor);
        addSessionNode(sid, spot.x, spot.y);
      }
      // 补卡后重建任务卡派生边（exec 线指向新节点，幂等）：
      // 画布删卡被 diff 补回（新 node id）后，原 exec 边指向旧节点会悬空，这里对齐。
      if (validMissing.length > 0) {
        void fetch(`/api/boards/${encodeURIComponent(boardIdRef.current)}/reconcile-task-edges`, {
          method: "POST",
          cache: "no-store",
        }).catch(() => {});
      }
    } catch {
      // 网络/解析失败静默，下轮重试
    }
  }, [addSessionNode, findFreeSpot, sessionTitles]);
  // running 快照驱动即时补卡用：指向最新 reconcileTaskSessions（running 轮询 useEffect 依赖 [] 闭包旧值）
  const reconcileTaskSessionsRef = useRef(reconcileTaskSessions);
  reconcileTaskSessionsRef.current = reconcileTaskSessions;
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;
  // 新建会话 cwd（来自左侧栏 activeCwd）：draft 卡工作台经 props 透传，
  // 无需经本 hook；存 ref 供将来可能需要时读取。
  const newSessionCwdRef = useRef(newSessionCwd);
  newSessionCwdRef.current = newSessionCwd;

  // 刷新场景兜底：URL ?board= 恢复任务看板时 props 没有 taskId，但看板本身
  // 是任务型（board.taskId 非空）——自动补卡同样生效。
  const boardTaskId = board?.taskId ?? null;
  const effectiveTaskId = taskId ?? boardTaskId;
  const effectiveTaskIdRef = useRef(effectiveTaskId);
  effectiveTaskIdRef.current = effectiveTaskId;

  // 任务看板自动补卡轮询：打开后先补一次（避开 hydrate 窗口），之后 10s 一次。
  // 与摘要轮询同频；打开期间任务新增会话自动出现在画布上。
  useEffect(() => {
    if (!effectiveTaskId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      if (stopped) return;
      await reconcileTaskSessions();
      if (!stopped) timer = setTimeout(run, SUMMARY_POLL_MS);
    };
    const first = setTimeout(() => { void run(); }, 1000);
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
  }, [effectiveTaskId, reconcileTaskSessions]);

  // ---- 未转正 draft 卡轮询：服务端已绑定（ref_id 已写入）则本地转正 ----
  // 覆盖「创建会话期间切走再切回」：会话创建是服务端异步动作，会话出生即写
  // board_nodes.ref_id（/api/agent/new 带 boardNodeId）。本卡在画布上仍是 draft
  // （sessionId=""），轮询发现 DB 里 ref_id 已有值 → 更新 shape 转正。
  // 适用手动看板 + 任务看板；与任务补卡互不冲突（补卡只看会话，转正只看 draft 卡）。
  const reconcilePendingDrafts = useCallback(async () => {
    const editor = editorRef.current;
    const bid = boardIdRef.current;
    if (!editor || !bid || bid === SYSTEM_RUNNING_BOARD_ID) return;
    const drafts: string[] = [];
    for (const shape of editor.getCurrentPageShapes()) {
      if (shape.type !== "session-card") continue;
      const p = shape.props as SessionCardShapeProps;
      // 仅轮询未转正卡（sessionId 空）；已转正的跳过
      if (!p.sessionId) drafts.push(shape.id.replace("shape:", ""));
    }
    if (drafts.length === 0) return;
    const toBind: Array<{ shapeId: string; nodeId: string; sessionId: string }> = [];
    await Promise.all(drafts.map(async (nodeId) => {
      try {
        const res = await fetch(`/api/boards/${encodeURIComponent(bid)}/nodes/${encodeURIComponent(nodeId)}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { node?: { refId?: string | null } };
        const refId = data.node?.refId;
        if (refId) toBind.push({ shapeId: `shape:${nodeId}`, nodeId, sessionId: refId });
      } catch {
        // 单卡失败静默，下轮重试
      }
    }));
    if (toBind.length === 0) return;
    for (const b of toBind) {
      const shape = editor.getShape(b.shapeId as never);
      if (!shape || shape.type !== "session-card") continue;
      editor.updateShapes([{
        id: b.shapeId as never,
        type: "session-card",
        props: { sessionId: b.sessionId, cwd: "", taskId: "" },
      }]);
    }
    // 服务端绑定会 bump boards.updated：刷新乐观锁基线，避免下一次全量保存误报 409
    try {
      const boardRes = await fetch(`/api/boards/${encodeURIComponent(bid)}`, { cache: "no-store" });
      if (boardRes.ok) {
        const b = (await boardRes.json()) as { board?: { updated?: number } };
        if (b.board?.updated) baseUpdatedRef.current = b.board.updated;
      }
    } catch {
      // 静默
    }
    // 拉一次摘要，让标题/消息数立刻到位
    void loadSessionSummaries();
  }, [loadSessionSummaries]);

  // 未转正卡轮询：进入看板后先跑一次（避开 hydrate 窗口），之后与摘要同频 10s。
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      if (stopped) return;
      await reconcilePendingDrafts();
      if (!stopped) timer = setTimeout(run, SUMMARY_POLL_MS);
    };
    const first = setTimeout(() => { void run(); }, 1500);
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
  }, [reconcilePendingDrafts]);

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

  /** 清空画布：任务看板仅清非会话元素（连线/便笺/文本等，会话卡保留原位）；普通看板全清。显式 allowEmpty 放行防覆盖保护。 */
  const clearBoard = useCallback(async () => {
    const bid = boardIdRef.current;
    if (bid === SYSTEM_RUNNING_BOARD_ID) return;
    const editor = editorRef.current;
    if (!editor) return;
    const isTaskBoard = Boolean(effectiveTaskIdRef.current);
    // 任务看板：会话卡由任务数据源驱动，清空不删会话卡（也不删会话），
    // 只清连线/便笺/文本等非会话元素。普通看板：全清。
    const targets = editor.getCurrentPageShapes();
    const toDelete = isTaskBoard
      ? targets.filter((s) => s.type !== "session-card").map((s) => s.id)
      : targets.map((s) => s.id);
    if (toDelete.length > 0) editor.deleteShapes(toDelete);
    // 服务器落库：任务看板保留会话节点（nodes 非空），普通看板落空。
    // 显式 allowEmpty 绕过「空节点集拒绝覆盖非空看板」兜底。
    const { nodes, edges } = serializeShapes(editor);
    const camera = editor.getCamera();
    try {
      const res = await fetch(`/api/boards/${encodeURIComponent(bid)}/canvas`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodes, edges,
          view: { boardId: bid, cameraX: camera.x, cameraY: camera.y, cameraZ: camera.z, updated: Date.now() },
          baseUpdated: baseUpdatedRef.current ?? undefined,
          allowEmpty: true,
        }),
      });
      if (res.status === 409) {
        console.warn("[board] clear conflict (409) — reloading latest");
        await reloadCanvasWrap();
        return;
      }
      if (!res.ok) {
        console.error("[board] clear failed", res.status);
        return;
      }
      const data = (await res.json().catch(() => null)) as { updated?: number } | null;
      if (data?.updated) baseUpdatedRef.current = data.updated;
      dispatchBoardCanvasChanged(bid);
    } catch (e) {
      console.error("[board] clear error", e);
    }
  }, [reloadCanvasWrap, serializeShapes]);

  return useMemo(() => ({
    board,
    loading,
    /** 是否已完成首次物化（CanvasStage 加载覆盖层依据） */
    hydrated,
    error,
    running,
    runningCount: running?.runningSessionIds.length ?? 0,
    /** tldraw editor 实例（挂载后可用；BoardSearch 等需要访问画布的地方用） */
    editor: editorReady ? editorRef.current : null,
    onMount,
    addSessionNode,
    addDraftCard,
    bindDraftSession,
    connectNodes,
    clearBoard,
    getNodeIdForSession,
    reloadCanvas: reloadCanvasWrap,
    conflictCount,
    sessionTitles,
    loadSessionSummaries,
    hydrateShapes,
    reconcileTaskSessions,
  }), [board, loading, hydrated, error, running, editorReady, onMount, addSessionNode, addDraftCard, bindDraftSession, connectNodes, clearBoard, getNodeIdForSession, reloadCanvasWrap, conflictCount, sessionTitles, loadSessionSummaries, hydrateShapes, reconcileTaskSessions]);
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
