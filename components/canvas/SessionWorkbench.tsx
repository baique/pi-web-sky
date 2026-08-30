"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, type TLShapeId } from "tldraw";
import { ChatWindow } from "@/components/ChatWindow";
import type { ChatInputHandle } from "@/components/ChatInput";
import { SessionNavBar, type SessionNavBarHandle } from "./SessionNavBar";
import { useI18n } from "@/hooks/useI18n";
import { useAudio } from "@/hooks/useAudio";
import {
  dispatchBoardAgentEnd,
  dispatchBoardAttentionNeeded,
  dispatchBoardOpenFile,
  dispatchBoardSessionCreated,
  dispatchBoardSessionForked,
} from "@/lib/board-events";
import type { SessionInfo, TodoItem } from "@/lib/types";
import type { SessionStatsInfo } from "@/lib/pi-types";

/**
 * 工作台本体 = 复用 ChatWindow（消息 + 输入 + 底栏 widget/通知/quota 完整一套）。
 * 嵌入会话卡片下半部（见 SessionCardShape 展开态）：随卡片 resize 天然跟随宽高。
 *
 * 两种形态：
 * - 普通卡（sessionId 非空）：会话内部化，顶部工具条 + 数据经 ChatWindow 回调捕获
 * - draft 卡（sessionId 空 + cwd）：看板新建会话，直接以 isNew 模式挂 ChatWindow，
 *   用户在卡内发消息 → ensure_session 拿 realId → onSessionCreated 回调
 *   （board-session-created 事件桥）由卡片侧转正。
 */
