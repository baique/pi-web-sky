"use client";

/**
 * 看板搜索高亮状态（React context，不写 tldraw store）。
 *
 * 设计（spec 2026-08-30-board-search 决策 #1）：高亮不落库、刷新即消失，
 * 由 shape 组件（SessionCardShape / StickyNoteShape）读本 context 渲染 accent 描边。
 *
 * - highlightId：当前高亮的 shapeId（null = 无高亮）
 * - highlightVersion：每次 setHighlight 递增——同 id 重选时靠它重播动画
 * - setHighlight(id)：定位时调用；自动在 1.8s 后清除（渐隐结束即消失）
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/** 高亮描边持续时长（与 CSS 动画 board-search-glow 时长一致） */
export const HIGHLIGHT_MS = 1800;

interface BoardSearchContextValue {
  highlightId: string | null;
  highlightVersion: number;
  setHighlight: (id: string | null) => void;
}

const BoardSearchContext = createContext<BoardSearchContextValue | null>(null);

export function BoardSearchProvider({ children }: { children: ReactNode }) {
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [highlightVersion, setHighlightVersion] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setHighlight = useCallback((id: string | null) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setHighlightId(id);
    setHighlightVersion((v) => v + 1);
    // 自动清除：高亮渐隐结束即消失（同 id 连续 Enter 会重启 timer，延续显示）
    if (id) {
      timerRef.current = setTimeout(() => {
        setHighlightId(null);
        setHighlightVersion((v) => v + 1);
      }, HIGHLIGHT_MS);
    }
  }, []);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return (
    <BoardSearchContext.Provider value={{ highlightId, highlightVersion, setHighlight }}>
      {children}
    </BoardSearchContext.Provider>
  );
}

/** 非看板场景（无 provider）返回安全默认：无高亮 + noop setHighlight。 */
export function useBoardSearch(): BoardSearchContextValue {
  const ctx = useContext(BoardSearchContext);
  if (!ctx) return { highlightId: null, highlightVersion: 0, setHighlight: () => {} };
  return ctx;
}
