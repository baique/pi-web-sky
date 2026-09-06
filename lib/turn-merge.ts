import type { AgentMessage, AssistantMessage, TextContent, UserMessage } from "./types";
import type { TurnIndexItem } from "./api-types";
import { splitFinalAssistantBlocks } from "./message-display";

/**
 * 时间轴导航条的回合拼装逻辑（纯函数，无 DOM 依赖）。
 *
 * 数据源有两个生命周期不同的来源：
 * - turnIndex：服务端全量索引（历史快照，负责窗口外回合的显示与跳转）；
 * - 已加载 messages：前端实时消息流（负责窗口内回合的精确预览与测量）。
 *
 * buildDomTurns 从消息流构建窗口内回合；mergeTurns 把两者按 entryId 对齐，
 * 索引未覆盖的尾部新回合（新消息）自动追加。测量（DOM element / scrollTop）
 * 在调用方单独进行，这里只产出纯数据。
 */

/** 窗口内一个回合的定位信息（msgIdx / refIdx 是两套独立下标，禁止混用）。 */
export interface DomTurn {
  entryId: string;
  /** user 消息在 allMessages（含全部角色）中的下标：assistant 收集起点用。 */
  msgIdx: number;
  /** user 消息在 messageRefs（只含 user/assistant）中的下标：DOM 测量用。 */
  refIdx: number;
  userMessage: UserMessage;
  userText: string;
  /** 该回合各 assistant 回复的摘要与定位（msgIdx/refIdx 同上语义）。 */
  assistantList: { markdown: string; msgIdx: number; refIdx: number }[];
}

/** 索引 × 窗口合并后的回合（渲染层数据，仍不含 DOM）。 */
export interface MergedTurn {
  entryId: string;
  /** user 消息在 messageRefs 中的下标（DOM 测量用），未加载回合为 -1。 */
  refIdx: number;
  /** 已加载时为完整 user 消息，否则为 null（只有索引摘要）。 */
  userMessage: UserMessage | null;
  /** user 消息预览文本：已加载取全量，未加载取索引截断版。 */
  userText: string;
  assistantList: { markdown: string; msgIdx: number; refIdx: number }[];
  /** 未加载时该回合的 assistant 回复摘要文本（空串表示无助理回复）。 */
  assistantPreviewText: string;
  /** false = 窗口外，只有索引数据，点击后先加载再定位。 */
  loaded: boolean;
}

/** 提取 user 消息预览文本（string 或 text blocks；纯附件消息给占位文案）。 */
export function getUserPreview(message: UserMessage): string {
  if (typeof message.content === "string") return message.content.trim();
  const text = message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text || "[attachment]";
}

/** 提取 assistant 回复的最终答案 markdown（thinking/toolCall 不参与）。 */
export function getAssistantAnswerMarkdown(message: AgentMessage | Partial<AgentMessage>): string {
  if (message.role !== "assistant") return "";
  const { answerBlocks } = splitFinalAssistantBlocks(message as AssistantMessage);
  return answerBlocks
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

/**
 * 从已加载消息构建窗口内回合。单遍遍历，msgIdx 取 allMessages 下标，
 * refIdx 只对 user/assistant 递增（与 messageRefs 对齐）——两套下标互不借用。
 */
export function buildDomTurns(
  allMessages: (AgentMessage | Partial<AgentMessage>)[],
  entryIds: string[],
): DomTurn[] {
  const turns: DomTurn[] = [];
  let current: DomTurn | null = null;
  let refIdx = 0;
  for (let msgIdx = 0; msgIdx < allMessages.length; msgIdx++) {
    const message = allMessages[msgIdx];
    if (message.role !== "user" && message.role !== "assistant") continue;
    const entryId = entryIds[msgIdx] ?? "";
    if (message.role === "user") {
      current = {
        entryId,
        msgIdx,
        refIdx,
        userMessage: message as UserMessage,
        userText: getUserPreview(message as UserMessage),
        assistantList: [],
      };
      turns.push(current);
    } else if (current) {
      const markdown = getAssistantAnswerMarkdown(message);
      if (markdown) current.assistantList.push({ markdown, msgIdx, refIdx });
    }
    refIdx += 1;
  }
  return turns;
}

/**
 * 索引 × 窗口合并：
 * - 索引回合已加载 → 用窗口数据（精确预览）；
 * - 索引回合未加载 → 用索引摘要（可点击加载）；
 * - 窗口内但索引未覆盖的尾部新回合（新消息）→ 按消息顺序追加。
 */
export function mergeTurns(turnIndex: TurnIndexItem[], domTurns: DomTurn[]): MergedTurn[] {
  const domByEntryId = new Map<string, DomTurn>();
  for (const dom of domTurns) domByEntryId.set(dom.entryId, dom);

  const merged: MergedTurn[] = [];
  const seen = new Set<string>();
  for (const item of turnIndex) {
    const dom = domByEntryId.get(item.entryId);
    if (dom) {
      seen.add(item.entryId);
      merged.push({
        entryId: item.entryId,
        refIdx: dom.refIdx,
        userMessage: dom.userMessage,
        userText: dom.userText,
        assistantList: dom.assistantList,
        assistantPreviewText: item.assistantPreview,
        loaded: true,
      });
    } else {
      merged.push({
        entryId: item.entryId,
        refIdx: -1,
        userMessage: null,
        userText: item.userText,
        assistantList: [],
        assistantPreviewText: item.assistantPreview,
        loaded: false,
      });
    }
  }
  for (const dom of domTurns) {
    if (seen.has(dom.entryId)) continue;
    merged.push({
      entryId: dom.entryId,
      refIdx: dom.refIdx,
      userMessage: dom.userMessage,
      userText: dom.userText,
      assistantList: dom.assistantList,
      assistantPreviewText: "",
      loaded: true,
    });
  }
  return merged;
}
