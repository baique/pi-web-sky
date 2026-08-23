"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * App wallpaper: original file Blob stored raw in IndexedDB (no re-encode,
 * no compression), exposed to CSS as `--app-bg-image` on <html>.
 * Images go through the CSS background layer on `body`; videos are rendered
 * as an autoplaying muted <video> element by AppShell instead.
 * Display settings live in lib/wallpaper-settings.ts.
 */

const DB_NAME = "pi-web";
const STORE = "bg-image";
const KEY = "wallpaper";

export type BgKind = "image" | "video" | null;

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
  if (!blob) return null;
  if (blob.type.startsWith("video/")) return "video";
  if (blob.type.startsWith("image/")) return "image";
  return null;
}

/**
 * Swap the stored media: revokes the previous object URL, points
 * `--app-bg-image` at the new one (images only — video uses its own element)
 * and returns the live object URL.
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
    await writeBackground(file);
    const res = setBackground(file);
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
