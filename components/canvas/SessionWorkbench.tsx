"use client";

import { useCallback, useEffect, useState } from "react";
import { ChatWindow } from "@/components/ChatWindow";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { useAudio } from "@/hooks/useAudio";
import type { SessionInfo } from "@/lib/types";

/**
 * 工作台本体 = 复用 ChatWindow（消息 + 输入 + 底栏 widget/通知/quota 完整一套）+ chrome 头。
 * 外层 chrome 容器提供与画布卡片同款毛玻璃，外层 rect 由 WorkbenchOverlay 反补偿缩放。
 */
export function SessionWorkbench({
  sessionId,
  sessionTitle,
  onCollapse,
}: {
  sessionId: string;
  sessionTitle: string;
  onCollapse: () => void;
}) {
  const { t } = useI18n();
  const { isDark } = useTheme();
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio } = useAudio();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatKey, setChatKey] = useState(0);

  // 拉取会话数据（cwd/projectKey 等 ChatWindow 需要）
  useEffect(() => {
    let cancelled = false;
    setSession(null);
    setError(null);
    void (async () => {
      try {
        const res = await fetch("/api/sessions", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { sessions: SessionInfo[] };
        const found = data.sessions.find((s) => s.id === sessionId);
        if (cancelled) return;
        if (!found) {
          setError(t("boards.sessionMissing"));
          return;
        }
        setSession(found);
        setChatKey((k) => k + 1); // 重挂 ChatWindow，确保新会话干净
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, t]);

  if (error) {
    return (
      <div style={containerStyle}>
        <Chrome title={sessionTitle} onCollapse={onCollapse} isDark={isDark} />
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: 13 }}>
          {error}
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div style={containerStyle}>
        <Chrome title={sessionTitle} onCollapse={onCollapse} isDark={isDark} />
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
          {t("boards.loadingSession")}
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <Chrome title={sessionTitle || session.name || session.id} onCollapse={onCollapse} isDark={isDark} />
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <ChatWindow
          key={chatKey}
          session={session}
          newSessionCwd={null}
          newSessionDraftKey={null}
          soundEnabled={soundEnabled}
          onSoundToggle={onSoundToggle}
          playDoneSound={playDoneSound}
          unlockAudio={unlockAudio}
          fillWidth
        />
      </div>
    </div>
  );
}

function Chrome({
  title,
  onCollapse,
  isDark,
}: {
  title: string;
  onCollapse: () => void;
  isDark: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderBottom: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
        background: "var(--frame-glass)",
        backdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
        WebkitBackdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
        fontSize: 12.5,
        flexShrink: 0,
      }}
    >
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)" }} />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
        {title}
      </span>
      <div style={{ flex: 1 }} />
      <button
        type="button"
        onClick={onCollapse}
        title={t("boards.collapse")}
        aria-label={t("boards.collapse")}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          padding: 0,
          border: "1px solid transparent",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          borderRadius: 7,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  background: "var(--panel-glass)",
  backdropFilter: "blur(var(--glass-blur-panel)) saturate(var(--glass-saturate))",
  WebkitBackdropFilter: "blur(var(--glass-blur-panel)) saturate(var(--glass-saturate))",
  borderRadius: 14,
  border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
  boxShadow: "0 4px 24px -8px rgba(0,0,0,0.25)",
  overflow: "hidden",
  color: "var(--text)",
};
