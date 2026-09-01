"use client";

import { useEffect, useRef } from "react";
import type { Editor, TLShapeId } from "tldraw";

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

  // 回调 ref：挂到卡片内容容器，创建模糊壁纸层（只创建一次）
  const setContainer = (node: HTMLDivElement | null) => {
    if (!node || node.dataset.glassReady) return;
    node.dataset.glassReady = "1";
    const layer = document.createElement("div");
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
  };

  useEffect(() => {
    if (!editor) return;
    let raf = 0;
    const sync = () => {
      const layer = layerRef.current;
      if (!layer) return;
      const shape = editor.getShape(shapeId);
      if (!shape) return;
      const zoom = editor.getZoomLevel();
      const pos = editor.pageToScreen({ x: shape.x as number, y: shape.y as number });
      // 页坐标偏移 = -屏幕位置 / zoom；图页尺寸 = 视口 / zoom
      layer.style.width = `${window.innerWidth / zoom}px`;
      layer.style.height = `${window.innerHeight / zoom}px`;
      layer.style.transform = `translate(${-pos.x / zoom}px, ${-pos.y / zoom}px)`;
    };
    // rAF 合并：拖拽/平移高频触发 change 时每帧最多同步一次（跟手），
    // rAF 本身就是帧率上限，不会超过显示刷新率。
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        sync();
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
