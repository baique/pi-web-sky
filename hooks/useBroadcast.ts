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

export type Broadcast =
  | { level: "error"; text: string } // P0 常驻直到用户关闭
  | { level: "notice"; text: string; kind: BroadcastNotice["type"] } // P1 插播，随 notices 自身过期消失
  | { level: "phase"; text: string; orb: "breathing" | "working" } // P2 运行状态/重试
  | { level: "idle"; quota: QuotaInfo | null }; // P3 空闲信息

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

export function resolveBroadcast(input: {
  notices: BroadcastNotice[];
  dismissedErrors: readonly string[];
  phase: { text: string; orb: "breathing" | "working" } | null;
  retryText: string | null;
  quota: QuotaInfo | null;
}): Broadcast {
  const { notices, dismissedErrors, phase, retryText, quota } = input;
  const errId = pickPinnedErrorId(notices);
  if (errId && !dismissedErrors.includes(errId)) {
    const err = notices.find((n) => n.id === errId);
    if (err) return { level: "error", text: err.message };
  }
  const ann = pickAnnouncement(notices);
  if (ann) return { level: "notice", text: ann.message, kind: ann.type };
  if (retryText) return { level: "phase", text: retryText, orb: "working" };
  if (phase) return { level: "phase", text: phase.text, orb: phase.orb };
  return { level: "idle", quota };
}

/**
 * 播报槽：单一出口按 P0(error) > P1(公告) > P2(状态/重试) > P3(额度) 显示。
 * error 在 notices 过期移除后仍需常驻 → 记住最近出现的 error id，直到 dismiss。
 * 公告的排队与过期直接复用 useAgentSession 的 notice 机制，此处不重造。
 */
export function useBroadcast(opts: {
  notices: BroadcastNotice[];
  phase: { text: string; orb: "breathing" | "working" } | null;
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
      // 新 error 出现：记录 id；dismiss 后它过期移除、下一条 error 到来时重新 pin
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

  return {
    broadcast: resolveBroadcast({ notices, dismissedErrors, phase, retryText, quota }),
    dismissError,
  };
}
