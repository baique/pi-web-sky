"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * App wallpaper: image Blob stored in IndexedDB, exposed to CSS as
 * `--app-bg-image` on <html>. Images go through the CSS background layer
 * on `body`. Display settings live in lib/wallpaper-settings.ts.
 *
 * 存储前经 compressWallpaper 处理：真无损——不降采样、不重采样，保持原始
 * 像素。仅尝试 PNG 无损重编码（对 BMP/TIFF/低效 PNG 等未压缩格式有压缩收益），
 * 并对体积取更小者（JPEG/WebP 等有损源 PNG 往往更大，则直存原文件，零损失）。
 * GIF 不支持（拒绝入库）。
 */

const DB_NAME = "pi-web";
const STORE = "bg-image";
const KEY = "wallpaper";

export type BgKind = "image" | null;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let currentUrl: string | null = null;
let bgKind: BgKind = null;

function kindOf(blob: Blob | null): BgKind {
  if (!blob || !blob.type.startsWith("image/")) return null;
  return "image";
}

/**
 * 真无损压缩壁纸（上传时调用）。GIF 不支持返回 null；解码失败兜底直存。
 * 已是高效格式（webp/avif）→ 直存原样（无损重编码对其无收益）。
 * 其余：不降采样、保持原始像素，仅尝试 PNG 无损重编码并取更小者——
 * 体积绝不劣化，像素零损失。
 */
async function compressWallpaper(file: Blob): Promise<Blob | null> {
  if (file.type === "image/gif") return null;
  // 已是高效格式：直存，不做二次编码（无损重编码同样无收益）
  if (file.type === "image/webp" || file.type === "image/avif") return file;

  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    // 真无损：canvas 尺寸 = 原始像素尺寸，不重采样
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0);

    // PNG 是 canvas 唯一可靠的无损输出；对 BMP/TIFF/低效 PNG 有压缩收益，
    // 对 JPEG 等有损源通常更大 → 取小者（直存原文件，体积不劣化）
    const png = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!png) return file;
    return png.size < file.size ? png : file;
  } finally {
    bmp.close();
  }
}

/**
 * Swap the stored media: revokes the previous object URL, points
 * `--app-bg-image` at the new one and returns the live object URL.
 */
function setBackground(blob: Blob | null): { url: string | null; kind: BgKind } {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  bgKind = kindOf(blob);
  currentUrl = blob ? URL.createObjectURL(blob) : null;
  const el = document.documentElement.style;
  if (bgKind === "image" && currentUrl) {
    el.setProperty("--app-bg-image", `url("${currentUrl}")`);
  } else {
    el.setProperty("--app-bg-image", "none");
  }
  return { url: currentUrl, kind: bgKind };
}

async function loadBackground(): Promise<{
  loaded: boolean;
  url: string | null;
  kind: BgKind;
}> {
  try {
    const db = await openDb();
    const blob: Blob | null = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    if (!blob) return { loaded: false, ...setBackground(null) };
    return { loaded: true, ...setBackground(blob) };
  } catch {
    // IndexedDB unavailable — background stays off.
    return { loaded: false, ...setBackground(null) };
  }
}

async function writeBackground(blob: Blob | null): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    if (blob) store.put(blob, KEY);
    else store.delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function useAppBackground() {
  const [hasBg, setHasBg] = useState(false);
  const [ready, setReady] = useState(false);
  const [kind, setKind] = useState<BgKind>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadBackground().then((res) => {
      if (!alive) return;
      setHasBg(res.loaded);
      setUrl(res.url);
      setKind(res.kind);
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const pick = useCallback(async (file: Blob) => {
    const stored = await compressWallpaper(file);
    if (!stored) return; // GIF 等不支持格式：拒绝，不改变现有壁纸
    await writeBackground(stored);
    const res = setBackground(stored);
    setUrl(res.url);
    setKind(res.kind);
    setHasBg(true);
  }, []);

  const remove = useCallback(async () => {
    await writeBackground(null);
    setBackground(null);
    setUrl(null);
    setKind(null);
    setHasBg(false);
  }, []);

  return { hasBg, ready, pick, remove, kind, url };
}
