"use client";

import { parseAnsiLine, stripAnsi } from "@/lib/ansi";
import type { ExtensionStatusItem, ExtensionWidgetItem } from "@/lib/types";
import { ExtensionWidgets } from "./ExtensionWidgets";

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
}: {
  statuses: ExtensionStatusItem[];
  widgets?: ExtensionWidgetItem[];
  /** Pi Web-owned tools rendered in the right side of the shelf. */
  tools?: React.ReactNode;
  /** 临时通知（P0/P1），追加在最右，可单独使整条 shelf 可见。 */
  notice?: React.ReactNode;
}) {
  // The shelf is event-driven: Pi Web tools use its reserved right slot but
  // must not make the otherwise-empty extension shelf permanently visible.
  if (statuses.length === 0 && widgets.length === 0 && !tools && !notice) return null;

  const statusLine = formatExtensionStatusLine(statuses);
  const plainStatusLine = stripAnsi(statusLine);

  return (
    <div
      className={`extension-status-shelf${widgets.length > 0 ? " has-widgets" : ""}${statuses.length > 0 ? " has-status" : ""}`}
    >
      {/* Left: the original TUI extension shelf (widgets + status text). */}
      <div className="extension-status-left">
        {widgets.length > 0 && <ExtensionWidgets widgets={widgets} />}
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
