"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import type { NoticeItem } from "@/hooks/useAgentSession";
import type { NoticeBroadcast } from "@/hooks/useBroadcast";
import { NoticeInline, NOTICE_COLOR } from "./ComposerHeader";

const NOTICE_DRAWER_MAX_HEIGHT_RATIO = 0.6;

/**
 * 右下角通知（桌面端，保留 widget 栏原位与 NoticeInline 样式）：
 * - 折叠态：原位置原样式的通知行（圆点 + 文字 + 错误 ✕），出现时闪烁；
 *   点击 → 向上展开为贴底弹层。
 * - 弹层：贴底向上，宽度对齐原位置；通知堆叠列表，消息默认完整展开，
 *   高度自适应内容、限制最大高度（60vh），超出纵向滚动。
 * 移动端不渲染（继续用顶部 NoticeShelf）。
 */
export function NoticeDrawer({
  broadcast,
  history,
  onDismissError,
  onRemoveNotice,
  onClearNotices,
  onFreezeChange,
  isDark,
}: {
  /** pill（嵌入消息）数据源：即时公告 */
  broadcast: NoticeBroadcast | null;
  /** 抽屉（通知栏）数据源：持久化历史 */
  history: NoticeItem[];
  onDismissError: () => void;
  /** 单条清理（持久化） */
  onRemoveNotice: (id: string) => void;
  /** 全部清理（持久化） */
  onClearNotices: () => void;
  /** 抽屉展开/收起时上报，展开期间冻结过期清理 */
  onFreezeChange: (frozen: boolean) => void;
  isDark: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);

  // 抽屉展开期间冻结过期清理：展开上报 true，收起上报 false
  useEffect(() => {
    onFreezeChange(open);
  }, [open, onFreezeChange]);

  // 新通知到达时闪烁：外层 key 变更 → 重启 notice-flash 动画。
  // 首帧（含 localStorage 恢复的通知）视为已见过，不闪烁。
  const [flashTick, setFlashTick] = useState(0);
  const seenBroadcastKeyRef = useRef<string | null>(null);
  const broadcastKey = broadcast?.level === "idle" || !broadcast ? null : `${broadcast.level}:${broadcast.text}`;
  useEffect(() => {
    if (seenBroadcastKeyRef.current === null) {
      seenBroadcastKeyRef.current = broadcastKey;
      return;
    }
    if (broadcastKey && broadcastKey !== seenBroadcastKeyRef.current) {
      setFlashTick((v) => v + 1);
    }
    seenBroadcastKeyRef.current = broadcastKey;
  }, [broadcastKey]);

  // 新通知到达时自动滚到底部（最新）；首条不滚动。
  useEffect(() => {
    if (history.length <= 1) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length]);

  // 点击别处主动关闭（弹层不随消息消失而收起）
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (drawerRef.current?.contains(target)) return;
      if (pillRef.current?.contains(target)) return; // pill 自身的 toggle 处理
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  // 通知清空后自动收起弹层（没有可看的内容了）
  useEffect(() => {
    if (history.length === 0 && open) setOpen(false);
  }, [history.length, open]);

  const hasBroadcast = broadcast !== null && broadcast.level !== "idle";

  const toggleOpen = (e: React.MouseEvent) => {
    // ✕ 关闭按钮冒泡到这里时跳过（NoticeInline 内部未 stopPropagation）
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    setOpen((v) => !v);
  };

  // 折叠态：原 NoticeInline（位置、样式完全不变），外层加点击 + 闪烁动画。
  // 徽标数字：表示通知栏内历史条数，pill 隐藏后仍常驻、可点击打开通知栏。
  const historyCount = history.length;
  const badgeStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 16,
    height: 16,
    padding: "0 4px",
    borderRadius: 999,
    background: "var(--accent)",
    color: "#fff",
    fontSize: 10,
    fontWeight: 700,
    lineHeight: 1,
    flexShrink: 0,
  };
  const pill = hasBroadcast ? (
    <span
      ref={pillRef}
      key={flashTick}
      onClick={toggleOpen}
      title={open ? t("notice.collapse") : t("notice.expand")}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", minWidth: 0, maxWidth: "min(46vw, 480px)" }}
    >
      <NoticeInline
        notice={broadcast}
        onDismissError={onDismissError}
        isDark={isDark}
        style={{ animation: "notice-flash 0.9s ease 2" }}
      />
      {historyCount > 0 && (
        <span aria-label={t("notice.title")} style={badgeStyle}>
          {historyCount > 99 ? "99+" : historyCount}
        </span>
      )}
    </span>
  ) : historyCount > 0 ? (
    <span
      ref={pillRef}
      onClick={() => setOpen(true)}
      role="button"
      tabIndex={0}
      title={t("notice.title")}
      aria-label={t("notice.title")}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen(true);
        }
      }}
      style={{ ...badgeStyle, cursor: "pointer" }}
    >
      {historyCount > 99 ? "99+" : historyCount}
    </span>
  ) : null;

  // 展开弹层：锚定 pill（通知徽标）右上角，贴 pill 向上展开——pill 在所属 ChatWindow 的
  // widget 栏内，弹层跟随其位置（正常会话在视口底部 → 贴底；看板工作台嵌卡片内 → 贴卡片）。
  // 若 pill 不可见（无广播时 badge 常驻，仍可定位），fallback 视口右下。
  // 通知清空后 history.length === 0，不渲染弹层（effect 也会把 open 复位）
  const drawer = open && history.length > 0
    ? createPortal(
        <div
          ref={drawerRef}
          className="notice-drawer"
          role="region"
          aria-label={t("notice.title")}
          style={(() => {
            const pillRect = pillRef.current?.getBoundingClientRect();
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const right = pillRect ? Math.max(8, vw - pillRect.right) : 12;
            // 弹层底部对齐 widget 栏顶部（pill 所在行上方）：pill 顶再上移一点（widget 栏 padding），
            // 弹层从 widget 栏上方展开，不遮住 widget。
            const bottom = pillRect ? Math.max(8, vh - pillRect.top + 8) : 40;
            return {
              position: "fixed" as const,
              right,
              bottom,
              zIndex: 1030,
              width: `min(46vw, 480px)`,
              maxWidth: "calc(100vw - 24px)",
              maxHeight: `${NOTICE_DRAWER_MAX_HEIGHT_RATIO * 100}vh`,
              display: "flex" as const,
              flexDirection: "column" as const,
              background: "var(--panel-glass)",
              backdropFilter: "blur(var(--glass-blur-panel)) saturate(var(--glass-saturate))",
              WebkitBackdropFilter: "blur(var(--glass-blur-panel)) saturate(var(--glass-saturate))",
              border: "1px solid var(--border)",
              borderRadius: "10px 10px 0 0",
              borderBottom: "none",
              boxShadow: "0 -8px 30px rgba(0,0,0,0.35)",
              overflow: "hidden",
              animation: "notice-drawer-in 0.15s ease-out both",
              transformOrigin: "bottom right",
            };
          })()}
        >
          {/* 弹层头：标题 + 收起 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              flexShrink: 0,
              background: "color-mix(in srgb, var(--bg-hover) 60%, transparent)",
              borderBottom: "1px solid var(--border)",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--text)",
              userSelect: "none",
            }}
          >
            {t("notice.title")}
            <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>{history.length}</span>
            <span style={{ flex: 1 }} />
            {history.length > 0 && (
              <button
                type="button"
                onClick={onClearNotices}
                title={t("notice.clearAll")}
                aria-label={t("notice.clearAll")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 4,
                  padding: "3px 8px",
                  background: "none",
                  border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
                  borderRadius: 5,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 11,
                  lineHeight: 1,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                {t("notice.clearAll")}
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              title={t("i18n.close")}
              aria-label={t("i18n.close")}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 22,
                height: 22,
                padding: 0,
                background: "none",
                border: "none",
                borderRadius: 5,
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 11,
                lineHeight: 1,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              ✕
            </button>
          </div>

          {/* 通知堆叠列表：默认完整展开，超出最大高度时纵向滚动 */}
          <div
            ref={listRef}
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              padding: "6px 8px",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {history.length === 0 ? (
              <div style={{ padding: "10px 6px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                {t("notice.empty")}
              </div>
            ) : (
              history.map((notice) => {
                const color = NOTICE_COLOR[notice.type] ?? NOTICE_COLOR.info;
                return (
                  <div
                    key={notice.id}
                    className="notice-drawer-item"
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
                      background: "color-mix(in srgb, var(--glass-bg-strong) 60%, transparent)",
                      color: "var(--text)",
                      fontSize: 12.5,
                      lineHeight: 1.55,
                      animation: "notice-drawer-in 0.2s ease-out both",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        flexShrink: 0,
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: color,
                        marginTop: 5,
                      }}
                    />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {notice.message}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveNotice(notice.id);
                    }}
                    title={t("notice.remove")}
                    aria-label={t("notice.remove")}
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
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
                  >
                    ✕
                  </button>
                </div>
                );
              })
            )}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      {pill}
      {drawer}
    </>
  );
}
