"use client";

/**
 * 从 RF store 读节点当前位置（玻璃层定位用）。
 * 节点组件内不能用 useReactFlow().getNode（会重渲染循环），用 useStore 选择器 + 相等比较。
 */
import { useStore } from "@xyflow/react";
import type { XYPosition } from "@xyflow/react";

export function useNodePosition(id: string): XYPosition | null {
  return useStore(
    (s) => {
      const n = s.nodeLookup.get(id);
      return n ? { x: n.internals.positionAbsolute?.x ?? n.position.x, y: n.internals.positionAbsolute?.y ?? n.position.y } : null;
    },
    (a, b) => (a?.x === b?.x && a?.y === b?.y) || (a == null && b == null),
  );
}
