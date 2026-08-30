"use client";

import { useEffect, useState } from "react";
import { ChatWindow } from "@/components/ChatWindow";
import { useI18n } from "@/hooks/useI18n";
import { useAudio } from "@/hooks/useAudio";
import type { SessionInfo } from "@/lib/types";

/**
 * 工作台本体 = 复用 ChatWindow（消息 + 输入 + 底栏 widget/通知/quota 完整一套）。
 * 嵌入会话卡片下半部（见 SessionCardShape 展开态）：随卡片 resize 天然跟随宽高；
 * 收合通过双击卡片（SessionCardUtil.onDoubleClick），无独立 chrome 头。
 */
export function SessionWorkbench({
  sessionId,
}: {
  sessionId: string;
}) {
  const { t } = useI18n();
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
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: 13 }}>
          {error}
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div style={containerStyle}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
          {t("boards.loadingSession")}
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
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
  );
}

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  overflow: "hidden",
  color: "var(--text)",
};
