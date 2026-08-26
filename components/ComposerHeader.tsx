"use client";

import type { ReactNode } from "react";
import { ThinkingOrb } from "thinking-orbs";
import type { NoticeBroadcast, PhaseBroadcast, QuotaInfo } from "@/hooks/useBroadcast";

export const NOTICE_COLOR: Record<string, string> = {
  error: "#ef4444",
  warning: "#d97706",
  success: "#10b981",
  info: "var(--accent)",
};

/** 额度微缩条：`5h ▓▓░░ 2h10m`（纯字符实现，不新增样式） */
export function QuotaView({ quota }: { quota: QuotaInfo }) {
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
 * 临时通知内联展示（P0 错误常驻带 ✕ / P1 公告插播 / P3 额度）。
 * 挂在底部工具栏附件按钮旁（ComposerHeader 不再承载通知）。
 * 样式全部复用既有 token。
 */
export function NoticeInline({
  notice,
  onDismissError,
  isDark,
  silent,
  style,
}: {
  notice: NoticeBroadcast | null;
  onDismissError: () => void;
  isDark: boolean;
  /** 静默模式：不渲染（供移动端/无数据时整体隐藏） */
  silent?: boolean;
  style?: React.CSSProperties;
}) {
  if (silent || !notice) return null;
  if (notice.level === "idle") {
    if (!notice.quota) return null;
    return (
      <span style={{ color: "var(--text-muted)", ...style }}>
        <QuotaView quota={notice.quota} />
      </span>
    );
  }
  const isError = notice.level === "error";
  return (
    <span
      role="status"
      aria-live="polite"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        minWidth: 0,
        overflow: "hidden",
        color: "var(--text)",
        fontSize: 12,
        fontFamily: "var(--font-mono)",
        ...style,
      }}
    >
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
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
    </span>
  );
}

/**
 * Composer 常驻顶栏：
 * - 左槽：运行状态（orb+文本）⇄ 空闲时由 modelSlot 填充（模型选择纯文本）
 * - 右槽：chips（发件箱 ⏳、TODO）
 * 临时通知在底部工具栏（见 NoticeInline），不占用顶栏。
 */
export function ComposerHeader({
  phase,
  modelSlot,
  right,
  isDark,
}: {
  phase: PhaseBroadcast | null;
  modelSlot?: ReactNode;
  right?: ReactNode;
  isDark: boolean;
}) {
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
      }}
    >
      {/* 左槽：状态 ⇄ 模型选择 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0, height: 20 }}>
        {left}
      </div>
      {/* 最右：chips */}
      {right != null && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, minHeight: 20 }}>{right}</div>
      )}
    </div>
  );
}
