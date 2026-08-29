import { sendAgentCommand } from "./agent-client";

/**
 * inspect 命令封装：复用现有 prompt 通道执行 pi-subagents 的
 * `/subagents-inspect-rpc` 扩展命令（SDK 的 _tryExecuteExtensionCommand 会
 * 直接执行 handler，不走模型轮次）。
 *
 * 回包经 `subagent-inspect` widget emit-then-retract 两帧回传，由
 * ExtensionStatusBar 拦截（见 components/ExtensionStatusBar.tsx），通过
 * 模块级订阅分发。这里只负责构造命令 + 生成 requestId。
 */

let seq = 0;

/** 生成符合插件侧 [A-Za-z0-9_-]{1,64} 约束的 requestId */
export function nextInspectRequestId(): string {
  seq = (seq + 1) % 0x7fffffff;
  return `pw-${Date.now().toString(36)}-${seq.toString(36)}`;
}

/**
 * 触发一次 inspect 查询。
 * @param sessionId 当前会话 id
 * @param requestId 本次请求的 requestId（与回包匹配）
 * @param asyncId   子任务 run id（快照节点 id）
 * @param childId   可选，workflow step / 嵌套子任务 id
 * @param lines     可选，消息条数上限（1-200）
 */
export async function invokeSubagentInspect(
  sessionId: string,
  requestId: string,
  asyncId: string,
  childId?: string,
  lines?: number,
): Promise<void> {
  const parts = ["/subagents-inspect-rpc", requestId, asyncId];
  if (childId) parts.push(childId);
  if (lines !== undefined) parts.push("--lines", String(lines));
  await sendAgentCommand(sessionId, { type: "prompt", message: parts.join(" ") });
}

/** 模块级回包订阅：ExtensionStatusBar 收到 subagent-inspect 帧时调用。
 * 回包先存 pending 缓存；订阅者订阅时立即补收匹配的回包，避免命令排队期间
 * 卡片卸载导致回包丢失（emit-then-retract 帧是瞬时的，不缓存就会丢）。 */
type InspectReplyListener = (reply: unknown, requestId: string) => void;
const inspectReplyListeners = new Set<InspectReplyListener>();
const pendingInspectReplies = new Map<string, unknown>();
const PENDING_REPLY_TTL_MS = 60_000;

export function subscribeInspectReplies(listener: InspectReplyListener): () => void {
  inspectReplyListeners.add(listener);
  // 补收订阅前已到达、尚未消费的回包
  for (const [requestId, reply] of pendingInspectReplies) {
    try {
      listener(reply, requestId);
    } catch {
      // 单个监听器失败不影响其他监听器
    }
  }
  return () => inspectReplyListeners.delete(listener);
}

/** 由 ExtensionStatusBar 调用，分发一次回包（并缓存，供迟到的订阅者补收） */
export function dispatchInspectReply(reply: unknown, requestId: string): void {
  pendingInspectReplies.set(requestId, reply);
  setTimeout(() => {
    if (pendingInspectReplies.get(requestId) === reply) pendingInspectReplies.delete(requestId);
  }, PENDING_REPLY_TTL_MS);
  for (const listener of inspectReplyListeners) {
    try {
      listener(reply, requestId);
    } catch {
      // 单个监听器失败不影响其他监听器
    }
  }
}

/** 清空 pending 缓存（测试用；生产不调用） */
export function clearPendingInspectReplies(): void {
  pendingInspectReplies.clear();
}
