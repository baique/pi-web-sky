/**
 * subagent widget 快照解析 + 注册表骨架。
 *
 * pi-subagents 在 RPC 模式下把异步子任务状态压成单行 JSON 推给 pi-web：
 *   widget key: "subagent-async"
 *   首行前缀:   "PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify(AsyncStatusSnapshotV1)
 *
 * 这里只做「识别 + 解析」，渲染在 components/subagent/*。
 * 注册表骨架：未来其他插件若也用「带标记的 JSON 行」推结构化内容，
 * 在 widgetParsers 里加一条即可，pi-web 无需改渲染主流程。
 */

export const SUBAGENT_ASYNC_WIDGET_KEY = "subagent-async";
export const SUBAGENT_INSPECT_WIDGET_KEY = "subagent-inspect";
export const SUBAGENT_FLEET_STATUS_WIDGET_KEY = "subagent-fleet-status";
export const SUBAGENT_ASYNC_JSON_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
export const SUBAGENT_INSPECT_JSON_PREFIX = "PI_SUBAGENT_INSPECT_JSON:";

/** pi-subagents 推的、在 pi-web 里不应作为可见 widget 渲染的 key（纯数据传输 / TUI 专属） */
export const SUBAGENT_HIDDEN_WIDGET_KEYS = new Set([
  SUBAGENT_ASYNC_WIDGET_KEY,
  SUBAGENT_INSPECT_WIDGET_KEY,
  SUBAGENT_FLEET_STATUS_WIDGET_KEY,
]);

/** pi-subagents AsyncStatusSnapshotV1 的节点结构（对齐插件侧，只取展示所需字段） */
export interface SubagentSnapshotNode {
  id: string;
  kind: "subagent" | "workflow" | "step" | "host-step";
  label: string;
  state:
    | "queued"
    | "running"
    | "complete"
    | "failed"
    | "partial"
    | "paused"
    | "stopped"
    | "rejected";
  startedAt?: number;
  endedAt?: number;
  activity?: {
    state?: string;
    currentTool?: string;
    turnCount?: number;
    toolCount?: number;
  };
  children?: SubagentSnapshotNode[];
}

export interface SubagentSnapshot {
  kind: string;
  version: number;
  generatedAt: number;
  runs: SubagentSnapshotNode[];
}

export interface SubagentInspectMessage {
  role: string;
  kind: "text" | "toolCall" | "toolResult";
  text: string;
  name?: string;
  isError?: boolean;
}

/** pi-subagents.inspect-reply v1 */
export interface SubagentInspectReply {
  kind: string;
  version: number;
  requestId: string;
  asyncId?: string;
  childId?: string;
  status?: string;
  label?: string;
  task?: string;
  messages?: SubagentInspectMessage[];
  finalOutput?: string;
  error?: { code: string; message: string };
}

function parsePrefixedJson<T>(line: string | undefined, prefix: string): T | null {
  if (!line || !line.startsWith(prefix)) return null;
  try {
    return JSON.parse(line.slice(prefix.length)) as T;
  } catch {
    return null;
  }
}

/** 解析 subagent-async widget 快照；非本插件内容或解析失败返回 null */
export function parseSubagentSnapshot(lines: string[]): SubagentSnapshot | null {
  const raw = parsePrefixedJson<SubagentSnapshot>(lines[0], SUBAGENT_ASYNC_JSON_PREFIX);
  if (!raw || raw.kind !== "pi-subagents.async-status-snapshot" || !Array.isArray(raw.runs)) {
    return null;
  }
  return raw;
}

/** 解析 subagent-inspect 回包（emit-then-retract 的 emit 帧） */
export function parseSubagentInspectReply(lines: string[]): SubagentInspectReply | null {
  const raw = parsePrefixedJson<SubagentInspectReply>(lines[0], SUBAGENT_INSPECT_JSON_PREFIX);
  if (!raw || raw.kind !== "pi-subagents.inspect-reply") return null;
  return raw;
}

/** 注册表骨架：widget key → 解析器。现在只注册 subagent，未来插件加条目即可。 */
export const widgetParsers: Record<string, (lines: string[]) => unknown | null> = {
  [SUBAGENT_ASYNC_WIDGET_KEY]: parseSubagentSnapshot,
};
