// 用户级草稿暂存区：存储层（纯逻辑 + localStorage 封装）。
// 跨会话、浏览器全局存在；内容只增不自动删，删除仅靠手动。
// 与 lib/draft-store.ts（会话级单条输入框草稿）完全独立，互不干扰。

export interface DraftItem {
  id: string;
  content: string;
  updatedAt: number; // epoch ms
}

const STORAGE_KEY = "pi-web.drafts.v1";

function getStorage(): Storage | null {
  return typeof localStorage !== "undefined" ? localStorage : null;
}

function isDraftItem(value: unknown): value is DraftItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.content === "string" &&
    typeof v.updatedAt === "number"
  );
}

/** 生成草稿 id（优先 crypto.randomUUID，退化到时间戳+随机） */
export function newDraftId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 读取全部草稿，按最近活动（updatedAt）降序；存储缺失/损坏时返回空数组 */
export function loadDrafts(): DraftItem[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isDraftItem)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function saveDrafts(items: DraftItem[]): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // 配额不足等——静默失败，草稿仅本次内存可见
  }
}

/** 新增一条草稿，置顶 */
export function addDraft(content: string, now: number = Date.now()): DraftItem {
  const item: DraftItem = { id: newDraftId(), content, updatedAt: now };
  saveDrafts([item, ...loadDrafts()]);
  return item;
}

/** 更新一条草稿内容并置顶（最新编辑在最上方）；id 不存在返回 null */
export function updateDraft(id: string, content: string, now: number = Date.now()): DraftItem | null {
  const items = loadDrafts();
  const idx = items.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  const updated: DraftItem = { ...items[idx], content, updatedAt: now };
  items.splice(idx, 1);
  items.unshift(updated);
  saveDrafts(items);
  return updated;
}

/** 删除一条草稿（仅手动删除，无自动删除逻辑） */
export function removeDraft(id: string): void {
  saveDrafts(loadDrafts().filter((d) => d.id !== id));
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 相对时间简写：刚刚 / N分钟前 / HH:MM / 昨天 / M月D日 / YYYY年M月D日 */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  const d = new Date(ts);
  const n = new Date(now);
  const startOfToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  if (ts >= startOfToday) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (ts >= startOfToday - 86_400_000) return "昨天";
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
