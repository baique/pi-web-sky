"use client";

import { useEffect } from "react";

/**
 * 动态毛玻璃降级：滚动 / 拖拽期间给 <html> 加 `glass-dynamic` class，
 * globals.css 借此把各 blur 档降到 2-3px（高斯成本 ∝ 半径²），静止显示
 * 效果 100% 恢复。
 *
 * 触发与放行：
 * - 拖拽（pointer 按下 + 位移 > DRAG_THRESHOLD_PX）：持续降级，直到
 *   pointerup 放行——不依赖"稳定超时"，拖拽中停顿不会闪烁。
 * - 滚动（wheel，滚轮 / 触摸板物理滚动）：降级，最后一次 wheel 后
 *   WHEEL_IDLE_MS 恢复（滚动没有抬起事件，只能靠停顿判定结束）。
 * - 程序化滚动（输入框聚焦 scrollIntoView、消息自动滚底）是 scroll 事件
 *   不是 wheel，不算用户交互，不会误触发。
 * - 位移阈值 8px 抑制点击抖动误判：正常点击（down+up 无大位移）不降级。
 */

const DRAG_THRESHOLD_PX = 8;
const WHEEL_IDLE_MS = 180;

export function useDynamicGlass() {
  useEffect(() => {
    const html = document.documentElement;
    let pressed = false;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let timer: number | undefined;

    const enter = () => html.classList.add("glass-dynamic");
    const exit = () => html.classList.remove("glass-dynamic");

    const onWheel = () => {
      enter();
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        // 拖拽期间不被滚动停顿超时打断
        if (!dragging) exit();
      }, WHEEL_IDLE_MS);
    };

    const onPointerDown = (e: PointerEvent) => {
      pressed = true;
      dragging = false;
      startX = e.clientX;
      startY = e.clientY;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pressed || dragging) return;
      if (
        Math.abs(e.clientX - startX) < DRAG_THRESHOLD_PX &&
        Math.abs(e.clientY - startY) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      dragging = true;
      if (timer) window.clearTimeout(timer);
      enter();
    };

    const onPointerUp = () => {
      if (dragging) {
        dragging = false;
        if (timer) window.clearTimeout(timer);
        exit();
      }
      pressed = false;
    };

    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);

    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      if (timer) window.clearTimeout(timer);
      html.classList.remove("glass-dynamic");
    };
  }, []);
}
