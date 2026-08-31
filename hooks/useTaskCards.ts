"use client";

import { useCallback, useEffect, useState } from "react";
import type { ExecStatus, LinkKind, ReadyStatus, TaskCard, TaskCardLink } from "@/lib/task-card-store";

/**
 * 任务卡数据 hook：拉取单卡详情（含依赖两向）+ 同看板候选卡（依赖选择用），
 * 提供 createCard / saveCard / deleteCard 操作。卡片 shape 是画布展示层，
 * 业务字段真相源在 task_cards 表，这里负责读写同步。
 */

export interface TaskCardDetail {
  card: TaskCard;
  nodeId: string | null;
  links: TaskCardLink[];
  inbound: TaskCardLink[];
}

export function useTaskCard(cardId: string | null, boardId: string | null) {
  const [detail, setDetail] = useState<TaskCardDetail | null>(null);
  const [candidates, setCandidates] = useState<TaskCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!cardId) {
      setDetail(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/task-cards/${encodeURIComponent(cardId)}`, { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 404) { setDetail(null); setLoading(false); return; }
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as TaskCardDetail;
      setDetail(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cardId]);

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

  /** 建卡（空卡向导提交）：成功后返回 card，供调用方更新 shape props。 */
  const createCard = useCallback(async (input: {
    boardId: string;
    nodeId?: string;
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
      const j = (await res.json()) as { card: TaskCard };
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
