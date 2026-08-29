"use client";

import { useEffect, useMemo } from "react";
import { parseAnsiLine, stripAnsi } from "@/lib/ansi";
import type { ExtensionStatusItem, ExtensionWidgetItem } from "@/lib/types";
import {
  parseSubagentInspectReply,
  parseSubagentSnapshot,
  SUBAGENT_ASYNC_WIDGET_KEY,
  SUBAGENT_INSPECT_WIDGET_KEY,
} from "@/lib/subagent-widget";
import { dispatchInspectReply } from "@/lib/extension-command";
import { ExtensionWidgets } from "./ExtensionWidgets";
import { SubagentWidgetCard } from "./subagent/SubagentWidgetCard";

export function sanitizeExtensionStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

export function formatExtensionStatusLine(statuses: ExtensionStatusItem[]): string {
  return [...statuses]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ text }) => sanitizeExtensionStatusText(text))
    .join(" ");
}

export function ExtensionStatusBar({
  statuses,
  widgets = [],
  tools,
  notice,
  sessionId,
}: {
  statuses: ExtensionStatusItem[];
  widgets?: ExtensionWidgetItem[];
  /** Pi Web-owned tools rendered in the right side of the shelf. */
  tools?: React.ReactNode;
  /** 临时通知（P0/P1），追加在最右，可单独使整条 shelf 可见。 */
  notice?: React.ReactNode;
  /** 当前会话 id，用于 inspect 命令。 */
  sessionId?: string;
}) {
  // The shelf is event-driven: Pi Web tools use its reserved right slot but
  // must not make the otherwise-empty extension shelf permanently visible.
  if (statuses.length === 0 && widgets.length === 0 && !tools && !notice) return null;

  const statusLine = formatExtensionStatusLine(statuses);
  const plainStatusLine = stripAnsi(statusLine);

  // 拦截 subagent-inspect 回包（emit-then-retract 的 emit 帧）分发给订阅者。
  // retract 帧（widgetLines: undefined）已被 useAgentSession 过滤，不会到这里。
  useEffect(() => {
    const inspect = widgets.find((w) => w.key === SUBAGENT_INSPECT_WIDGET_KEY);
    if (!inspect) return;
    const reply = parseSubagentInspectReply(inspect.lines);
    if (!reply) return;
    dispatchInspectReply(reply, reply.requestId);
  }, [widgets]);

  // 分离 subagent-async 与其余 widget：subagent 快照 → 结构化卡片；其余原样走文本。
  // 解析失败时 subagent 也降级回文本 widget（不放卡片，不丢内容）。
  const { subagentSnapshot, subagentWidget, otherWidgets } = useMemo(() => {
    const subagent = widgets.find((w) => w.key === SUBAGENT_ASYNC_WIDGET_KEY);
    if (!subagent) return { subagentSnapshot: null, subagentWidget: null, otherWidgets: widgets };
    const snapshot = parseSubagentSnapshot(subagent.lines);
    return {
      subagentSnapshot: snapshot,
      subagentWidget: snapshot ? subagent : null,
      otherWidgets: snapshot ? widgets.filter((w) => w.key !== SUBAGENT_ASYNC_WIDGET_KEY) : widgets,
    };
  }, [widgets]);

  return (
    <div
      className={`extension-status-shelf${widgets.length > 0 ? " has-widgets" : ""}${statuses.length > 0 ? " has-status" : ""}`}
    >
      {/* Left: the original TUI extension shelf (widgets + status text). */}
      <div className="extension-status-left">
        {/* subagent 快照渲染为结构化卡片（解析失败则降级为文本 widget） */}
        {subagentWidget && subagentSnapshot ? (
          <SubagentWidgetCard snapshot={subagentSnapshot} sessionId={sessionId} />
        ) : null}
        {otherWidgets.length > 0 && <ExtensionWidgets widgets={otherWidgets} />}
        {statuses.length > 0 && (
          <div
            role="status"
            className="extension-status-line"
            aria-label={plainStatusLine}
            title={plainStatusLine}
          >
            <span className="extension-status-text">
              {parseAnsiLine(statusLine).map((segment, index) => (
                <span key={index} style={segment.style}>{segment.text}</span>
              ))}
            </span>
          </div>
        )}
      </div>
      {/* Right: Pi Web-owned tools, kept separate from TUI extension content.
          通知追加在最后（两端对齐：左=扩展内容，右=我们的通知，消息给最大宽+省略号） */}
      <div className={`extension-status-right${tools ? " has-tools" : ""}`}>
        {tools}
        {notice}
      </div>
    </div>
  );
}
