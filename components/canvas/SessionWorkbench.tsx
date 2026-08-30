"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatWindow } from "@/components/ChatWindow";
import type { ChatInputHandle } from "@/components/ChatInput";
import { SessionNavBar } from "./SessionNavBar";
import { useI18n } from "@/hooks/useI18n";
import { useAudio } from "@/hooks/useAudio";
import {
  dispatchBoardAgentEnd,
  dispatchBoardAttentionNeeded,
  dispatchBoardOpenFile,
  dispatchBoardSessionForked,
  dispatchBoardTerminalToggle,
} from "@/lib/board-events";
import type { SessionInfo, SessionTreeNode, TodoItem } from "@/lib/types";
import type { SessionStatsInfo } from "@/lib/pi-types";

/**
 * 工作台本体 = 复用 ChatWindow（消息 + 输入 + 底栏 widget/通知/quota 完整一套）。
 * 嵌入会话卡片下半部（见 SessionCardShape 展开态）：随卡片 resize 天然跟随宽高。
 *
 * 会话内部化改造（看板衍生问题的核心）：
 * - 顶部会话工具条：分支导航 + 统计按钮（数据经 ChatWindow 回调捕获，卡片内自渲染，
 *   不依赖 AppShell 顶栏）
 * - 断链回调补齐：chatInputRef（edit-from-here）、onOpenFile（文件面板）、
 *   onSessionForked / onAgentEnd / onAttentionNeeded（事件桥转发到 AppShell）
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
  const chatInputRef = useRef<ChatInputHandle | null>(null);

  // 分支导航状态（经 ChatWindow onBranchDataChange 捕获，卡片内自渲染）
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeRef = useRef<((leafId: string | null) => void) | null>(null);

  // 会话统计 + TODO（经 ChatWindow onSessionStatsChange / onTodosChange 捕获）
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeRef.current = onLeafChange;
  }, []);

  const handleLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeRef.current?.(leafId);
  }, []);

  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);

  const handleTodosChange = useCallback((nextTodos: TodoItem[]) => {
    setTodos(nextTodos);
  }, []);

  // 事件桥转发：工作台内无法直接拿 AppShell handler，走全局事件（携带 sessionId）
  const handleOpenFile = useCallback((filePath: string) => {
    dispatchBoardOpenFile(sessionId, filePath);
  }, [sessionId]);

  const handleSessionForked = useCallback((newSessionId: string) => {
    dispatchBoardSessionForked(sessionId, newSessionId);
  }, [sessionId]);

  const handleAgentEnd = useCallback(() => {
    dispatchBoardAgentEnd(sessionId, session?.name);
  }, [sessionId, session?.name]);

  const handleAttentionNeeded = useCallback((request: import("@/lib/types").BlockingExtensionUiRequest) => {
    dispatchBoardAttentionNeeded(sessionId, {
      title: request.method === "custom" ? undefined : request.title,
      method: request.method,
    });
  }, [sessionId]);

  // wheel 拦截：tldraw 在 container 监听 wheel（画布 pan/zoom），工作台内的滚轮必须被会话自己消费。
  // 不用 useEffect([])：tldraw 重渲染/resize/展开收合会替换 shape 的 DOM，[] 只在首次挂载跑，
  // 监听会挂在被替换的旧元素上失效。用无依赖 effect —— 每次渲染后都清旧挂新，保证监听总在
  // 当前元素。捕获 + 冒泡双拦截，不 preventDefault（让消息区正常滚动）。
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener("wheel", stop, { capture: true });
    el.addEventListener("wheel", stop);
    return () => {
      el.removeEventListener("wheel", stop, { capture: true });
      el.removeEventListener("wheel", stop);
    };
  });

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
      className="board-workbench"
      style={containerStyle}
      // 工作台嵌在 tldraw 卡片内：阻止事件冒泡到画布。tldraw 画布在 pointerDown 上
      // preventDefault（会吞掉后续 click），导致终端/模型选择器/session/通知等无法弹出。
      // 冒泡阶段拦截：事件先正常到达目标（内部按钮可点击），再阻止冒泡到画布。
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {/* 会话导航条：分支 / 历史 / 统计 / TODO（会话内部 UI，不依赖 AppShell 顶栏） */}
      <SessionNavBar
        sessionId={session.id}
        sessionName={session.name ?? session.firstMessage}
        branchTree={branchTree}
        branchActiveLeafId={branchActiveLeafId}
        onLeafChange={handleLeafChange}
        stats={sessionStats}
        todos={todos}
      />

      <ChatWindow
        key={chatKey}
        session={session}
        newSessionCwd={null}
        newSessionDraftKey={null}
        chatInputRef={chatInputRef}
        inWorkbench
        onBranchDataChange={handleBranchDataChange}
        onSessionStatsChange={handleSessionStatsChange}
        onTodosChange={handleTodosChange}
        onOpenFile={handleOpenFile}
        onSessionForked={handleSessionForked}
        onAgentEnd={handleAgentEnd}
        onAttentionNeeded={handleAttentionNeeded}
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
