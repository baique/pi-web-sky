"use client";

import type { ReactNode } from "react";
import { ThinkingOrb } from "thinking-orbs";
import type { Broadcast, QuotaInfo } from "@/hooks/useBroadcast";

const NOTICE_COLOR: Record<string, string> = {
  error: "#ef4444",
  warning: "#d97706",
  success: "#10b981",
  info: "var(--accent)",
};

/** 额度微缩条：`5h ▓▓░░ 2h10m`（纯字符实现，不新增样式） */
function QuotaView({ quota }: { quota: QuotaInfo }) {
  if (quota.kind === "balance") {
    return <span>{quota.text}</span>;
  }
  const item = quota.items[0];
  if (!item) return null;
  const filled = Math.max(0, Math.min(8, Math.round(item.pct * 8)));
  const bar = "▓".repeat(filled) + "░".repeat(8 - filled);
  return (
    <span>
      {item.label} {bar} {item.text}
    </span>
  );
}

/**
 * Composer 常驻顶栏：左侧播报槽（P0-P3），右侧插槽（发件箱/TODO chip）。
 * 样式全部复用输入框区既有 token，不新增任何 token。
 */
export function ComposerHeader({
  broadcast,
  onDismissError,
  right,
  isDark,
}: {
  broadcast: Broadcast | null;
  onDismissError: () => void;
  right?: ReactNode;
  isDark: boolean;
}) {
  const isError = broadcast?.level === "error";
  let left: ReactNode = null;
  if (broadcast) {
    if (broadcast.level === "error" || broadcast.level === "notice") {
      left = (
        <>
          {isError ? (
            <ThinkingOrb
              state="breathing"
              size={20}
              theme={isDark ? "dark" : "light"}
              style={isDark ? undefined : { filter: "brightness(0.57) contrast(1.15)" }}
            />
          ) : (
            <span
              aria-hidden="true"
              style={{ flexShrink: 0, width: 5, height: 5, borderRadius: "50%", background: NOTICE_COLOR[broadcast.kind] ?? NOTICE_COLOR.info }}
            />
          )}
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {broadcast.text}
          </span>
          {isError && (
            <button
              onClick={onDismissError}
              title="关闭"
              aria-label="关闭错误提示"
              style={{
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 18,
                height: 18,
                padding: 0,
                background: "none",
                border: "none",
                borderRadius: 5,
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 11,
                lineHeight: 1,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "none";
                e.currentTarget.style.color = "var(--text-muted)";
              }}
            >
              ✕
            </button>
          )}
        </>
      );
    } else if (broadcast.level === "phase") {
      left = (
        <>
          <ThinkingOrb
            state={broadcast.orb}
            size={20}
            theme={isDark ? "dark" : "light"}
            style={isDark ? undefined : { filter: "brightness(0.57) contrast(1.15)" }}
          />
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {broadcast.text}
          </span>
        </>
      );
    } else if (broadcast.quota) {
      left = (
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--text-muted)",
          }}
        >
          <QuotaView quota={broadcast.quota} />
        </span>
      );
    }
  }
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        height: 34,
        minHeight: 34,
        padding: "0 6px",
        minWidth: 0,
        boxShadow: isError ? "inset 2px 0 0 #ef4444" : undefined,
        paddingLeft: isError ? 8 : 6,
        transition: "box-shadow 0.15s, padding-left 0.15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>{left}</div>
      {right != null && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>{right}</div>
      )}
    </div>
  );
}
