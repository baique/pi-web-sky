import type { AgentMessage } from "@/lib/types";

/**
 * 从消息中提取可渲染的 markdown 文本（钉卡快照用）。
 * 只取 text 块，忽略 thinking / 工具调用 / 图片等结构 —— 钉卡只渲染内容，与消息气泡解耦。
 */
export function extractMessageMarkdown(message: AgentMessage): string {
  const content = (message as unknown as { content?: unknown }).content;
  const parts: string[] = [];
  const push = (c: unknown): void => {
    if (typeof c === "string") {
      parts.push(c);
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (b && typeof b === "object") {
          const t = b as { type?: string; text?: string };
          if (t.type === "text" && typeof t.text === "string") parts.push(t.text);
        }
      }
    }
  };
  push(content);
  return parts.join("\n\n").trim();
}
