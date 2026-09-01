"use client";

import { useEffect } from "react";

/**
 * 动态毛玻璃降级：滚动 / 拖拽期间给 <html> 加 `glass-dynamic` class，
 * globals.css 借此把各 blur 档位降到 2-3px（高斯模糊成本 ∝ 半径²，省 ~94%），
 * 并把 saturate 置 100% 省去 backdrop 去饱和运算。滚动停 120ms / 松手后移除，
 * 静止显示效果 100% 恢复。
 *
 * backdrop-filter 的真正代价在「背后像素每帧变化」的场景——消息列表滚动、
 * 看板卡片拖拽。静止的 fixed 玻璃（侧栏 / 顶栏 / 面板）被浏览器缓存，不在
 * 此列，无需处理。
 */

const IDLE_AFTER_MS = 120;
const DRAG_THRESHOLD_PX = 3;

export function useDynamicGlass() {
  useEffect(() => {
    const html = document.documentElement;
    let timer: number | undefined;
    let pressed = false;
    let dragging = false;
    let startX = 0;
    let startY = 0;

    const activate = () => {
      html.classList.add("glass-dynamic");
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        html.classList.remove("glass-dynamic");
      }, IDLE_AFTER_MS);
    };

    // scroll 不冒泡，但 capture 阶段在 window 上能收到所有内部容器的滚动。
    const onScroll = () => activate();

    const onPointerDown = (e: PointerEvent) => {
      pressed = true;
      dragging = false;
      startX = e.clientX;
      startY = e.clientY;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pressed) return;
      if (!dragging) {
        // 位移超过阈值才判定为拖拽；点击按钮（无位移）不降级。
        if (
          Math.abs(e.clientX - startX) < DRAG_THRESHOLD_PX &&
          Math.abs(e.clientY - startY) < DRAG_THRESHOLD_PX
        ) {
          return;
        }
        dragging = true;
      }
      activate();
    };

    const onPointerEnd = () => {
      pressed = false;
      dragging = false;
      activate(); // 松手后经 IDLE_AFTER_MS 恢复，避免边界闪烁
    };

    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerEnd, true);
    window.addEventListener("pointercancel", onPointerEnd, true);

    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerEnd, true);
      window.removeEventListener("pointercancel", onPointerEnd, true);
      if (timer) window.clearTimeout(timer);
      html.classList.remove("glass-dynamic");
    };
  }, []);
}
