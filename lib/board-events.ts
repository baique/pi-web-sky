/** 看板工作台内触发 AppShell 全局底部终端开关（工作台嵌卡片内，无法直接拿到 AppShell 的
 *  terminalOpen/onToggleTerminal，用全局事件桥接——与 session-row-context-menu 同模式）。 */
export const BOARD_TERMINAL_TOGGLE_EVENT = "pi-web:board-terminal-toggle";

declare global {
  interface WindowEventMap {
    "pi-web:board-terminal-toggle": CustomEvent<{ origin: "top" | "bottombar" }>;
  }
}

export function dispatchBoardTerminalToggle(origin: "top" | "bottombar" = "bottombar"): void {
  window.dispatchEvent(new CustomEvent(BOARD_TERMINAL_TOGGLE_EVENT, { detail: { origin } }));
}
