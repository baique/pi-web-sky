"use client";

/**
 * 看板上下文（SessionCanvas 提供）：boardId + 左侧栏当前选中目录。
 * 独立文件：TaskCardNode / 其他 RF 节点读取，避免 import 旧 tldraw shape 组件。
 */
import { createContext, useContext } from "react";

export const BoardIdContext = createContext<{ boardId: string | null; defaultCwd: string | null } | null>(null);

export function useBoardId(): string | null {
  return useContext(BoardIdContext)?.boardId ?? null;
}

/** 左侧栏当前选中目录（newSessionCwd），任务卡建卡时 cwd 默认值。 */
export function useBoardDefaultCwd(): string | null {
  return useContext(BoardIdContext)?.defaultCwd ?? null;
}
