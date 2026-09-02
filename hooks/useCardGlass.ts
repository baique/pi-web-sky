"use client";

import { useEffect, useRef } from "react";
import { useReactFlow, type Node, type XYPosition } from "@xyflow/react";

/**
 * 卡片玻璃（局部贴图版）：每张卡片内嵌一个「视口对齐的模糊壁纸层」。
 *
 * React Flow 版：节点在 viewport（translate+scale）内，与 tldraw 同构。
 * - node 的 flow 坐标 → 屏幕位置：flowToScreenPosition(node.position)
 * - 卡片内部层（在 node 内，flow 坐标）要图对齐屏幕原点：
 *   dx = -screenPos / zoom（node 内 flow 偏移经 zoom 放大 = 屏幕偏移）
 * - 层尺寸 = 视口 / zoom（经 zoom 放大后 = 视口）
 *
 * 同步时机：RF 的 onMove / 节点位置变化 → rAF 合并每帧一次。
 * 用 useReactFlow 的 flowToScreenPosition 算，不读 DOM rect（避免强制 reflow）。
 */

/**
 * 生成内嵌模糊壁纸层。返回回调 ref（挂到卡片内容容器）。
 * bgToken：卡片玻璃底色（--board-card-glass / --assistant-card-glass 等）。
 */
export function useCardGlass(bgToken: string, deps: unknown[] = []) {
  const { flowToScreenPosition, getZoom } = useReactFlow();
  const layerRef = useRef<HTMLDivElement | null>(null);
  const nodePosRef = useRef<XYPosition>({ x: 0, y: 0 });
  // 节点位置由宿主组件通过 setNodePosition 传入（避免 useReactFlow 实例在节点内循环）
  const nodeRef = useRef<Node | null>(null);

  const syncLayer = () => {
    const layer = layerRef.current;
    if (!layer) return;
    const zoom = getZoom();
    const pos = flowToScreenPosition(nodePosRef.current);
    layer.style.width = `${window.innerWidth / zoom}px`;
    layer.style.height = `${window.innerHeight / zoom}px`;
    layer.style.transform = `translate(${-pos.x / zoom}px, ${-pos.y / zoom}px)`;
  };

  /** 宿主在节点 render 时传入当前节点（含 position），更新引用并同步 */
  const setNode = (node: Node | null) => {
    nodeRef.current = node;
    if (node) nodePosRef.current = node.position;
    syncLayer();
  };

  /** 回调 ref：挂到卡片内容容器，创建/复用模糊壁纸层 */
  const setContainer = (node: HTMLDivElement | null) => {
    if (!node) return;
    const existing = node.querySelector<HTMLDivElement>("[data-glass-layer]");
    if (existing) {
      layerRef.current = existing;
      syncLayer();
      return;
    }
    const layer = document.createElement("div");
    layer.dataset.glassLayer = "1";
    layer.style.cssText =
      `position:absolute;left:0;top:0;pointer-events:none;z-index:-1;` +
      // 合成层提升：每帧改 transform 只走合成，不触发重排/重绘
      `will-change:transform;` +
      `background-image:linear-gradient(${bgToken}, ${bgToken}), var(--glass-bg-image, none);` +
      `background-repeat:no-repeat,no-repeat;` +
      `background-size:100% 100%,100% 100%;`;
    node.prepend(layer);
    layerRef.current = layer;
    syncLayer();
  };

  // 滚动/移动时同步（画布 pan/zoom）
  useEffect(() => {
    let raf = 0;
    const onMove = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        syncLayer();
      });
    };
    // 监听全局移动：画布 pan/zoom 变化时同步所有卡片玻璃层
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    // 画布 zoom/pan 由 RF 控制，这里用 interval 轻量兜底 + rAF
    const iv = setInterval(() => {
      // 只在新位置变化时同步（性能）
      const layer = layerRef.current;
      if (layer) syncLayer();
    }, 250);
    onMove();
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      clearInterval(iv);
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { setContainer, setNode };
}
