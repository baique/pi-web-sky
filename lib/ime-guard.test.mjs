import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./ime-guard.ts");
}

test("plain key events are not IME-busy", async () => {
  const { createIMECompositionState, isIMEBusy } = await loadSubject();
  const state = createIMECompositionState();

  assert.equal(isIMEBusy(state, { isComposing: false, keyCode: 13 }), false);
  assert.equal(isIMEBusy(state, {}), false);
  assert.equal(isIMEBusy(state, null), false);
});

test("composition session marks every keydown as IME-busy", async () => {
  const { createIMECompositionState, markCompositionStart, markCompositionEnd, isIMEBusy } = await loadSubject();
  const state = createIMECompositionState();

  markCompositionStart(state);
  assert.equal(state.composing, true);
  // 组合期间即使事件没带信号（老输入法）也要让开
  assert.equal(isIMEBusy(state, { isComposing: false, keyCode: 13 }), true);

  markCompositionEnd(state, 1_000);
  assert.equal(state.composing, false);
});

test("isComposing and keyCode 229 are both honoured outside a tracked session", async () => {
  const { createIMECompositionState, isIMEBusy } = await loadSubject();
  const state = createIMECompositionState();

  assert.equal(isIMEBusy(state, { isComposing: true, keyCode: 13 }), true);
  assert.equal(isIMEBusy(state, { keyCode: 229 }), true);
});

test("keys right after compositionend are IME-busy (Safari / Sogou ordering)", async () => {
  const { createIMECompositionState, markCompositionStart, markCompositionEnd, isIMEBusy, IME_GRACE_MS } = await loadSubject();
  const state = createIMECompositionState();

  markCompositionStart(state);
  // Safari 反序：compositionend 先到，随后那次 keydown 的 isComposing 已是 false
  markCompositionEnd(state, 5_000);

  assert.equal(isIMEBusy(state, { isComposing: false, keyCode: 13 }, 5_000), true);
  assert.equal(isIMEBusy(state, { isComposing: false, keyCode: 13 }, 5_000 + IME_GRACE_MS - 1), true);

  // 宽限窗外恢复正常
  assert.equal(isIMEBusy(state, { isComposing: false, keyCode: 13 }, 5_000 + IME_GRACE_MS), false);
  assert.equal(isIMEBusy(state, { isComposing: false, keyCode: 13 }, 5_000 + IME_GRACE_MS + 1), false);
});
