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

/** 使用率健康色：绿（≤50%）/ 黄（50~80%）/ 红（>80%） */
function healthColor(pct: number): string {
  if (pct > 0.8) return NOTICE_COLOR.error;
  if (pct > 0.5) return NOTICE_COLOR.warning;
  return NOTICE_COLOR.success;
}

/**
 * 额度微缩条（纯文本，不新增样式）：
 * - usage：多窗平铺 `5h 24% · 周 84% · 月 95%`，悬停看重置时间明细
 * - balance：直接文本
 */
export function QuotaView({ quota }: { quota: QuotaInfo }) {
  if (quota.kind === "balance") {
    return <span style={{ whiteSpace: "nowrap", flexShrink: 0 }}>{quota.text}</span>;
  }
  if (quota.items.length === 0) return null;
  const title = quota.items
    .map((i) => i.detail ?? `${i.label} ${Math.round(i.pct * 100)}%`)
    .join("\n");
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
      {quota.items.map((item) => (
        <span key={item.label} style={{ whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 3 }}>
          <span
            aria-hidden
            style={{
              flexShrink: 0,
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: healthColor(item.pct),
            }}
          />
          {item.label} {item.text}
        </span>
      ))}
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
  quota,
  isDark,
}: {
  phase: PhaseBroadcast | null;
  modelSlot?: ReactNode;
  right?: ReactNode;
  /** 额度展示位：排在模型选择后方（数据适配器后置，当前恒空） */
  quota?: QuotaInfo | null;
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
            /* 与模型选择器统一：12px mono、行高 20px、色值 text-muted 完全一致 */
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            lineHeight: "20px",
            color: "var(--text-muted)",
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
        height: 26,
        minHeight: 26,
        padding: "0 6px",
        minWidth: 0,
      }}
    >
      {/* 左槽：状态 ⇄ 模型选择（额度排在模型后方） */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0, height: 20 }}>
        {left}
        {quota && !phase && (
          <span
            style={{
              flexShrink: 0,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              lineHeight: "20px",
              color: "var(--text-dim)",
            }}
          >
            <QuotaView quota={quota} />
          </span>
        )}
      </div>
      {/* 最右：chips */}
      {right != null && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, minHeight: 20 }}>{right}</div>
      )}
    </div>
  );
}
