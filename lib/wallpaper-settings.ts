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
 * 看板 scrim：透明度滑块暂注释（微调即对背景影响过大），透明度固定保持 0，
 * 只向用户开放磨砂滑块；scrimAlpha 字段保留以备后续恢复。
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
  bubbleBlur: 8,
  scrimAlpha: 0,
  // 默认无磨砂（0）。打开画布时先按默认渲染，再从存储恢复——
  // 若默认非 0，首帧会先闪一下 2px 再跳变成存储值（见 useWallpaperSettings 惰性初始化注释）
  scrimBlur: 0,
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
  // scrim 透明度固定保持 0（透明度滑块暂注释，微调即对背景影响过大），
  // 只写磨砂强度。
  // scrim 磨砂只用 blur、不动饱和度——磨砂本质就是模糊，去饱和/增饱和
  // 都会让壁纸颜色失真，且会受 --glass-saturate（浅 80% / 深 140%）的
  // 主题差异影响。只 blur 则深浅色效果完全一致。
  // 关键：磨砂强度为 0 时把整个 backdrop-filter 置为 none，背景原样。
  el.setProperty("--board-scrim-alpha", String(s.scrimAlpha / 100));
  el.setProperty("--board-scrim-blur", `${Math.round(s.scrimBlur)}px`);
  el.setProperty(
    "--board-scrim-filter",
    s.scrimBlur > 0 ? `blur(${Math.round(s.scrimBlur)}px)` : "none",
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
  // 惰性初始化直接读 localStorage：首帧即存储值（无存储时为默认）。
  // 不要用 DEFAULTS 起步再挂载后 setSettings 恢复——那会让首帧先应用默认值
  // （如 scrimBlur 2px）再跳变到存储值，打开画布时磨砂强度闪烁一下。
  // SSR 阶段 localStorage 不存在，loadWallpaperSettings 内部 try/catch 返回默认，安全。
  const [settings, setSettings] = useState<WallpaperSettings>(() => loadWallpaperSettings());

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
