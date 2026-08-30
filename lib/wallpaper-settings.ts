"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Wallpaper display settings:
 * - repeat   : tile horizontally (`background-repeat: repeat-x`)
 * - offsetX  : horizontal drag offset in px, applied as `calc(50% + Npx)`
 * - fill     : fill leftover side gaps with colours sampled from the
 *              wallpaper's left/right edges (only meaningful when not tiling)
 * - bubbleOpacity : chat-bubble glass opacity in percent (0–100), written to
 *              `--bubble-alpha` on <html>
 * - bubbleBlur    : frosted blur radius in px (0–30), written to
 *              `--glass-blur-bubble` on <html>
 * - scrimAlpha    : board-canvas scrim opacity in percent (0–100), written to
 *              `--board-scrim-alpha` on <html> (independent of bubble alpha)
 * - scrimBlur     : board-canvas scrim blur radius in px (0–30), written to
 *              `--board-scrim-blur` on <html>
 *
 * Settings persist in localStorage and are applied to <html> as CSS custom
 * properties consumed by the wallpaper layer on `body` in app/globals.css.
 */

export type WallpaperSettings = {
  repeat: boolean;
  offsetX: number;
  fill: boolean;
  fillColorLeft: string;
  fillColorRight: string;
  bubbleOpacity: number;
  bubbleBlur: number;
  scrimAlpha: number;
  scrimBlur: number;
};

const DEFAULTS: WallpaperSettings = {
  repeat: false,
  offsetX: 0,
  fill: false,
  fillColorLeft: "#000000",
  fillColorRight: "#000000",
  bubbleOpacity: 44,
  bubbleBlur: 18,
  scrimAlpha: 0,
  scrimBlur: 2,
};

const LS_KEY = "wallpaper-settings";

export function loadWallpaperSettings(): WallpaperSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<WallpaperSettings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveWallpaperSettings(s: WallpaperSettings): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    // localStorage unavailable — settings stay session-only.
  }
}

/** Push the current settings into CSS custom properties on <html>. */
export function applyWallpaperCss(s: WallpaperSettings, hasImage: boolean): void {
  const el = document.documentElement.style;
  el.setProperty("--app-bg-repeat", s.repeat ? "repeat-x" : "no-repeat");
  // The wallpaper always keeps its fitted `cover` size. Repeat/fill merely
  // cover the side gaps that open up after a horizontal drag offset — they
  // must never rescale the image itself.
  el.setProperty("--app-bg-size", "cover");
  el.setProperty("--app-bg-pos-x", `calc(50% + ${Math.round(s.offsetX)}px)`);
  el.setProperty("--bubble-alpha", String(s.bubbleOpacity / 100));
  el.setProperty("--glass-blur-bubble", `${Math.round(s.bubbleBlur)}px`);
  // scrim 走独立变量（--board-scrim-*），控制内容与气泡滑块完全一致：
  // 透明度 → alpha（0–1），磨砂强度 → blur 半径（px）。
  // 关键：磨砂强度为 0 时把整个 backdrop-filter 置为 none——否则
  // blur(0px) saturate(0.8) 中的 saturate 残留仍会对背景去饱和，
  // 用户把透明度和磨砂都调 0 时背景还“被影响”。
  el.setProperty("--board-scrim-alpha", String(s.scrimAlpha / 100));
  el.setProperty("--board-scrim-blur", `${Math.round(s.scrimBlur)}px`);
  el.setProperty(
    "--board-scrim-filter",
    s.scrimBlur > 0
      ? `blur(${Math.round(s.scrimBlur)}px) saturate(var(--glass-saturate))`
      : "none",
  );
  if (s.fill && !s.repeat && hasImage) {
    el.setProperty(
      "--app-bg-fill",
      `linear-gradient(90deg, ${s.fillColorLeft}, ${s.fillColorLeft} 50%, ${s.fillColorRight} 50%, ${s.fillColorRight})`,
    );
  } else {
    el.removeProperty("--app-bg-fill");
  }
}

/**
 * Sample the leftmost/rightmost pixel column of an image blob into two CSS colours.
 * Only samples the top 8 rows — a short vertical slice keeps colours true to the
 * wallpaper edge and avoids the "washed out" result that happens when averaging
 * highlights, shadows and midtones over a taller strip.
 */
export async function sampleEdgeColors(
  blob: Blob,
): Promise<{ left: string; right: string } | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const sampleH = 8;
    const w = Math.max(1, Math.round((bmp.width * sampleH) / bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = sampleH;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, sampleH);
    const avg = (x: number): string => {
      const d = ctx.getImageData(x, 0, 1, sampleH).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < sampleH; i++) {
        r += d[i * 4];
        g += d[i * 4 + 1];
        b += d[i * 4 + 2];
      }
      return `rgb(${Math.round(r / sampleH)}, ${Math.round(g / sampleH)}, ${Math.round(b / sampleH)})`;
    };
    const result = { left: avg(0), right: avg(w - 1) };
    bmp.close();
    return result;
  } catch {
    return null;
  }
}

export type WallpaperDims = { width: number; height: number };

/** Natural dimensions of an image or video URL (video reads metadata only). */
export function loadMediaDims(
  url: string,
  isVideo: boolean,
): Promise<WallpaperDims | null> {
  if (isVideo) {
    return new Promise((resolve) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () =>
        resolve({ width: v.videoWidth, height: v.videoHeight });
      v.onerror = () => resolve(null);
      v.src = url;
    });
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Load, persist and live-apply wallpaper display settings. */
export function useWallpaperSettings(hasImage: boolean) {
  const [settings, setSettings] = useState<WallpaperSettings>(DEFAULTS);

  useEffect(() => {
    setSettings(loadWallpaperSettings());
  }, []);

  useEffect(() => {
    applyWallpaperCss(settings, hasImage);
  }, [settings, hasImage]);

  const update = useCallback(
    (patch: Partial<WallpaperSettings>) =>
      setSettings((prev) => {
        const next = { ...prev, ...patch };
        saveWallpaperSettings(next);
        return next;
      }),
    [],
  );

  return { settings, update };
}
