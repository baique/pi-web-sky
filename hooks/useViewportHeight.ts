"use client";

import { useEffect } from "react";

/**
 * 键盘至少占掉的可视高度。低于此值当作地址栏伸缩之类的噪声，不动布局。
 * iPhone 上最小的中文键盘也占 200px 以上，留够余量。
 */
const KEYBOARD_MIN_INSET = 150;
/** 视口已基本长回基线（差值 ≤ 此值）才算键盘收起。 */
const KEYBOARD_RELEASE_INSET = 20;

export interface ViewportHeightState {
  hasFocusedEditable: boolean;
  /** 可视高度的高水位线（本次会话见过的最大值，换向时重取）。 */
  baselineHeight: number;
  viewportHeight: number;
  viewportScale: number;
  /** 当前聚焦输入元素的底边（视口坐标）；没有则传 null。 */
  focusedEditableBottom?: number | null;
  /** 上一帧是否已判定为键盘态（锁存，防抖）。 */
  keyboardLatched?: boolean;
}

export function shouldUseVisualViewportHeight({
  hasFocusedEditable,
  baselineHeight,
  viewportHeight,
  viewportScale,
  focusedEditableBottom,
  keyboardLatched,
}: ViewportHeightState): boolean {
  // 捏合缩放时 visualViewport 描述的是「放大后的可视块」，不是布局高度，不干预。
  if (Math.abs(viewportScale - 1) >= 0.01) return false;
  // 失焦立即恢复：iOS 独立窗口会留下一个缩过头的视口，靠基线高度把布局拉回去。
  if (!hasFocusedEditable) return false;

  const inset = baselineHeight - viewportHeight;
  // 键盘确实占了位。
  // 不能用 innerHeight - visualViewport.height：iOS 上键盘弹起时两者一起缩，
  // 差值恒为 0，判据永远不成立（「innerHeight 不变、可视区缩」是 Android 的行为）。
  if (inset > KEYBOARD_MIN_INSET) return true;
  // 已判定过键盘态：视口没长回来之前保持，避免只剩兜底判据时来回抖。
  if (keyboardLatched && inset > KEYBOARD_RELEASE_INSET) return true;
  // 兜底：输入框确实被压到可视区以下。
  return typeof focusedEditableBottom === "number" && focusedEditableBottom > viewportHeight + 1;
}

function focusedEditableElement(): HTMLElement | null {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return null;
  const tag = activeElement.tagName;
  return activeElement.isContentEditable || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA"
    ? activeElement
    : null;
}

/**
 * 让应用高度跟随可视视口（软件键盘）。
 *
 * - 不用 `100dvh`：键盘不改变布局视口，dvh 在键盘弹起时纹丝不动，底部输入区整块落在键盘下面
 *   （iOS 上 `interactive-widget=resizes-content` 也不生效）。
 * - 也不用 `innerHeight - visualViewport.height`：iOS 上键盘弹起时两者一起缩，差值恒为 0，
 *   判据永远不成立 —— 这正是「输入框被输入法遮住、要滚一下才看得见」的根因。
 *   改成记「可视高度高水位线」：比基线矮一大截就是键盘态，布局高度取 `visualViewport.height`；
 *   其余时候取基线 —— 顺带修掉 iOS 独立窗口「键盘收起后 innerHeight/dvh 缩水不回弹」留下的底部死带。
 */
export function useViewportHeight(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const root = document.documentElement;
    let frameId: number | null = null;
    let baseline = viewport.height;
    let latched = false;
    let lastWidth = window.innerWidth;

    const update = () => {
      frameId = null;

      // 换向 / 宽度变化：竖屏记下的高水位线在横屏是错的，重取基线。
      if (window.innerWidth !== lastWidth) {
        lastWidth = window.innerWidth;
        baseline = viewport.height;
        latched = false;
      } else if (viewport.height > baseline) {
        baseline = viewport.height;
      }

      const editable = focusedEditableElement();
      const keyboardOpen = shouldUseVisualViewportHeight({
        hasFocusedEditable: Boolean(editable),
        baselineHeight: baseline,
        viewportHeight: viewport.height,
        viewportScale: viewport.scale,
        focusedEditableBottom: editable ? editable.getBoundingClientRect().bottom : null,
        keyboardLatched: latched,
      });
      latched = keyboardOpen;

      root.style.setProperty("--app-viewport-height", `${keyboardOpen ? viewport.height : baseline}px`);
      if (keyboardOpen) root.dataset.keyboard = "true";
      else delete root.dataset.keyboard;

      const pageWasShifted = window.scrollX !== 0 || window.scrollY !== 0;
      const isUnscaled = Math.abs(viewport.scale - 1) < 0.01;
      if (pageWasShifted && isUnscaled) {
        window.scrollTo(0, 0);
      }
    };

    // WebKit can dispatch the resize event before visualViewport.height has
    // settled, especially when an installed PWA dismisses the keyboard. Reading
    // it on the next animation frame prevents the keyboard-height CSS value
    // from remaining after the keyboard has closed.
    const scheduleUpdate = () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(update);
    };

    scheduleUpdate();
    viewport.addEventListener("resize", scheduleUpdate);
    viewport.addEventListener("scroll", scheduleUpdate);
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("focusin", scheduleUpdate);
    window.addEventListener("focusout", scheduleUpdate);
    window.addEventListener("pageshow", scheduleUpdate);

    return () => {
      viewport.removeEventListener("resize", scheduleUpdate);
      viewport.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("focusin", scheduleUpdate);
      window.removeEventListener("focusout", scheduleUpdate);
      window.removeEventListener("pageshow", scheduleUpdate);
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      root.style.removeProperty("--app-viewport-height");
      delete root.dataset.keyboard;
    };
  }, []);
}
