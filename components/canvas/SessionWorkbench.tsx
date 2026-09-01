"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor } from "tldraw";
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
 * - 普通卡（sessionId 非空 + cwd 空）：会话内部化，顶部工具条 + 数据经 ChatWindow 回调捕获
 * - 新会话卡（sessionId = 发起时生成的 UUID + cwd 非空）：看板新建会话，直接以 isNew 模式
 *   挂 ChatWindow，用户在卡内发消息 → ensure_session 携带该 UUID 创建会话 → onSessionCreated
 *   回调清 cwd 字段转正（卡片 sessionId 本就一致，无需事件桥写回）。
 */
export function SessionWorkbench({
  sessionId,
  cwd,
  taskId,
}: {
  sessionId: string;
  /** 新会话卡（看板新建会话）绑定目录；cwd 非空 = 会话尚未创建 */
  cwd?: string;
  /** 新会话卡（任务看板）目标任务 id */
  taskId?: string;
}) {
  const { t } = useI18n();
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio } = useAudio();
  const editor = useEditor();

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatKey, setChatKey] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const navbarRef = useRef<SessionNavBarHandle | null>(null);
  // 新会话卡（看板新建会话）：sessionId 是发起时生成的 UUID（卡片出生即有），
  // cwd 非空标记“会话尚未创建”——ChatWindow 以 isNew 模式工作，首条消息
  // 携带该 UUID 创建会话。会话创建成功（cwd 清空）后转正为普通卡。
  const isNewSession = Boolean(cwd);
  // 新会话卡目标任务 ref（服务端创建会话时原子归属任务，消费一次后清空）。
  // 不需要 nodeId：卡片 sessionId 发起时即确定（在 CRDT 文档里），无需服务端写回。
  const pendingTaskRef = useRef<{ taskId?: string; projectKey?: string } | null>(null);
  pendingTaskRef.current = isNewSession ? (taskId ? { taskId } : null) : null;
  // 新会话卡草稿 key = 会话 UUID（卡片 sessionId）：与 ensureNewSession 生成的
  // 指定 id 恒等，草稿持久化从出生起就用真实会话 ID。
  const draftKeyRef = useRef(sessionId);
  // 新会话卡初始 cwd：转正后卡片侧会把 cwd 字段清空（props.cwd 变 ""），但 isNew 实例
  // 仍需 cwd 作 newSessionCwd（第二条消息 ensure_session 用），这里缓存首帧值。
  const cwdRef = useRef(cwd ?? null);
  // 转正标记：本实例内发过消息（prompt 正在跑，卸载/重挂 ChatWindow 会断开 SSE）。
  // 本实例生命周期内保持 isNew 模式继续，不重挂。组件重建（收合再展开 / 刷新 / 重新打开）
  // 时 wasNewSessionRef 重新按 isNewSession 初始化，转正后的卡片走回普通会话模式加载历史。
  const wasNewSessionRef = useRef(isNewSession);
  // 本实例内是否发过消息并转正（onSessionCreated 触发过）：为 true 说明 prompt 正在跑，
  // 保持 isNew 不断 SSE；为 false 且 cwd 从非空变空 = 外部转正（其他客户端清 cwd），
  // 可安全切换到会话模式。
  const localPromotedRef = useRef(false);
  // 监听 cwd 从非空变空：外部转正时复位 wasNewSessionRef 并重挂 ChatWindow 加载会话。
  // 本实例内转正（localPromotedRef=true）保持 isNew（prompt 在跑不断 SSE）。
  const prevCwdRef = useRef(cwd);
  useEffect(() => {
    const prev = prevCwdRef.current;
    prevCwdRef.current = cwd;
    if (!prev) return; // 非「非空 → 空」变化
    if (cwd) return;
    if (wasNewSessionRef.current && !localPromotedRef.current) {
      // 外部转正：本实例从未发消息，重挂 ChatWindow 走普通会话模式
      wasNewSessionRef.current = false;
      setChatKey((k) => k + 1);
    }
  }, [cwd]);

  // 导航条 portal 目标：卡片标题栏内的 slot（展开按钮之前）
  const [navbarSlot, setNavbarSlot] = useState<HTMLElement | null>(null);
  // tldraw 重渲染会替换 DOM，每次渲染后重新查找 slot（仅当确实变化时更新，避免无限循环）。
  // 结构：卡片(.tl-html-container) > 标题栏 + 工作台；slot 在标题栏内。
  useEffect(() => {
    const card = rootRef.current?.closest(".tl-html-container");
    const slot = card?.querySelector("[data-session-navbar-slot]") as HTMLElement | null ?? null;
    setNavbarSlot((prev) => (prev === slot ? prev : slot));
    // 无依赖数组：tldraw 重渲染会替换 DOM，必须每次渲染后重挂监听/同步（与 wheel 拦截同风格）
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

  // 新会话卡转正：ChatWindow 拿到 realId 后回调。会话创建成功（文件已落盘），
  // 卡片 sessionId 本就是发起时生成的 UUID（= created.id），这里只清 cwd 字段
  // 标记“会话已创建”转正为普通卡（CRDT 同步到文档），并派发事件让侧栏刷新。
  const handleSessionCreated = useCallback((created: SessionInfo) => {
    if (!created?.id) return;
    // 本实例内发过消息（prompt 在跑）：转正保持 isNew 不断 SSE
    localPromotedRef.current = true;
    // 清 cwd 字段（shape props 更新经 CRDT 同步持久化，无需服务端写回）
    const card = rootRef.current?.closest(".tl-html-container");
    const nodeId = card?.getAttribute("data-node-id");
    if (nodeId) {
      editor.updateShapes([{
        id: `shape:${nodeId}` as never,
        type: "session-card",
        props: { cwd: "" },
      } as never]);
    }
    // 事件桥：侧栏刷新（会话已挂到任务/出现在左侧树）
    dispatchBoardSessionCreated(created.id);
  }, [editor]);

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
  // 当前元素。判定「按需」= 状态 × 几何：卡片激活（用户当前关注此卡）且目标在可滚动容器内
  // 才拦截（stopPropagation，不 preventDefault —— 让消息区正常滚动）；未激活或不在滚动区则
  // 放行给画布平移/缩放 —— 展开卡未激活时滚轮应作用于画布（常见：展开会话看内容但想移画布）。
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => {
      // ctrl/meta+wheel 是缩放手势：放行给画布（tldraw 缩放），不吞
      if (e.ctrlKey || e.metaKey) return;
      // 实验性去除激活态条件：内容溢出即拦（内部滚动），不再区分卡片是否激活
      const t = e.target;
      if (t instanceof Node && el.contains(t) && hasScrollableAncestor(t, el)) {
        e.stopPropagation();
      }
    };
    el.addEventListener("wheel", stop);
    return () => {
      el.removeEventListener("wheel", stop);
    };
  });

  // copy 拦截（原生监听，bubble 阶段）：工作台内（消息区等）选中文本后 Ctrl+C 会被 tldraw 劫持——
  // 卡片处于选中态（selectedShapeIds 非空）且焦点不在输入元素时，tldraw 的 useNativeClipboardEvents
  // 在 document 上 preventDefault 并复制 shape，写出的 text/plain 是 shape 的文本而非选区（会话卡
  // getText 提不出内容，实际是空/空白）。这里在事件冒泡到 document（tldraw 监听处）之前，若存在
  // 非空文本选区就 stopPropagation，放行浏览器原生复制选区；无文本选区（shape 选中复制）则放行给
  // tldraw 正常复制。与便笺 StickyNoteShape 同方案。无依赖 effect：DOM 随渲染替换。
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onCopy = (e: ClipboardEvent) => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) e.stopPropagation();
    };
    el.addEventListener("copy", onCopy);
    return () => el.removeEventListener("copy", onCopy);
  });

  // 拉取会话数据（cwd/projectKey 等 ChatWindow 需要）。新会话卡跳过：
  // 会话尚未创建，ChatWindow 以 isNew 模式新建。
  useEffect(() => {
    if (isNewSession) return;
    let cancelled = false;
    // 新会话转正：ChatWindow 保持 isNew 实例继续（不卸载、不重挂，避免断 SSE），
    // 仅拉 session 元数据供导航条渲染；不 setSession(null)，以免工作台闪 loading。
    // 首条 prompt 落盘前 /api/sessions 可能查不到（会话创建即落盘，窗口极短），此时不置错，
    // 收合再展开/刷新会走普通卡路径补上。
    if (wasNewSessionRef.current) {
      setError(null);
      void (async () => {
        try {
          const res = await fetch("/api/sessions", { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = (await res.json()) as { sessions: SessionInfo[] };
          const found = data.sessions.find((s) => s.id === sessionId);
          if (cancelled) return;
          if (found) setSession(found);
        } catch (e) {
          console.warn("new session metadata load failed:", e);
        }
      })();
      return () => { cancelled = true; };
    }
    // 普通卡：加载会话并重挂 ChatWindow，确保新会话干净
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
  }, [sessionId, t, isNewSession]);

  if (error) {
    return (
      <div style={containerStyle}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: 13 }}>
          {error}
        </div>
      </div>
    );
  }

  if (!session && !isNewSession && !wasNewSessionRef.current) {
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
      // 仅左键（button 0）拦截；右键(2)/中键(1)放行 —— 右键必须冒泡到 tldraw 打开菜单。
      // 实验性去除激活态条件：未激活的卡片点击内容区也直接拦截左键（与便笺同模式），
      // 修复「点按钮以为点上了、实际只是激活了还要再点一下」；tldraw 的选中/双击判定
      // 走 capture 阶段不受影响。右键(2)/中键(1)仍放行 —— 右键必须冒泡到 tldraw 打开菜单。
      onPointerDown={(e) => { if (e.button === 0) e.stopPropagation(); }}
      onPointerUp={(e) => { if (e.button === 0) e.stopPropagation(); }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {/* 会话导航条：portal 到卡片标题栏右侧（展开按钮之前），融入标题栏而非独立一行。
          仅已转正会话显示（新会话卡标题栏是新建占位，无导航条） */}
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
        session={isNewSession || wasNewSessionRef.current ? null : session}
        newSessionCwd={isNewSession || wasNewSessionRef.current ? (cwdRef.current ?? null) : null}
        newSessionDraftKey={isNewSession || wasNewSessionRef.current ? draftKeyRef.current : null}
        pendingNewSessionTaskRef={isNewSession || wasNewSessionRef.current ? pendingTaskRef : undefined}
        chatInputRef={chatInputRef}
        inWorkbench
        onSessionStatsChange={handleSessionStatsChange}
        onContextUsageChange={handleContextUsageChange}
        onSessionStatsPanelOpen={handleSessionStatsPanelOpen}
        onTodosChange={handleTodosChange}
        onOpenFile={handleOpenFile}
        onSessionCreated={isNewSession ? (created) => handleSessionCreated(created) : undefined}
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
  // 展开卡容器不裁剪：卡片内元素（模型选择下拉等）超出卡片边界时保持可见，
  // 由卡片外层 visible + tldraw 画布边界（clip）兜底，避免超高面板顶部被裁。
  overflow: "visible",
  color: "var(--text)",
};

/** 从目标向上找可滚动容器（到 root 为止）：目标在可滚动容器内 → 滚轮属于它，不冒泡到画布。
 *  与 tldraw usePassThroughWheelEvents 同思路：内容溢出 + overflow 可滚动才算数。 */
function hasScrollableAncestor(target: Node, root: HTMLElement): boolean {
  let elm: Element | null = target instanceof Element ? target : target.parentElement;
  while (elm && elm instanceof HTMLElement) {
    if (elm === root) break;
    const overflowsY = elm.scrollHeight > elm.clientHeight;
    const overflowsX = elm.scrollWidth > elm.clientWidth;
    if (overflowsY || overflowsX) {
      const style = getComputedStyle(elm);
      const oy = style.overflowY;
      const ox = style.overflowX;
      if (
        (overflowsY && (oy === "auto" || oy === "scroll" || oy === "overlay")) ||
        (overflowsX && (ox === "auto" || ox === "scroll" || ox === "overlay"))
      ) {
        return true;
      }
    }
    elm = elm.parentElement;
  }
  return false;
}
