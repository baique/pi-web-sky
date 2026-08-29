/**
 * Browser-persisted preference for the model selector: show model IDs
 * instead of display names. Some providers expose multiple models that
 * share the same display name, so the ID is the only way to tell them
 * apart. Mirrors the tool-preset preference pattern (localStorage,
 * best-effort).
 */

const STORAGE_KEY = "pi-model-id-display";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getPreferredModelIdDisplay(
  storage: StorageLike | null = getBrowserStorage(),
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setPreferredModelIdDisplay(
  enabled: boolean,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Browser storage is best-effort.
  }
}
