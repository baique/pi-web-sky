"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * App wallpaper: original file Blob stored raw in IndexedDB (no re-encode,
 * no compression), exposed to CSS as `--app-bg-image` on <html>.
 * The fixed layer lives in app/globals.css (`body::before`).
 */

const DB_NAME = "pi-web";
const STORE = "bg-image";
const KEY = "wallpaper";

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

function applyBackground(url: string | null): void {
  if (url === currentUrl) return;
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = url;
  document.documentElement.style.setProperty(
    "--app-bg-image",
    url ? `url("${url}")` : "none",
  );
}

async function loadBackground(): Promise<boolean> {
  try {
    const db = await openDb();
    const blob: Blob | null = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    if (!blob) {
      applyBackground(null);
      return false;
    }
    applyBackground(URL.createObjectURL(blob));
    return true;
  } catch {
    // IndexedDB unavailable — background stays off.
    return false;
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

  useEffect(() => {
    let alive = true;
    loadBackground().then((loaded) => {
      if (!alive) return;
      setHasBg(loaded);
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const pick = useCallback(async (file: Blob) => {
    await writeBackground(file);
    applyBackground(URL.createObjectURL(file));
    setHasBg(true);
  }, []);

  const remove = useCallback(async () => {
    await writeBackground(null);
    applyBackground(null);
    setHasBg(false);
  }, []);

  return { hasBg, ready, pick, remove };
}