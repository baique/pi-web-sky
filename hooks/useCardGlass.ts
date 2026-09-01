"use client";

import { useEffect, useRef } from "react";
import { Mat, type Editor, type TLShapeId } from "tldraw";

/**
 * 卡片玻璃（局部贴图版）：每张卡片内嵌一个「视口对齐的模糊壁纸层」。
 *
 * 为什么不用 background-position / background-attachment: fixed：
 * tldraw 画布有 camera transform（.tl-shape 页坐标 transform + 外层 .tl-shapes
 * camera transform），Chrome 在这类容器里会忽略 background-position、把 fixed
 * 背景退化渲染成整张拉伸（已实测）。所以改为 DOM 层 + 手动 transform 定位：
 *
 * 数学推导（关键，勿改）：
 * - 卡片屏幕位置 pos = editor.pageToScreen(shape.x, shape.y)（含 camera）
 * - 卡片内部层在 .tl-shape（页坐标 transform）内，自身页偏移 dx 经 camera
 *   显示为 dx × zoom 的屏幕偏移
 * - 要让层的图原点对齐屏幕原点：dx × zoom = -pos → dx = -pos / zoom
 * - 图要显示成视口大小：页尺寸 = 视口 / zoom（经 zoom 放大后 = 视口）
 *
 * 同步时机：tldraw change 事件（拖拽/平移/缩放）→ rAF 合并每帧一次。
 * 用 pageToScreen（tldraw 数据）算，不读 DOM rect（避免强制 reflow）。
 */
export function useCardGlass(editor: Editor | null | undefined, shapeId: TLShapeId, bgToken: string) {
  const layerRef = useRef<HTMLDivElement | null>(null);

  // 同步层到视口对齐（核心数学，见文件头注释）
  const syncLayer = () => {
    const layer = layerRef.current;
    if (!layer) return;
    const shape = editor?.getShape(shapeId);
    if (!shape || !editor) return;
    const zoom = editor.getZoomLevel();
    // 用页变换（pageTransform）取 shape 的真实页位置：组合后 shape.x/y 是
    // 相对 group 的坐标，但 .tl-shape 的 transform 是含 group 偏移的页变换，
    // 两者基准不同 → 层会错位（组合后透明的根因）。
    const pageTransform = editor.getShapePageTransform(shapeId);
    if (!pageTransform) return;
    // Mat.Point 取变换的平移分量（shape 真实页位置，含 group 偏移）
    const pagePos = Mat.Point(pageTransform);
    const pos = editor.pageToScreen({ x: pagePos.x, y: pagePos.y });
    // 层图是视口快照（useGlassWallpaper 按视口绘制），层图原点必须对齐
    // 屏幕原点 (0,0)：层 transform = -pos/zoom。pos 用 pageTransform（含
    // group 偏移）→ 组合后不透明错位；组合前 pagePos=shape.x 与原行为一致。
    layer.style.width = `${window.innerWidth / zoom}px`;
    layer.style.height = `${window.innerHeight / zoom}px`;
    layer.style.transform = `translate(${-pos.x / zoom}px, ${-pos.y / zoom}px)`;
  };

  // 回调 ref：挂到卡片内容容器，创建模糊壁纸层。
  // 不用一次性标记（dataset.glassReady）守卫：tldraw 组合/取消组合会重建
  // shape 容器 DOM——节点可能被复用但 prepend 的层已被清掉，标记守卫会
  // 跳过重建 → 卡片透明。改为检查层是否真的还在 DOM 里。
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
      // 图按层尺寸铺满（层 = 视口/zoom），否则降采样图 auto 只显示 1/4
      `background-size:100% 100%,100% 100%;`;
    node.prepend(layer);
    layerRef.current = layer;
    // 立即同步：层重建后不等下一次 change（组合可能不触发后续 change）
    syncLayer();
  };

  useEffect(() => {
    if (!editor) return;
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        syncLayer();
      });
    };
    const onChange = () => schedule();
    schedule();
    editor.on("change", onChange);
    return () => {
      editor.off("change", onChange);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [editor, shapeId]);

  return setContainer;
}
