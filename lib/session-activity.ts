// ============================================================================
// 会话活跃事件 → 数据库写入意图（纯函数，无 IO）
//
// 背景：会话列表的「最后一条消息」「最后活跃时间」原先由 30s 扫描器从文件
// mtime 反推（滞后 ≤30s，且发消息不刷库）。改为事件驱动：一轮循环真正结束
// 时（agent_settled）把最后一条 assistant 文本与时间戳落库；用户取消走同一条
// 路径（SDK 会为取消生成 stopReason="aborted" 的 assistant 消息，随后同样
// 走 turn_end → agent_end → agent_settled）。
//   · agent_start                → touch（活跃时间立刻前移，运行中会话浮顶）
//   · message_end(assistant)     → 缓存本轮最后一条（不落库；一轮可能多条）
//   · agent_settled              → outcome（落 last_reply + modified）
// 两个边界：
//   · agent_end 一轮里可能多次（重试/compaction/queue 续跑），所以不用它落库；
//     message_end 也不是「循环结束」，单条不落库。
//   · 本轮一条 assistant 文本都没采到（刚发出就被取消、整轮只有工具调用）时，
//     agent_settled 退化为 touch —— **绝不用空文本覆盖已存的 last_reply**。
// 状态必须**按 wrapper 实例**持有：多个会话并发跑时共享模块级变量会串台。
// ============================================================================

/** 事件里透传的 message（SDK 的 AgentMessage 的最小结构约定）。 */
export interface AgentLikeMessage {
  role?: string;
  content?: unknown;
  timestamp?: number;
  stopReason?: string;
}

export type SessionActivityEffect =
  | { kind: "touch" }
  | { kind: "outcome"; lastReply: string; at: number };

/** assistant 消息的纯文本（text 块拼接；无 text 返回 ""）。 */
export function lastAssistantText(message: AgentLikeMessage): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type?: string; text?: string } => Boolean(block) && typeof block === "object")
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

/** 每个 AgentSessionWrapper 持有一个 tracker，内部缓存「本轮最后一条 assistant」。 */
export function createSessionActivityTracker(): {
  handle(event: { type: string; message?: AgentLikeMessage }): SessionActivityEffect | null;
} {
  let pending: { lastReply: string; at: number } | null = null;
  return {
    handle(event) {
      if (event.type === "agent_start") return { kind: "touch" };
      if (event.type === "message_end") {
        const message = event.message;
        if (message?.role === "assistant") {
          const text = lastAssistantText(message);
          // 空文本（纯工具轮 / 半截回复）不覆盖已缓存的文本：本轮最后一条有内容的
          // assistant 消息才是「最后一条消息」。
          if (text) {
            pending = {
              lastReply: text,
              at: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
            };
          }
        }
        return null;
      }
      if (event.type === "agent_settled") {
        const outcome = pending;
        pending = null;
        // 本轮没采到文本 → 只刷活跃时间，让调用方保留库里已有的 last_reply。
        return outcome ? { kind: "outcome", ...outcome } : { kind: "touch" };
      }
      return null;
    },
  };
}
