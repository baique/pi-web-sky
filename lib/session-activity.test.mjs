import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
  alias: { "@": process.cwd() },
});
const { createSessionActivityTracker, lastAssistantText } = await jiti.import("./session-activity.ts");

const assistant = (text, ts, stopReason = "stop") => ({
  role: "assistant",
  timestamp: ts,
  stopReason,
  content: [{ type: "text", text }],
});

/** 依次喂事件，返回所有非 null 效果（真实调用方的用法：一轮事件流按序处理）。 */
function run(events) {
  const tracker = createSessionActivityTracker();
  const effects = [];
  for (const event of events) {
    const effect = tracker.handle(event);
    if (effect) effects.push(effect);
  }
  return effects;
}

test("agent_start → touch（只刷活跃时间，浮动到列表顶部）", () => {
  assert.deepEqual(run([{ type: "agent_start" }]), [{ kind: "touch" }]);
});

test("单条 message_end 不落 outcome（不是循环最后一条）", () => {
  assert.deepEqual(run([{ type: "message_end", message: assistant("中间回复", 1000) }]), []);
});

test("agent_settled → outcome（带最后一条 assistant 文本与时间戳）", () => {
  const effects = run([
    { type: "message_end", message: assistant("第一条", 1000) },
    { type: "message_end", message: { role: "user", content: "再问" } },
    { type: "message_end", message: assistant("最后一条回复", 2000) },
    { type: "agent_settled" },
  ]);
  assert.deepEqual(effects, [{ kind: "outcome", lastReply: "最后一条回复", at: 2000 }]);
});

test("用户取消（stopReason=aborted）同样落 outcome", () => {
  const effects = run([
    { type: "message_end", message: assistant("被打断的半截回复", 3000, "aborted") },
    { type: "agent_settled" },
  ]);
  assert.deepEqual(effects, [{ kind: "outcome", lastReply: "被打断的半截回复", at: 3000 }]);
});

test("本轮没采到任何文本 → 只 touch（空文本不清库）", () => {
  // 刚发出就被取消 / 整轮只有工具调用：agent_settled 不得产出 lastReply:""，
  // 否则调用方会把已存的最后一条回复清空。
  assert.deepEqual(run([{ type: "agent_start" }, { type: "agent_settled" }]), [
    { kind: "touch" },
    { kind: "touch" },
  ]);
  assert.deepEqual(
    run([
      { type: "message_end", message: { role: "assistant", timestamp: 1, content: [{ type: "toolCall", name: "bash" }] } },
      { type: "message_end", message: { role: "assistant", timestamp: 2, content: [{ type: "thinking", thinking: "想一想" }] } },
      { type: "message_end", message: { role: "assistant", timestamp: 3, content: [{ type: "text", text: "   " }] } },
      { type: "agent_settled" },
    ]),
    [{ kind: "touch" }],
  );
});

test("settle 后 pending 归零：第二段 settle（无新消息）只 touch", () => {
  const tracker = createSessionActivityTracker();
  tracker.handle({ type: "message_end", message: assistant("回复", 1000) });
  assert.deepEqual(tracker.handle({ type: "agent_settled" }), {
    kind: "outcome",
    lastReply: "回复",
    at: 1000,
  });
  assert.deepEqual(tracker.handle({ type: "agent_settled" }), { kind: "touch" });
});

test("tracker 按实例持有状态：并发会话不串台", () => {
  const a = createSessionActivityTracker();
  const b = createSessionActivityTracker();
  a.handle({ type: "message_end", message: assistant("A 的回复", 1000) });
  b.handle({ type: "message_end", message: assistant("B 的回复", 2000) });
  assert.deepEqual(b.handle({ type: "agent_settled" }), {
    kind: "outcome",
    lastReply: "B 的回复",
    at: 2000,
  });
  assert.deepEqual(a.handle({ type: "agent_settled" }), {
    kind: "outcome",
    lastReply: "A 的回复",
    at: 1000,
  });
});

test("无关事件（tool_execution_end 等）不产生效果，也不破坏 pending", () => {
  const effects = run([
    { type: "message_end", message: assistant("回复", 1000) },
    { type: "tool_execution_start", toolName: "bash" },
    { type: "queue_update", steering: [] },
    { type: "agent_settled" },
  ]);
  assert.deepEqual(effects, [{ kind: "outcome", lastReply: "回复", at: 1000 }]);
});

test("lastAssistantText：只取 text 块，thinking/toolCall 忽略", () => {
  assert.equal(
    lastAssistantText({
      role: "assistant",
      content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "a" }, { type: "text", text: "b" }],
    }),
    "a\nb",
  );
  assert.equal(lastAssistantText({ role: "assistant", content: "plain" }), "plain");
  assert.equal(lastAssistantText({ role: "assistant" }), "");
  assert.equal(lastAssistantText({ role: "assistant", content: [{ type: "text", text: "  " }] }), "");
});
