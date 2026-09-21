import type { AgentMessage } from "@/lib/types";

/**
 * 会话消息列表的单一 owner（纯函数 reducer）。
 *
 * 为什么要它：消息列表原先由 `messages` / `entryIds` / `parentIds` **三个并行数组**维护，
 * 长度还刻意不一致（发送时先乐观追加 messages、entryIds 不动），于是"对齐"变成每个写入者的义务，
 * 而"刚发出的消息是哪一个"只能靠「是不是最后一条 + 文本相等」去猜 —— 猜错就重复，被整表替换就消失，
 * 身份变化就卸载重挂（闪烁）。上游 issue #23 / #24 就是同一类症状，当时的修法（乐观 key + 相邻判定）
 * 是启发式补丁，我们 fork 时继承的就是那个形态。
 *
 * 这里的规矩只有两条：
 *   1. 每条消息在列表里出现且仅出现一次；
 *   2. 一条条目的身份（`id`）从创建到销毁不变 —— 渲染 key、滚动锚点、认领回声都用它，
 *      服务端 entry id 只是落盘后挂上去的元数据。
 *
 * 所有"谁是谁"的判断都换成确定性依据：
 *   - 已有 serverEntryId 的条目 ↔ 服务端窗口：按 entryId 配对；
 *   - 无 serverEntryId 的条目（SSE 直接追加的、或回声后的 pending）：按 role + timestamp 配对；
 *   - pending 用户条目 ↔ 服务端用户条目：按提交顺序 FIFO，且服务端 timestamp 不早于提交时刻。
 * 不出现任何"文本相等"的猜测。
 */

export interface TranscriptItem {
  /** 客户端 id：从创建到销毁不变（渲染 key 用它）。 */
  id: string;
  /** 服务端落盘后的 entry id；未落盘（pending / 仅经 SSE 到达）时为 null。 */
  serverEntryId: string | null;
  parentId: string | null;
  message: AgentMessage;
  /** pending = 已提交、尚未在服务端列表里确认；confirmed = 已确认（或不经本地回显直接到达）。 */
  state: "pending" | "confirmed";
  /** 提交时的运行序号（把回声认领回正确的 pending 条目）。 */
  runId: number | null;
  /** 提交时刻（ms）。合并时用它判断"服务端这条是不是我提交的那条"。 */
  submittedAt: number;
}

/** 服务端窗口里的一条 entry（loadSession / loadContext 的返回形态）。 */
export interface ServerEntry {
  entryId: string;
  parentId: string | null;
  message: AgentMessage;
}

export interface TranscriptState {
  items: TranscriptItem[];
}

export type TranscriptAction =
  /** 用户提交一条消息（本地立即上屏，等回声确认）。 */
  | { type: "submit"; id: string; message: AgentMessage; runId: number; submittedAt: number }
  /** SSE message_end 到达的非用户消息（assistant / toolResult / system …），服务端已经产出。 */
  | { type: "server"; message: AgentMessage }
  /** SSE message_end 到达的用户消息：认领对应的 pending 条目并**原位升级**；没有 pending 才追加。 */
  | { type: "echo"; runId: number; message: AgentMessage }
  /** 服务端尾部窗口（loadSession）：按身份合并，pending 原位保留。 */
  | { type: "mergeTail"; entries: ServerEntry[] }
  /** 更早一页历史（loadContext before）：前置插入并按 entryId 去重。 */
  | { type: "prependOlder"; entries: ServerEntry[] }
  /** 提交被拒：按 id 移除该 pending。 */
  | { type: "fail"; id: string }
  /** 切换分支 / 会话：显式清空（唯一允许清空列表的动作）。 */
  | { type: "reset" };

export function createTranscriptState(): TranscriptState {
  return { items: [] };
}

export function transcriptMessages(state: TranscriptState): AgentMessage[] {
  return state.items.map((item) => item.message);
}

/** 与服务端 entry 一一对应；pending 条目为 null。 */
export function transcriptEntryIds(state: TranscriptState): (string | null)[] {
  return state.items.map((item) => item.serverEntryId);
}

export function transcriptParentIds(state: TranscriptState): (string | null)[] {
  return state.items.map((item) => item.parentId);
}

