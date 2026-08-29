"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SubagentInspectReply, SubagentInspectMessage } from "@/lib/subagent-widget";

const ROLE_COLORS: Record<string, string> = {
  user: "var(--accent)",
  assistant: "var(--text)",
  toolCall: "#8b5cf6",
  toolResult: "#64748b",
};

function MessageRow({ message }: { message: SubagentInspectMessage }) {
  const [expanded, setExpanded] = useState(false);
  const isCall = message.kind === "toolCall";
  const isResult = message.kind === "toolResult";
  const collapsible = isCall || isResult;

  const summary = isCall
    ? `${message.name ?? "tool"} · ${message.text.slice(0, 60)}`
    : isResult
      ? (message.isError ? "error" : "output") + (message.text ? ` · ${message.text.slice(0, 60)}` : "")
      : message.text.slice(0, 120);

  return (
    <div style={{ padding: "3px 0" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
        <span
          style={{
            color: ROLE_COLORS[message.kind] ?? "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontWeight: 600,
            flexShrink: 0,
            width: 64,
          }}
        >
          {message.kind}
        </span>
        {collapsible ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              cursor: "pointer",
              textAlign: "left",
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              padding: 0,
            }}
          >
            {expanded ? "▾ " : "▸ "}{summary}
          </button>
        ) : (
          <span style={{ color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11, flex: 1, minWidth: 0, wordBreak: "break-word" }}>
            {summary}
          </span>
        )}
      </div>
      {collapsible && expanded && (
        <pre
          style={{
            margin: "4px 0 0 70px",
            padding: "6px 8px",
            background: "var(--bubble-code-bg)",
            borderRadius: "var(--bubble-inner-radius)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            lineHeight: 1.45,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 240,
            overflow: "auto",
          }}
        >
          {message.text}
        </pre>
      )}
    </div>
  );
}

export function SubagentInspectPanel({
  reply,
  title,
  onClose,
}: {
  reply: SubagentInspectReply;
  title: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const messages = reply.messages ?? [];
  const status = reply.status ? ` · ${reply.status}` : "";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: "relative",
          width: "min(760px, 100%)",
          maxHeight: "min(640px, calc(100vh - 40px))",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          outline: "none",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            subagent · {title}{status}
          </div>
          <button
            onClick={onClose}
            style={{
              padding: "5px 9px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
              flexShrink: 0,
            }}
          >
            {t("chat.close")}
          </button>
        </div>
        <div style={{ padding: "10px 12px", overflow: "auto", flex: 1, minHeight: 0 }}>
          {reply.error ? (
            <div style={{ color: "#f87171", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              {reply.error.message}
            </div>
          ) : messages.length === 0 && !reply.finalOutput ? (
            <div style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("chat.extensionNoDetail")}</div>
          ) : (
            <>
              {messages.map((message, index) => (
                <MessageRow key={index} message={message} />
              ))}
              {reply.finalOutput && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10, marginBottom: 4 }}>
                    final output
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: "8px 10px",
                      background: "var(--bubble-code-bg)",
                      borderRadius: "var(--bubble-inner-radius)",
                      color: "var(--text)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      lineHeight: 1.45,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      maxHeight: 300,
                      overflow: "auto",
                    }}
                  >
                    {reply.finalOutput}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
