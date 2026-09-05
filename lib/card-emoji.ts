/**
 * 看板卡片 emoji：默认值（按类别固定）、状态跟随映射、随机集合。
 * 纯函数/常量，无 React 依赖——状态 emoji 只做展示不落库，落库的只有用户设置值。
 */

export type EmojiCardKind = "session" | "task" | "note";

/** 新建卡片默认 emoji（按类别固定；旧卡/未设置/清除后兜底显示） */
export const DEFAULT_EMOJI: Record<EmojiCardKind, string> = {
  session: "💬",
  task: "✅",
  note: "📝",
};

/**
 * 状态跟随 emoji（只展示不落库）：进行中/思考/等待/失败。
 * 平静与终态（idle/just-ended/done/abandoned/not_started 等）不在表内 → 回落用户值。
 */
export const STATUS_EMOJI: Partial<Record<EmojiCardKind, Record<string, string>>> = {
  session: {
    waiting_model: "🤔",
    running_tools: "🚀",
    running_command: "🚀",
    waiting_input: "⏳",
  },
  task: {
    running: "🚀",
    review: "🤔",
    waiting_reply: "⏳",
    failed: "😱",
  },
};

/** 随机集合（趣味向，常用分类混搭） */
export const RANDOM_EMOJIS: string[] = [
  "🚀", "🤔", "💡", "🎯", "🔥", "✨", "🌟", "🍀", "🌈", "🎨",
  "📌", "🗂️", "🧩", "⚡", "🔧", "🧪", "🐛", "🦋", "🐝", "🦄",
  "🍕", "☕", "🍺", "🎮", "🎵", "🎬", "📚", "🏗️", "🌱", "🏔️",
  "⚓", "🧭", "🗺️", "🤖", "👾", "💎", "🎁", "🏆", "🥇", "🛠️",
];

/** 随机挑一个（排除当前值，避免点了没变化） */
export function randomEmoji(exclude?: string): string {
  const pool = RANDOM_EMOJIS.filter((e) => e !== exclude);
  return pool[Math.floor(Math.random() * pool.length)] ?? "🎲";
}

/** 解析卡片最终显示 emoji：状态跟随 > 用户设置 > 类别默认 */
export function resolveEmoji(
  kind: EmojiCardKind,
  userEmoji: string | null | undefined,
  status?: string | null,
): string {
  const statusMap = STATUS_EMOJI[kind];
  if (status && statusMap?.[status]) return statusMap[status];
  return userEmoji || DEFAULT_EMOJI[kind];
}