/** 渲染用：条目 id 顺序（ChatWindow 的 key / 滚动锚点）。 */
export function transcriptItemIds(state: TranscriptState): string[] {
  return state.items.map((item) => item.id);
}

function timestampOf(message: AgentMessage): number | null {
  const value = (message as { timestamp?: unknown }).timestamp;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 无 entryId 的条目与服务端 entry 的确定性配对依据：角色 + 时间戳。 */
function sameRoleAndTimestamp(a: AgentMessage, b: AgentMessage): boolean {
  if (a.role !== b.role) return false;
  const at = timestampOf(a);
  const bt = timestampOf(b);
  return at !== null && bt !== null && at === bt;
}

function confirmedFromEntry(entry: ServerEntry, id: string): TranscriptItem {
  return {
    id,
    serverEntryId: entry.entryId,
    parentId: entry.parentId,
    message: entry.message,
    state: "confirmed",
    runId: null,
    submittedAt: 0,
  };
}

/**
 * 尾部窗口合并。
 *
 * 语义与旧的 `loadSession` 一致（尾部窗口 + 保留已加载的更早历史），但：
 *   - 命中已有条目的位置**沿用原 id**（不重挂、不闪）；
 *   - 本地 pending 条目服务端还没落盘时**原位保留**（不消失）；
 *   - 空窗口不动列表（避免瞬态空响应把界面刷白）。
 */
function mergeTail(state: TranscriptState, entries: ServerEntry[]): TranscriptState {
  if (entries.length === 0) return state;

  const items = state.items;
  const claimedItem = new Set<number>();
  const matchedItemByServerIdx = new Map<number, number>();

  // ① 已有 entryId 的条目：按 entryId 配对
  const itemIdxByEntryId = new Map<string, number>();
  items.forEach((item, idx) => {
    if (item.serverEntryId) itemIdxByEntryId.set(item.serverEntryId, idx);
  });
  entries.forEach((entry, serverIdx) => {
    const itemIdx = itemIdxByEntryId.get(entry.entryId);
    if (itemIdx === undefined || claimedItem.has(itemIdx)) return;
    claimedItem.add(itemIdx);
    matchedItemByServerIdx.set(serverIdx, itemIdx);
  });

  // ② 无 entryId 的条目（SSE 直接追加的 / 回声后的 pending）：按角色 + 时间戳配对
  entries.forEach((entry, serverIdx) => {
    if (matchedItemByServerIdx.has(serverIdx)) return;
    const itemIdx = items.findIndex((item, idx) => (
      !claimedItem.has(idx) && !item.serverEntryId && sameRoleAndTimestamp(item.message, entry.message)
    ));
    if (itemIdx === -1) return;
    claimedItem.add(itemIdx);
    matchedItemByServerIdx.set(serverIdx, itemIdx);
  });

  // ③ pending 用户条目 ↔ 未认领的服务端用户条目：提交顺序 FIFO，服务端时间不早于提交时刻
  const pendingIdxList = items
    .map((item, idx) => ({ item, idx }))
    .filter(({ item, idx }) => item.state === "pending" && item.message.role === "user" && !claimedItem.has(idx))
    .sort((a, b) => a.item.submittedAt - b.item.submittedAt)
    .map(({ idx }) => idx);
  entries.forEach((entry, serverIdx) => {
    if (matchedItemByServerIdx.has(serverIdx) || entry.message.role !== "user") return;
    const serverTimestamp = timestampOf(entry.message);
    const itemIdx = pendingIdxList.find((idx) => (
      !claimedItem.has(idx)
      && (serverTimestamp === null || serverTimestamp >= items[idx].submittedAt)
    ));
    if (itemIdx === undefined) return;
    claimedItem.add(itemIdx);
    matchedItemByServerIdx.set(serverIdx, itemIdx);
  });

  // ④ 组装：锚点之前的本地条目 = 已加载的更早历史，原样保留在前。
  // 没有锚点时不能把本地条目当"更早历史"——它们是还没落盘的 pending，应该接在窗口之后。
  const hasAnchor = matchedItemByServerIdx.size > 0;
  const anchorItemIdx = hasAnchor
    ? Math.min(...matchedItemByServerIdx.values())
    : Number.POSITIVE_INFINITY;

  const out: TranscriptItem[] = [];
  if (hasAnchor) {
    items.forEach((item, idx) => {
      if (idx < anchorItemIdx && !claimedItem.has(idx)) out.push(item);
    });
  }

  const consumedItemIdx = new Set<number>();
  for (let serverIdx = 0; serverIdx < entries.length; serverIdx++) {
    const entry = entries[serverIdx];
    const itemIdx = matchedItemByServerIdx.get(serverIdx);
    if (itemIdx === undefined) {
      out.push(confirmedFromEntry(entry, `srv:${entry.entryId}`));
      continue;
    }
    const item = items[itemIdx];
    consumedItemIdx.add(itemIdx);
    // 原位升级：id 不变，只把服务端信息补上
    out.push({
      ...item,
      serverEntryId: entry.entryId,
      parentId: entry.parentId,
      message: entry.message,
      state: "confirmed",
    });
  }

  // ⑤ 尾巴：只接回**还没落盘**的本地条目（pending / 仅经 SSE 到达）。
  // 有 serverEntryId 却不在窗口里的，说明它们已不在当前 leaf 的分支上（回退 / 「编辑从此处」/ 切分支）——
  // 服务端窗口是当前分支的权威尾部，这些必须丢弃；否则回退后旧消息会继续挂在消息流里。
  items.forEach((item, idx) => {
    if (consumedItemIdx.has(idx) || claimedItem.has(idx)) return;
    if (item.serverEntryId) return;
    if (hasAnchor && idx < anchorItemIdx) return; // 已在 ④ 前置保留
    out.push(item);
  });

  return { items: out };
}

function prependOlder(state: TranscriptState, entries: ServerEntry[]): TranscriptState {
  if (entries.length === 0) return state;
  const known = new Set(state.items.map((item) => item.serverEntryId).filter(Boolean) as string[]);
  const fresh = entries.filter((entry) => !known.has(entry.entryId));
  if (fresh.length === 0) return state;
  return {
    items: [
      ...fresh.map((entry) => confirmedFromEntry(entry, `srv:${entry.entryId}`)),
      ...state.items,
    ],
  };
}

export function transcriptReducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  switch (action.type) {
    case "submit":
      return {
        items: [...state.items, {
          id: action.id,
          serverEntryId: null,
          parentId: null,
          message: action.message,
          state: "pending",
          runId: action.runId,
          submittedAt: action.submittedAt,
        }],
      };

    case "server":
      return {
        items: [...state.items, {
          id: `srv-live:${state.items.length}:${action.message.role}`,
          serverEntryId: null,
          parentId: null,
          message: action.message,
          state: "confirmed",
          runId: null,
          submittedAt: 0,
        }],
      };

    case "echo": {
      // 认领：优先同一 run 的 pending，其次最早的 pending（FIFO）
      const pending = state.items
        .map((item, idx) => ({ item, idx }))
        .filter(({ item }) => item.state === "pending" && item.message.role === "user")
        .sort((a, b) => a.item.submittedAt - b.item.submittedAt);
      const target = pending.find(({ item }) => item.runId === action.runId) ?? pending[0];
      if (target) {
        // 原位升级：id 不变 → 渲染不重挂；服务端内容为准
        const items = [...state.items];
        items[target.idx] = {
          ...target.item,
          message: action.message,
          state: "confirmed",
          runId: action.runId,
        };
        return { items };
      }
      // 没有本地回显（别的客户端/扩展发的）→ 作为新条目追加
      return {
        items: [...state.items, {
          id: `echo:${action.runId}:${state.items.length}`,
          serverEntryId: null,
          parentId: null,
          message: action.message,
          state: "confirmed",
          runId: action.runId,
          submittedAt: 0,
        }],
      };
    }

    case "mergeTail":
      return mergeTail(state, action.entries);

    case "prependOlder":
      return prependOlder(state, action.entries);

    case "fail":
      return { items: state.items.filter((item) => item.id !== action.id) };

    case "reset":
      return { items: [] };

    default:
      return state;
  }
}
