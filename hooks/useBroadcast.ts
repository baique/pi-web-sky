"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** 播报槽用公告（结构与 useAgentSession 的 NoticeItem 对齐，避免循环依赖） */
export interface BroadcastNotice {
  id: string;
  message: string;
  type: "info" | "success" | "warning" | "error";
  exiting?: boolean;
}

/** 额度展示契约（本期仅预留渲染位，数据适配器后置） */
export type QuotaInfo =
  | { kind: "balance"; text: string }
  | { kind: "usage"; items: { label: string; pct: number; text: string }[] };

/** 左槽：运行状态（重试文本已在上游合并为 working 态） */
export type PhaseBroadcast = { text: string; orb: "breathing" | "working" };

/** 右区：临时通知（P0 错误常驻 / P1 插播）与空闲信息（P3 额度） */
export type NoticeBroadcast =
  | { level: "error"; text: string }
  | { level: "notice"; text: string; kind: BroadcastNotice["type"] }
  | { level: "idle"; quota: QuotaInfo | null };

/** 第一条 error 公告 id（notices 为旧→新序） */
export function pickPinnedErrorId(notices: BroadcastNotice[]): string | null {
  const err = notices.find((n) => n.type === "error" && !n.exiting);
  return err?.id ?? null;
}

/** 末条非 error、非 exiting 的公告 */
export function pickAnnouncement(notices: BroadcastNotice[]): BroadcastNotice | null {
  for (let i = notices.length - 1; i >= 0; i--) {
    const n = notices[i];
    if (n.type !== "error" && !n.exiting) return n;
  }
  return null;
}

/**
 * 播报槽：状态与通知分槽显示，不再互斥抢占。
 * - 左槽 phase：重试 > agent 阶段；空闲时由调用方以模型选择等静态内容填充
 * - 右区 notice：P0 错误（常驻直到关闭）> P1 公告插播 > P3 额度
 * 公告的排队与过期直接复用 useAgentSession 的 notice 机制，此处不重造。
 */
export function useBroadcast(opts: {
  notices: BroadcastNotice[];
  phase: PhaseBroadcast | null;
  retryText: string | null;
  quota?: QuotaInfo | null;
}) {
  const { notices, phase, retryText, quota = null } = opts;
  const [dismissedErrors, setDismissedErrors] = useState<string[]>([]);
  const currentErrId = pickPinnedErrorId(notices);
  const seenErrRef = useRef<string | null>(null);

  useEffect(() => {
    if (currentErrId && currentErrId !== seenErrRef.current) {
      seenErrRef.current = currentErrId;
      setDismissedErrors((prev) => (prev.includes(currentErrId) ? prev : [...prev.slice(-9), currentErrId]));
    }
    if (!currentErrId) seenErrRef.current = null;
  }, [currentErrId]);

  const dismissError = useCallback(() => {
    setDismissedErrors((prev) => {
      const id = pickPinnedErrorId(notices);
      return id && !prev.includes(id) ? [...prev, id] : prev;
    });
  }, [notices]);

  const phaseBroadcast: PhaseBroadcast | null = retryText
    ? { text: retryText, orb: "working" }
    : phase;

  let noticeBroadcast: NoticeBroadcast;
  const errId = currentErrId && !dismissedErrors.includes(currentErrId) ? currentErrId : null;
  const err = errId ? notices.find((n) => n.id === errId) : null;
  if (err) {
    noticeBroadcast = { level: "error", text: err.message };
  } else {
    const ann = pickAnnouncement(notices);
    noticeBroadcast = ann
      ? { level: "notice", text: ann.message, kind: ann.type }
      : { level: "idle", quota };
  }

  return { phase: phaseBroadcast, notice: noticeBroadcast, dismissError };
}
