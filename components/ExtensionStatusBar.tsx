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
}: {
  statuses: ExtensionStatusItem[];
  widgets?: ExtensionWidgetItem[];
  /** Pi Web-owned tools rendered in the right side of the shelf. */
  tools?: React.ReactNode;
}) {
  // The shelf is event-driven: Pi Web tools use its reserved right slot but
  // must not make the otherwise-empty extension shelf permanently visible.
  if (statuses.length === 0 && widgets.length === 0) return null;

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
      {/* Right: Pi Web-owned tools, kept separate from TUI extension content. */}
      <div className={`extension-status-right${tools ? " has-tools" : ""}`}>{tools}</div>
    </div>
  );
}