export function SessionWorkbench({
  sessionId,
  cwd,
  taskId,
}: {
  sessionId: string;
  /** draft 卡（新建会话）绑定目录 */
  cwd?: string;
  /** draft 卡（任务看板）目标任务 id */
  taskId?: string;
}) {
  const { t } = useI18n();
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio } = useAudio();
  const editor = useEditor();

  // 卡片激活判定（用户定）：激活 = tldraw 选中本卡。
  // 事件发生时实时读 editor.getSelectedShapeIds() —— 零 React 重渲染，
  // 不因选中变化触发卡片重渲染而打断画布平移/拖拽。
  // 卡片 shape id：展开态 HTMLContainer 的 data-node-id（shape.id 去 "shape:" 前缀）。
  const isActive = () => {
    const card = rootRef.current?.closest(".tl-html-container");
    const nodeId = card?.getAttribute("data-node-id");
    if (!nodeId) return false;
    return editor.getSelectedShapeIds().includes(`shape:${nodeId}` as TLShapeId);
  };
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatKey, setChatKey] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const navbarRef = useRef<SessionNavBarHandle | null>(null);
  // draft 卡（新建会话）：无 sessionId，ChatWindow 以 isNew 模式工作
  const isDraft = !sessionId;
  // draft 卡目标任务 ref（服务端在创建会话时原子归属，消费一次后清空）
  const pendingTaskRef = useRef<{ taskId: string; projectKey?: string } | null>(null);
  pendingTaskRef.current = taskId ? { taskId } : null;
  // draft 卡草稿 key：稳定标识（卡内输入框草稿持久化用）
  const draftKeyRef = useRef(`board-new:${Math.random().toString(36).slice(2, 8)}`);
  // 转正标记：draft 卡发出首条消息后 sessionId 从空变为 realId。此时 prompt 正在跑，
  // 重挂 ChatWindow 会断开 SSE 丢失事件 —— 保持 isNew 模式实例继续，不重挂。
  const wasDraftRef = useRef(true);
  if (!isDraft && wasDraftRef.current) wasDraftRef.current = false;

  // 导航条 portal 目标：卡片标题栏内的 slot（展开按钮之前）
  const [navbarSlot, setNavbarSlot] = useState<HTMLElement | null>(null);
  // tldraw 重渲染会替换 DOM，每次渲染后重新查找 slot（仅当确实变化时更新，避免无限循环）。
  // 结构：卡片(.tl-html-container) > 标题栏 + 工作台；slot 在标题栏内。
  useEffect(() => {
    const card = rootRef.current?.closest(".tl-html-container");
    const slot = card?.querySelector("[data-session-navbar-slot]") as HTMLElement | null ?? null;
    setNavbarSlot((prev) => (prev === slot ? prev : slot));
  });

  // 会话统计 + Context 用量 + TODO（经 ChatWindow 回调捕获，卡片内自渲染）
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);

  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);

  // /session 命令：打开本卡的统计弹层（多会话隔离：各自 ref 只开自己）
  const handleSessionStatsPanelOpen = useCallback(() => {
    navbarRef.current?.openStats();
  }, []);

  // 多会话数据隔离：每个展开卡各自一个 ChatWindow/useAgentSession，回调天然绑定当前会话；
  // 避免看板多卡并存时 contextUsage 串数据。
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    setContextUsage(usage);
  }, []);

  const handleTodosChange = useCallback((nextTodos: TodoItem[]) => {
    setTodos(nextTodos);
  }, []);

  // draft 卡转正：ChatWindow 拿到 realId 后回调 → 事件桥让卡片侧把 sessionId 写回转正
  const handleSessionCreated = useCallback((created: SessionInfo) => {
    if (!created?.id) return;
    const nodeId = rootRef.current?.closest(".tl-html-container")?.getAttribute("data-node-id") ?? undefined;
    dispatchBoardSessionCreated(created.id, nodeId);
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
  // 仅卡片激活时拦截（防画布吞掉会话滚动）；非激活时放行给画布平移/缩放。
  // 不用 useEffect([])：tldraw 重渲染/resize/展开收合会替换 shape 的 DOM，[] 只在首次挂载跑，
  // 监听会挂在被替换的旧元素上失效。用无依赖 effect —— 每次渲染后都清旧挂新，保证监听总在
  // 当前元素。捕获 + 冒泡双拦截，不 preventDefault（让消息区正常滚动）。
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => { if (isActive()) e.stopPropagation(); };
    el.addEventListener("wheel", stop, { capture: true });
    el.addEventListener("wheel", stop);
    return () => {
      el.removeEventListener("wheel", stop, { capture: true });
      el.removeEventListener("wheel", stop);
    };
  });

  // 拉取会话数据（cwd/projectKey 等 ChatWindow 需要）。draft 卡跳过：
  // 无真实会话，ChatWindow 以 isNew 模式新建。
  useEffect(() => {
    if (isDraft) return;
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
  }, [sessionId, t, isDraft]);

  if (error) {
    return (
      <div style={containerStyle}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: 13 }}>
          {error}
        </div>
      </div>
    );
  }

  if (!session && !isDraft) {
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
      onPointerDown={(e) => { if (isActive()) e.stopPropagation(); }}
      onPointerUp={(e) => { if (isActive()) e.stopPropagation(); }}
      onClick={(e) => { if (isActive()) e.stopPropagation(); }}
      onDoubleClick={(e) => { if (isActive()) e.stopPropagation(); }}
    >
      {/* 会话导航条：portal 到卡片标题栏右侧（展开按钮之前），融入标题栏而非独立一行。
          仅已转正会话显示（draft 卡标题栏是新会话占位，无导航条） */}
      {navbarSlot && session && createPortal(
        <SessionNavBar
          ref={navbarRef}
          sessionId={session.id}
          stats={sessionStats}
          contextUsage={contextUsage}
          todos={todos}
        />,
        navbarSlot,
      )}

      <ChatWindow
        key={chatKey}
        // 转正后保持 isNew 实例（首条 prompt 正在跑，重挂会断 SSE）；
        // 后续刷新/展开由摘要轮询 + 卡片标题接管，本实例不再切换
        session={isDraft || wasDraftRef.current ? null : session}
        newSessionCwd={isDraft || wasDraftRef.current ? (cwd ?? null) : null}
        newSessionDraftKey={isDraft || wasDraftRef.current ? draftKeyRef.current : null}
        pendingNewSessionTaskRef={isDraft || wasDraftRef.current ? pendingTaskRef : undefined}
        chatInputRef={chatInputRef}
        inWorkbench
        onSessionStatsChange={handleSessionStatsChange}
        onContextUsageChange={handleContextUsageChange}
        onSessionStatsPanelOpen={handleSessionStatsPanelOpen}
        onTodosChange={handleTodosChange}
        onOpenFile={handleOpenFile}
        onSessionCreated={isDraft ? (created) => handleSessionCreated(created) : undefined}
        onSessionForked={handleSessionForked}
        onAgentEnd={handleAgentEnd}
        onAttentionNeeded={handleAttentionNeeded}
        soundEnabled={soundEnabled}
        onSoundToggle={onSoundToggle}
        playDoneSound={playDoneSound}
        unlockAudio={unlockAudio}
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
