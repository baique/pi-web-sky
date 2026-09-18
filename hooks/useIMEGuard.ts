"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  createIMECompositionState,
  isIMEBusy as isIMEBusyEvent,
  markCompositionEnd,
  markCompositionStart,
  type IMECompositionState,
} from "@/lib/ime-guard";

/** React 合成键盘事件里能取到的 IME 信号。 */
type KeyEventLike = { nativeEvent: { isComposing?: boolean; keyCode?: number } };

/** React 合成 combination 事件里能取到的最小结构（只需元素本身，用于失焦收尾）。 */
type CompositionEventLike = { target?: EventTarget | null };

export type IMEGuard = {
  /** 挂到输入控件上：`<input {...ime.compositionProps} />` */
  compositionProps: {
    onCompositionStart: (event: CompositionEventLike) => void;
    onCompositionEnd: () => void;
  };
  /** `onKeyDown` 第一行调用：true → 这次按键属于输入法（回车上屏 / Esc 取消候选），业务逻辑让开。 */
  isIMEBusy: (event: KeyEventLike) => boolean;
};

/**
 * 输入框的 IME 守卫。凡是用 Enter 提交、用 Escape 取消的输入框都要用：
 *
 * ```tsx
 * const ime = useIMEGuard();
 * <input
 *   {...ime.compositionProps}
 *   onKeyDown={(e) => {
 *     if (ime.isIMEBusy(e)) return;          // 输入法在上屏，别抢这个键
 *     if (e.key === "Enter") commit();
 *     if (e.key === "Escape") cancel();
 *   }}
 * />
 * ```
 *
 * 判定逻辑与宽限窗见 `lib/ime-guard.ts`。
 *
 * 失焦收尾：state 挂在父组件上，而输入框会随编辑态挂载/卸载（如标题编辑框）。
 * 万一 `compositionend` 没来（编辑中被打断、组合元素被移出焦点），残留的
 * composing=true 会让这个输入框的 Enter 永远提交不了、Escape 永远取消不了，
 * 直到父组件销毁。所以另记下正在组合的元素，它一失焦就收尾。
 * （元素被直接移除且不触发 blur 的情况仍无法覆盖，那是 composition 事件本身不可靠的范畴。）
 */
export function useIMEGuard(): IMEGuard {
  const stateRef = useRef<IMECompositionState>(createIMECompositionState());
  const composingElRef = useRef<EventTarget | null>(null);

  const onCompositionStart = useCallback((event: CompositionEventLike) => {
    composingElRef.current = event?.target ?? null;
    markCompositionStart(stateRef.current);
  }, []);
  const onCompositionEnd = useCallback(() => {
    composingElRef.current = null;
    markCompositionEnd(stateRef.current);
  }, []);
  const isIMEBusy = useCallback((event: KeyEventLike) => isIMEBusyEvent(stateRef.current, event?.nativeEvent), []);

  // blur 不冒泡，用捕获阶段监听：组合元素自己失焦就收尾。
  // 不能靠给输入框加 onBlur —— 多数站点自己就有 onBlur（提交/退出编辑），会被覆盖掉。
  useEffect(() => {
    const onBlurCapture = (event: Event) => {
      if (!composingElRef.current || event.target !== composingElRef.current) return;
      composingElRef.current = null;
      markCompositionEnd(stateRef.current);
    };
    document.addEventListener("blur", onBlurCapture, true);
    return () => document.removeEventListener("blur", onBlurCapture, true);
  }, []);

  return { compositionProps: { onCompositionStart, onCompositionEnd }, isIMEBusy };
}
