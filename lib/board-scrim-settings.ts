"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 看板画布 scrim（SessionCanvas）设置 —— 完全照消息气泡定制模式：
 * - alpha : 透明度（0–100，写入 `--board-scrim-alpha` 的 0–1），
 *           0 = 最透明，100 = 完全不透明（对应气泡的 bubbleOpacity）
 * - blur  : 磨砂强度（px，0–30），写入 `--board-scrim-blur`
 *           （对应气泡的 bubbleBlur）
 *
 * scrim 背景 = rgba(0, 0, 0, var(--board-scrim-alpha))（token 在
 * app/globals.css），双滑块像气泡定制一样分别调透明度与磨砂。
 * 设置持久化在 localStorage，实时应用到 <html> 上的 CSS 变量，
 * 被 CanvasStage 的 scrim 层消费。
 */

export type BoardScrimSettings = {
  alpha: number;
  blur: number;
};

const DEFAULTS: BoardScrimSettings = {
  alpha: 0,
  blur: 2,
};

const LS_KEY = "board-scrim-settings";

export function loadBoardScrimSettings(): BoardScrimSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<BoardScrimSettings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveBoardScrimSettings(s: BoardScrimSettings): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    // localStorage unavailable — settings stay session-only.
  }
}

/** Push the scrim settings into CSS custom properties on <html>. */
export function applyBoardScrimCss(s: BoardScrimSettings): void {
  const el = document.documentElement.style;
  el.setProperty("--board-scrim-alpha", String(s.alpha / 100));
  el.setProperty("--board-scrim-blur", `${Math.round(s.blur)}px`);
}

/** Load, persist and live-apply the board canvas scrim settings. */
export function useBoardScrimSettings() {
  const [settings, setSettings] = useState<BoardScrimSettings>(DEFAULTS);

  useEffect(() => {
    setSettings(loadBoardScrimSettings());
  }, []);

  useEffect(() => {
    applyBoardScrimCss(settings);
  }, [settings]);

  const update = useCallback(
    (patch: Partial<BoardScrimSettings>) =>
      setSettings((prev) => {
        const next = { ...prev, ...patch };
        saveBoardScrimSettings(next);
        return next;
      }),
    [],
  );

  return { settings, update };
}
