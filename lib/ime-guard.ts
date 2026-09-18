/**
 * 输入法（IME）组合态判定。
 *
 * Enter / Escape / 方向键等业务快捷键在处理前必须先过 `isIMEBusy()`，
 * 否则中文/日文/韩文输入法「回车确认候选」「Esc 取消候选」会被当成业务提交或业务取消。
 *
 * 四个信号缺一不可（靠前的先短路）：
 *  1. `composing` —— 由 compositionstart / compositionend 自己维护，最可靠；
 *  2. `event.isComposing` —— 标准属性；
 *  3. `event.keyCode === 229` —— 老 WebKit 与部分输入法不上报 isComposing；
 *  4. `endedAt` 宽限窗 —— Safari（以及部分搜狗场景）先发 compositionend 再发 keydown，
 *     那次 keydown 的 isComposing 已经是 false，只看属性必然误判成「用户主动按了 Enter」。
 */

/** compositionend 之后仍把按键让给输入法的宽限窗口（ms）。 */
export const IME_GRACE_MS = 100;

export type IMECompositionState = {
  /** 是否处于组合中（compositionstart 之后、compositionend 之前） */
  composing: boolean;
  /** 最近一次 compositionend 的时间戳；0 = 从未组合过 */
  endedAt: number;
};

export function createIMECompositionState(): IMECompositionState {
  return { composing: false, endedAt: 0 };
}

export function markCompositionStart(state: IMECompositionState): void {
  state.composing = true;
}

export function markCompositionEnd(state: IMECompositionState, now: number = Date.now()): void {
  state.composing = false;
  state.endedAt = now;
}

/** keydown 上取得到的 IME 信号（KeyboardEvent 的结构子集，方便测试）。 */
export type IMEKeyEvent = {
  isComposing?: boolean;
  keyCode?: number;
};

/** 这次按键是否属于输入法：true → 业务逻辑让开，交给输入法上屏/取消候选。 */
export function isIMEBusy(
  state: IMECompositionState,
  event: IMEKeyEvent | null | undefined,
  now: number = Date.now(),
): boolean {
  if (state.composing) return true;
  if (event?.isComposing === true) return true;
  if (event?.keyCode === 229) return true;
  return now - state.endedAt < IME_GRACE_MS;
}
