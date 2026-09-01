"use client";

/**
 * 卡片类别徽记（看板区分卡片面板）：[●状态圆点] + 类别文字。
 * 三类卡片（会话/任务/便笺）统一规格：
 * - 状态点：8px 彩色圆点（会话=phase 色 / 任务=exec 色 / 便笺=用户徽记色），颜色由调用方传入
 * - 类型：11px 浅色字（var(--text-muted)），与标题区分
 * - 标题：由调用方另行渲染（深白浅黑 var(--text)）
 * - 其他按钮：右侧两端对齐（调用方布局）
 */

export type CardKind = "session" | "note" | "task";

const KIND_LABEL: Record<CardKind, string> = {
  session: "会话",
  note: "便笺",
  task: "任务",
};

export function CardKindBadge({ kind, color }: { kind: CardKind; color: string }) {
  return (
    <span
      title={`${KIND_LABEL[kind]} · 状态由圆点颜色表示`}
      style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0, lineHeight: 1 }}
    >
      <span
        aria-hidden
        style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }}
      />
      <span
        style={{
          fontSize: 11,
          color: "var(--text-muted)",
          whiteSpace: "nowrap",
        }}
      >
        {KIND_LABEL[kind]}
      </span>
    </span>
  );
}
