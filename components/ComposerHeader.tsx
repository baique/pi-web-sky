"use client";

import type { ReactNode } from "react";
import { ThinkingOrb } from "thinking-orbs";
import type { NoticeBroadcast, PhaseBroadcast, QuotaInfo } from "@/hooks/useBroadcast";

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

function Orb({ state, isDark }: { state: "breathing" | "working"; isDark: boolean }) {
  return (
    <ThinkingOrb
      state={state}
      size={20}
      theme={isDark ? "dark" : "light"}
      style={isDark ? undefined : { filter: "brightness(0.57) contrast(1.15)" }}
    />
  );
}

/**
 * Composer 常驻顶栏：
 * - 左槽：运行状态（orb+文本）⇄ 空闲时由 modelSlot 填充（如模型选择器）
 * - 右区（flex）：临时通知——P0 错误常驻（红缘+✕）/ P1 公告插播 / P3 额度
 * - 最右：插槽（发件箱 ⏳、TODO chip）
 * 样式全部复用输入框区既有 token，不新增任何 token。
 */
export function ComposerHeader({
  phase,
  notice,
  onDismissError,
  modelSlot,
  right,
  isDark,
}: {
  phase: PhaseBroadcast | null;
  notice: NoticeBroadcast | null;
  onDismissError: () => void;
  modelSlot?: ReactNode;
  right?: ReactNode;
  isDark: boolean;
}) {
  const isError = notice?.level === "error";

  // 左槽：状态 ⇄ 模型选择
  let left: ReactNode = null;
  if (phase) {
    left = (
      <>
        <Orb state={phase.orb} isDark={isDark} />
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {phase.text}
        </span>
      </>
    );
  } else if (modelSlot) {
    left = modelSlot;
  }

  // 右区：临时通知 / 额度
  let mid: ReactNode = null;
  if (notice?.level === "error" || notice?.level === "notice") {
    mid = (
      <>
        {isError ? (
          <Orb state="breathing" isDark={isDark} />
        ) : (
          <span
            aria-hidden="true"
            style={{
              flexShrink: 0,
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: NOTICE_COLOR[notice.kind] ?? NOTICE_COLOR.info,
            }}
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
          {notice.text}
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
  } else if (notice?.level === "idle" && notice.quota) {
    mid = (
      <span
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--text-muted)",
        }}
      >
        <QuotaView quota={notice.quota} />
      </span>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        alignItems: "center",
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
      {/* 左槽：状态 ⇄ 模型选择 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, minWidth: 0, maxWidth: "55%" }}>
        {left}
      </div>
      {/* 右区：临时通知 / 额度 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0, justifyContent: "flex-end" }}>
        {mid}
      </div>
      {/* 最右：chips */}
      {right != null && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>{right}</div>
      )}
    </div>
  );
}
