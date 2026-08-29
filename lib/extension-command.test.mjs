import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./extension-command.ts");
  } catch {
    return import("./extension-command.ts");
  }
}

const {
  nextInspectRequestId,
  subscribeInspectReplies,
  dispatchInspectReply,
} = await loadSubject();

test("requestId 唯一且符合 [A-Za-z0-9_-]{1,64}", () => {
  const a = nextInspectRequestId();
  const b = nextInspectRequestId();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{1,64}$/);
});

test("订阅-分发回包", () => {
  const received = [];
  const unsubscribe = subscribeInspectReplies((reply, requestId) => {
    received.push([reply, requestId]);
  });
  dispatchInspectReply({ kind: "pi-subagents.inspect-reply" }, "req-1");
  assert.equal(received.length, 1);
  assert.equal(received[0][1], "req-1");
  unsubscribe();
  dispatchInspectReply({}, "req-2");
  assert.equal(received.length, 1, "退订后不再收到");
});

test("单个监听器抛错不影响其他", () => {
  const received = [];
  subscribeInspectReplies(() => {
    throw new Error("boom");
  });
  subscribeInspectReplies((_, requestId) => received.push(requestId));
  dispatchInspectReply({}, "req-3");
  assert.deepEqual(received, ["req-3"]);
});
