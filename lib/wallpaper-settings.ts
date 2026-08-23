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
};

const DEFAULTS: WallpaperSettings = {
  repeat: false,
  offsetX: 0,
  fill: false,
  fillColorLeft: "#000000",
  fillColorRight: "#000000",
  bubbleOpacity: 44,
  bubbleBlur: 18,
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
  if (s.fill && !s.repeat && hasImage) {
    el.setProperty(
      "--app-bg-fill",
      `linear-gradient(90deg, ${s.fillColorLeft}, ${s.fillColorLeft} 50%, ${s.fillColorRight} 50%, ${s.fillColorRight})`,
    );
  } else {
    el.removeProperty("--app-bg-fill");
  }
}

/** Average the leftmost/rightmost pixel columns of an image blob into two CSS colours. */
export async function sampleEdgeColors(
  blob: Blob,
): Promise<{ left: string; right: string } | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const h = 64;
    const w = Math.max(2, Math.round((bmp.width * h) / bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, h);
    const avg = (x: number): string => {
      const d = ctx.getImageData(x, 0, 1, h).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < h; i++) {
        r += d[i * 4];
        g += d[i * 4 + 1];
        b += d[i * 4 + 2];
      }
      return `rgb(${Math.round(r / h)}, ${Math.round(g / h)}, ${Math.round(b / h)})`;
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
