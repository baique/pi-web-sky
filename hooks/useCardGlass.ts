"use client";

import { useCallback, useEffect, useRef } from "react";
import { useNodeId, useReactFlow, useStoreApi, type XYPosition } from "@xyflow/react";

/**
 * 卡片玻璃（局部贴图版）：每张卡片内嵌一个「视口对齐的模糊壁纸层」。
 *
 * React Flow 版：节点在 viewport（translate+scale）内，与 tldraw 同构。
 * - node 的 flow 坐标 → 屏幕位置：由 RF store 的 nodeLookup 提供
 *   （node.internals.positionAbsolute / node.position + viewport transform）
 * - 卡片内部层（在 node 内，flow 坐标）要图对齐屏幕原点：
 *   dx = -screenPos / zoom（node 内 flow 偏移经 zoom 放大 = 屏幕偏移）
 * - 层尺寸 = 视口 / zoom（经 zoom 放大后 = 视口）
 *
 * 性能关键（勿退回 React 订阅）：
 * 节点拖动/画布 pan/zoom 时，位置每帧变。若用 useStore（React 订阅）会让
 * 整张卡组件每帧重渲染——展开态会话卡含整个工作台，卡顿严重。
 * 这里用 vanilla store.subscribe（不触发 React 渲染）+ rAF 合并，
 * 直接改层 transform（合成层位移），拖动期间零 React 重渲染。
 *
 * 屏幕位置计算：用 RF 标准 flowToScreenPosition（勿手算 viewport——曾因手算
 * transform 导致壁纸错位）。node 位置从 store 的 nodeLookup 实时取，
 * 不经 React state，避免整卡重渲染。
 */

export function useCardGlass(bgToken: string, deps: unknown[] = []) {
  const nodeId = useNodeId();
  const { flowToScreenPosition } = useReactFlow();
  const storeApi = useStoreApi();
  const layerRef = useRef<HTMLDivElement | null>(null);
  // 上次写入的几何（避免值未变时空写 DOM）
  const lastGeom = useRef<string>("");

  /** 同步层到视口对齐（核心数学，见文件头注释） */
  const syncLayer = useCallback(() => {
    const layer = layerRef.current;
    if (!layer || !nodeId) return;
    const s = storeApi.getState();
    const node = s.nodeLookup.get(nodeId);
    if (!node) return;
    const zoom = s.transform[2];
    // 屏幕位置：RF 标准换算（含容器偏移），勿手算
    const pos = flowToScreenPosition({ x: node.position.x, y: node.position.y });
    const w = window.innerWidth / zoom;
    const h = window.innerHeight / zoom;
    const key = `${pos.x.toFixed(1)}|${pos.y.toFixed(1)}|${zoom.toFixed(3)}|${w}|${h}`;
    if (key === lastGeom.current) return;
    lastGeom.current = key;
    layer.style.width = `${w}px`;
    layer.style.height = `${h}px`;
    layer.style.transform = `translate(${-pos.x / zoom}px, ${-pos.y / zoom}px)`;
  }, [nodeId, storeApi, flowToScreenPosition]);

  /** 回调 ref：挂到卡片内容容器，创建/复用模糊壁纸层 */
  const setContainer = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    // 复用已挂载的裁剪壳（内含玻璃层）
    const existing = node.querySelector<HTMLDivElement>("[data-glass-clip]");
    if (existing) {
      layerRef.current = existing.querySelector<HTMLDivElement>("[data-glass-layer]");
      syncLayer();
      return;
    }
    // 裁剪壳：只裁玻璃层（圆角 + overflow hidden），不裁内容。
    // 必须独立于内容容器——内容容器 overflow 可能为 visible（会话卡展开态工作台），
    // 玻璃层尺寸=全视口，若直接挂内容根且根 overflow:visible 会溢出盖满全屏。
    const clip = document.createElement("div");
    clip.dataset.glassClip = "1";
    clip.style.cssText =
      `position:absolute;left:0;top:0;width:100%;height:100%;` +
      `border-radius:inherit;overflow:hidden;pointer-events:none;z-index:-1;`;
    const layer = document.createElement("div");
    layer.dataset.glassLayer = "1";
    layer.style.cssText =
      `position:absolute;left:0;top:0;pointer-events:none;` +
      // 合成层提升：每帧改 transform 只走合成，不触发重排/重绘
      `will-change:transform;` +
      // 卡片背景 = 气泡档真实值 + 画布 scrim 值叠加（--glass-bg-image-card），
      // 气泡与磨砂滑块都影响它；未生成（无壁纸/首帧）时回退气泡档再回退纯色。
      `background-image:linear-gradient(${bgToken}, ${bgToken}), var(--glass-bg-image-card, var(--glass-bg-image, none));` +
      `background-repeat:no-repeat,no-repeat;` +
      `background-size:100% 100%,100% 100%;`;
    clip.appendChild(layer);
    node.prepend(clip);
    layerRef.current = layer;
    syncLayer();
  }, [syncLayer]);

  // 节点拖动 + 画布 pan/zoom 都同步：vanilla store.subscribe（不触发 React 渲染）
  // + rAF 合并每帧一次。拖拽期间整卡组件零重渲染，只有层的 transform 在动。
  useEffect(() => {
    if (!nodeId) return;
    let raf = 0;
    // 记录上次 store 快照：subscribe 对每次 store 变化都回调（含 yjs 回灌等与本卡
    // 无关的变化），若无条件 schedule 会驱动 rAF 60fps 空转 + 合成器持续唤醒
    // （松手后 GPU 高位残留的元凶）。这里只在本节点位置或 viewport transform
    // 真正变化时才调度。
    let lastT = "";
    const scheduleIfChanged = () => {
      const s = storeApi.getState();
      const node = s.nodeLookup.get(nodeId);
      if (!node) return;
      const zoom = s.transform[2];
      const t = `${node.position.x.toFixed(2)}|${node.position.y.toFixed(2)}|${s.transform[0].toFixed(1)}|${s.transform[1].toFixed(1)}|${zoom.toFixed(4)}`;
      if (t === lastT) return;
      lastT = t;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        syncLayer();
      });
    };
    // 监听所有变化，回调内廉价判断（读 store 快照比对），只有本节点位置或 viewport 变了才调度 rAF
    const unsub = storeApi.subscribe(scheduleIfChanged);
    scheduleIfChanged();
    return () => {
      unsub();
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { setContainer };
}

export type { XYPosition };
