"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ExecStatus, LinkKind, ReadyStatus, TaskCard, TaskCardLink } from "@/lib/task-card-store";
import { dispatchBoardBaseUpdated, dispatchBoardTasksChanged } from "@/lib/board-events";

/**
 * 任务卡数据 hook：拉取单卡详情（含依赖两向）+ 同看板候选卡（依赖选择用），
 * 提供 createCard / saveCard / deleteCard 操作。卡片 shape 是画布展示层，
 * 业务字段真相源在 task_cards 表，这里负责读写同步。
 */

export interface TaskCardDetail {
  card: TaskCard;
  links: TaskCardLink[];
  inbound: TaskCardLink[];
}

export function useTaskCard(cardId: string | null, boardId: string | null) {
  const [detail, setDetail] = useState<TaskCardDetail | null>(null);
  const [candidates, setCandidates] = useState<TaskCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // detail 最新值 ref（saveCard 用，避免轮询更新重建 callback）
  const detailRef = useRef<TaskCardDetail | null>(null);
  detailRef.current = detail;

  const fetchDetail = useCallback(async (silent = false) => {
    if (!cardId) {
      setDetail(null);
      return;
    }
    // 轮询静默刷新：不置 loading（避免工作台闪烁），只在非静默路径抛错置 error
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`/api/task-cards/${encodeURIComponent(cardId)}`, { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 404) {
          setDetail(null);
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as TaskCardDetail;
      setDetail(data);
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [cardId]);

  const reload = useCallback(() => fetchDetail(false), [fetchDetail]);

  // 单卡详情（cardId 变化/刷新时）
  useEffect(() => {
    void reload();
  }, [reload]);

  // 同看板候选卡（依赖选择 + 编号显示用）
  useEffect(() => {
    if (!boardId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/task-cards?boardId=${encodeURIComponent(boardId)}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { cards: TaskCard[] };
        if (!cancelled) setCandidates(data.cards);
      } catch {
        // 静默失败（候选卡非关键路径）
      }
    })();
    return () => { cancelled = true; };
  }, [boardId]);

  /** 建卡（空卡向导提交 → 派发）：成功后返回 card，供调用方更新 shape props。 */
  const createCard = useCallback(async (input: {
    boardId: string;
    name: string;
    description?: string;
    readyStatus?: ReadyStatus;
    priority?: number;
    due?: number | null;
    attachments?: string[];
    cwd?: string;
    useWorktree?: boolean;
    maxRetries?: number;
    prerequisites?: string[];
    related?: string[];
  }): Promise<TaskCard | null> => {
    try {
      const res = await fetch("/api/task-cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as { card: TaskCard; updated?: number | null };
      // 建卡会 bump boards.updated：派发事件让 useBoardCanvas 刷新乐观锁基线，
      // 避免后续防抖全量保存携带过期基线被 409 拒绝（保存冲突提示的根因）。
      if (typeof j.updated === "number") dispatchBoardBaseUpdated(input.boardId, j.updated);
      // 建卡即派发（readyStatus=todo → 调度器异步建会话并写入 session_meta）：
      // 通知 AppShell 刷新侧栏任务区，新会话落任务分组而不是聊天区。
      dispatchBoardTasksChanged();
      return j.card;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  /** 保存字段（含依赖全量替换），成功后刷新详情。 */
  const saveCard = useCallback(async (patch: {
    name?: string;
    description?: string;
    readyStatus?: ReadyStatus;
    execStatus?: ExecStatus;
    priority?: number;
    due?: number | null;
    attachments?: string[];
    cwd?: string | null;
    useWorktree?: boolean;
    maxRetries?: number;
    prerequisites?: string[];
    related?: string[];
  }): Promise<boolean> => {
    if (!cardId) return false;
    try {
      const res = await fetch(`/api/task-cards/${encodeURIComponent(cardId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as { card: TaskCard; updated?: number | null };
      // 依赖变更（syncCardEdges）会 bump boards.updated：派发事件刷新乐观锁基线。
      if (typeof j.updated === "number" && detailRef.current?.card.boardId) {
        dispatchBoardBaseUpdated(detailRef.current.card.boardId, j.updated);
      }
      // 保存可能改 readyStatus（派发/状态流转）→ 侧栏任务区重新拉取。
      dispatchBoardTasksChanged();
      await reload();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [cardId, reload]);

  return { detail, candidates, loading, error, reload, createCard, saveCard };
}

/** 依赖选择 helper：按 kind 分取出边目标卡 id 列表。 */
export function linkTargetIds(links: TaskCardLink[] | undefined, kind: LinkKind): string[] {
  return (links ?? []).filter((l) => l.kind === kind).map((l) => l.targetCardId);
}
