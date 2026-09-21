import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { shouldUseVisualViewportHeight } = await jiti.import("./useViewportHeight.ts");

/** 基线（键盘未弹起时的可视高度）。 */
const BASELINE = 844;

test("uses the visual viewport for a focused editor when the keyboard shrinks it", () => {
  assert.equal(shouldUseVisualViewportHeight({
    hasFocusedEditable: true,
    baselineHeight: BASELINE,
    viewportHeight: 510,
    viewportScale: 1,
  }), true);
});

// iOS 回归：键盘弹起时 innerHeight 与 visualViewport.height 一起缩。
// 旧判据 innerHeight - viewportHeight > 1 恒为 0，布局不缩、输入框被键盘盖住。
test("detects the keyboard even when the layout viewport shrinks with it (iOS)", () => {
  assert.equal(shouldUseVisualViewportHeight({
    hasFocusedEditable: true,
    baselineHeight: BASELINE,
    viewportHeight: 510,
    viewportScale: 1,
  }), true);
});

test("does not keep the keyboard height after the visual viewport restores", () => {
  assert.equal(shouldUseVisualViewportHeight({
    hasFocusedEditable: true,
    baselineHeight: BASELINE,
    viewportHeight: BASELINE,
    viewportScale: 1,
  }), false);
});

test("restores the full height as soon as the editor loses focus", () => {
  assert.equal(shouldUseVisualViewportHeight({
    hasFocusedEditable: false,
    baselineHeight: BASELINE,
    viewportHeight: 510,
    viewportScale: 1,
  }), false);
});

test("does not mistake pinch zoom for an open keyboard", () => {
  assert.equal(shouldUseVisualViewportHeight({
    hasFocusedEditable: true,
    baselineHeight: BASELINE,
    viewportHeight: 422,
    viewportScale: 2,
  }), false);
});

test("ignores address-bar-sized shrink below the keyboard threshold", () => {
  assert.equal(shouldUseVisualViewportHeight({
    hasFocusedEditable: true,
    baselineHeight: BASELINE,
    viewportHeight: BASELINE - 60,
    viewportScale: 1,
  }), false);
});

test("keeps the keyboard height while latched and the viewport has not recovered", () => {
  assert.equal(shouldUseVisualViewportHeight({
    hasFocusedEditable: true,
    baselineHeight: BASELINE,
    viewportHeight: BASELINE - 40,
    viewportScale: 1,
    keyboardLatched: true,
  }), true);
});

test("releases the latch once the viewport grows back", () => {
  assert.equal(shouldUseVisualViewportHeight({
    hasFocusedEditable: true,
    baselineHeight: BASELINE,
    viewportHeight: BASELINE - 4,
    viewportScale: 1,
    keyboardLatched: true,
  }), false);
});

// 兜底：判据失效（基线不可信）时，只要聚焦的输入框已落到可视区外，也按键盘态处理。
test("falls back to the focused element position when the baseline cannot tell", () => {
  assert.equal(shouldUseVisualViewportHeight({
    hasFocusedEditable: true,
    baselineHeight: 500,
    viewportHeight: 500,
    viewportScale: 1,
    focusedEditableBottom: 620,
  }), true);
});

test("does not fall back when the focused element is inside the visible area", () => {
  assert.equal(shouldUseVisualViewportHeight({
    hasFocusedEditable: true,
    baselineHeight: 500,
    viewportHeight: 500,
    viewportScale: 1,
    focusedEditableBottom: 480,
  }), false);
});
