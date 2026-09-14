"use client";

import type { CSSProperties, MouseEvent } from "react";

/**
 * 看板卡标题栏的改名铅笔（会话卡 / 便笺共用）。
 *
 * 存在的理由：标题「单击=改名」与双击展开、按住拖拽移卡压在同一个元素上，误触无法根治；
 * 改名改成显式入口（本按钮 + 右键菜单「重命名」+ F2），标题单击回归「选中卡」，拖拽面不受污染。
 *
 * - 只在标题栏 hover 或 `.is-visible`（卡已选中 / 正在改名）时出现，CSS 在 globals.css
 * - `nodrag`：按下不拖节点；吞掉双击（否则冒泡到卡根会触发展开/收起）
 * - 隐藏态 `visibility:hidden` —— 不吃指针、不进 tab 序、不偷走标题栏拖拽面
 */
export function RenameButton({ isVisible, onClick }: { isVisible: boolean; onClick: (e: MouseEvent) => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={(e) => e.stopPropagation()}
      className={`nodrag board-rename-btn${isVisible ? " is-visible" : ""}`}
      title="重命名 (F2)"
      style={RENAME_BTN_STYLE}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
    </button>
  );
}

const RENAME_BTN_STYLE: CSSProperties = {
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  padding: 0,
  border: "none",
  borderRadius: 5,
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
};
