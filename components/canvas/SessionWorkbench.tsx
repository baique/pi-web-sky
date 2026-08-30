"use client";

import { useEffect, useRef, useState } from "react";
import { ChatWindow } from "@/components/ChatWindow";
import { useI18n } from "@/hooks/useI18n";
import { useAudio } from "@/hooks/useAudio";
import { dispatchBoardTerminalToggle } from "@/lib/board-events";
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
  const rootRef = useRef<HTMLDivElement>(null);

  // 原生 wheel 捕获拦截：tldraw 的 usePassThroughWheelEvents 用原生 addEventListener 挂在
  // container 上，React onWheel stopPropagation 拦不住它。这里捕获阶段 stopPropagation，
  // 保证工作台内的滚动不传到 tldraw container（否则消息区未可滚动时被劫持成画布缩放/平移）。
  // 不 preventDefault —— 让目标元素正常滚动。pointer 事件由下方 React 冒泡拦截覆盖，无需重复。
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheelCapture = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener("wheel", onWheelCapture, { capture: true });
    return () => el.removeEventListener("wheel", onWheelCapture, { capture: true });
  }, []);

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
    <div
      ref={rootRef}
      style={containerStyle}
      // 工作台嵌在 tldraw 卡片内：阻止事件冒泡到画布。tldraw 画布在 pointerDown 上
      // preventDefault（会吞掉后续 click），导致终端/模型选择器/session/通知等无法弹出。
      // 冒泡阶段拦截：事件先正常到达目标（内部按钮可点击），再阻止冒泡到画布。
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <ChatWindow
        key={chatKey}
        session={session}
        newSessionCwd={null}
        newSessionDraftKey={null}
        soundEnabled={soundEnabled}
        onSoundToggle={onSoundToggle}
        playDoneSound={playDoneSound}
        unlockAudio={unlockAudio}
        // 工作台内终端按钮：触发全局事件 → AppShell 打开底部终端面板
        onToggleTerminal={() => dispatchBoardTerminalToggle("bottombar")}
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
