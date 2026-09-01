/** 看板工作台 ↔ AppShell 全局事件桥。
 *
 * 工作台（SessionWorkbench）内嵌完整 ChatWindow，但卡片在 tldraw 画布内，
 * 无法直接拿到 AppShell 的 handler/props。两类通道：
 * 1. 会话内部状态（统计/分支/系统提示）→ ChatWindow 回调直接捕获，卡片内渲染；
 * 2. 需要 AppShell 参与的动作（打开文件面板/刷新侧栏/浏览器通知）→ 事件桥，
 *    事件一律携带 sessionId，AppShell 处理时只做对应会话的动作，不退出看板。 */
/** 工作台内点击消息里的 file: 链接 → AppShell 打开右侧文件面板 */
export const BOARD_OPEN_FILE_EVENT = "pi-web:board-open-file";

/** 工作台内 fork 出新会话 → AppShell 刷新侧栏（不切换当前会话/退出看板） */
export const BOARD_SESSION_FORKED_EVENT = "pi-web:board-session-forked";

/** 看板内新建会话（draft 卡转正）→ AppShell 刷新侧栏 + 卡片侧把 sessionId 写回转正 */
export const BOARD_SESSION_CREATED_EVENT = "pi-web:board-session-created";

/** 看板内删除会话（画布删卡）→ AppShell 刷新侧栏（左侧树移除该会话） */
export const BOARD_SESSION_DELETED_EVENT = "pi-web:board-session-deleted";

/** 看板内会话改名 → AppShell 刷新侧栏（左侧树名称同步） */
export const BOARD_SESSION_RENAMED_EVENT = "pi-web:board-session-renamed";

/** 工作台内会话运行结束 → AppShell 刷新侧栏 + 浏览器通知 */
export const BOARD_AGENT_END_EVENT = "pi-web:board-agent-end";

/** 工作台内扩展发起阻塞请求 → AppShell 浏览器通知 */
export const BOARD_ATTENTION_NEEDED_EVENT = "pi-web:board-attention-needed";

/** 看板画布结构变化（清空/清理失效）→ BoardSection 刷新节点计数 */
export const BOARD_CANVAS_CHANGED_EVENT = "pi-web:board-canvas-changed";

/** 任务卡 API 操作 bump 了 boards.updated → useBoardCanvas 刷新乐观锁基线 */
export const BOARD_BASE_UPDATED_EVENT = "pi-web:board-base-updated";

declare global {
  interface WindowEventMap {
    "pi-web:board-open-file": CustomEvent<{ sessionId: string; filePath: string }>;
    "pi-web:board-session-forked": CustomEvent<{ sessionId: string; newSessionId: string }>;
    "pi-web:board-session-created": CustomEvent<{ sessionId: string; nodeId?: string }>;
    "pi-web:board-session-deleted": CustomEvent<{ sessionId: string }>;
    "pi-web:board-session-renamed": CustomEvent<{ sessionId: string; name?: string }>;
    "pi-web:board-agent-end": CustomEvent<{ sessionId: string; sessionName?: string }>;
    "pi-web:board-attention-needed": CustomEvent<{ sessionId: string; title?: string; method: string }>;
    "pi-web:board-canvas-changed": CustomEvent<{ boardId: string }>;
    "pi-web:board-base-updated": CustomEvent<{ boardId: string; updated: number }>;
  }
}

export function dispatchBoardOpenFile(sessionId: string, filePath: string): void {
  window.dispatchEvent(new CustomEvent(BOARD_OPEN_FILE_EVENT, { detail: { sessionId, filePath } }));
}

export function dispatchBoardSessionForked(sessionId: string, newSessionId: string): void {
  window.dispatchEvent(new CustomEvent(BOARD_SESSION_FORKED_EVENT, { detail: { sessionId, newSessionId } }));
}

export function dispatchBoardSessionCreated(sessionId: string, nodeId?: string): void {
  window.dispatchEvent(new CustomEvent(BOARD_SESSION_CREATED_EVENT, { detail: { sessionId, nodeId } }));
}

export function dispatchBoardSessionDeleted(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(BOARD_SESSION_DELETED_EVENT, { detail: { sessionId } }));
}

export function dispatchBoardSessionRenamed(sessionId: string, name?: string): void {
  window.dispatchEvent(new CustomEvent(BOARD_SESSION_RENAMED_EVENT, { detail: { sessionId, name } }));
}

export function dispatchBoardAgentEnd(sessionId: string, sessionName?: string): void {
  window.dispatchEvent(new CustomEvent(BOARD_AGENT_END_EVENT, { detail: { sessionId, sessionName } }));
}

export function dispatchBoardAttentionNeeded(sessionId: string, request: { title?: string; method: string }): void {
  window.dispatchEvent(new CustomEvent(BOARD_ATTENTION_NEEDED_EVENT, { detail: { sessionId, ...request } }));
}

export function dispatchBoardCanvasChanged(boardId: string): void {
  window.dispatchEvent(new CustomEvent(BOARD_CANVAS_CHANGED_EVENT, { detail: { boardId } }));
}

export function dispatchBoardBaseUpdated(boardId: string, updated: number): void {
  window.dispatchEvent(new CustomEvent(BOARD_BASE_UPDATED_EVENT, { detail: { boardId, updated } }));
}
