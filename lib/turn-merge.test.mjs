import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildDomTurns, mergeTurns, getUserPreview } = await jiti.import("./turn-merge.ts");

function user(content) {
  return { role: "user", content };
}
function assistant(text) {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    content: [{ type: "text", text }],
  };
}
function assistantWithToolCall(text) {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    content: [
      { type: "thinking", thinking: "deep", signature: "" },
      { type: "toolCall", id: "c1", name: "bash", arguments: "{}" },
      { type: "text", text },
    ],
  };
}
function toolResult() {
  return { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "tool output" }] };
}

test("buildDomTurns: msgIdx（全消息下标）与 refIdx（user/assistant 计数）分离", () => {
  // 真实会话形状：turn 中间夹大量 toolResult / 多段 assistant
  const messages = [
    user("q1"),
    assistantWithToolCall("a1"),
    toolResult(),
    assistant("a2"),
    user("q2"),
    assistantWithToolCall("a3"),
    toolResult(),
    toolResult(),
    assistant("a4"),
    user("q3"),
    assistant("a5"),
  ];
  const entryIds = ["u1", "a1", "t1", "a2", "u2", "a3", "t2", "t3", "a4", "u3", "a5"];

  const doms = buildDomTurns(messages, entryIds);
  assert.equal(doms.length, 3);

  // turn 0：user 在 allMessages[0]，refs[0]
  assert.equal(doms[0].entryId, "u1");
  assert.equal(doms[0].msgIdx, 0);
  assert.equal(doms[0].refIdx, 0);
  assert.deepEqual(
    doms[0].assistantList.map((a) => [a.markdown, a.msgIdx, a.refIdx]),
    [["a1", 1, 1], ["a2", 3, 2]],
  );

  // turn 1：user 在 allMessages[4]（前面有 4 条消息），但 refs 只数过 3 个 user/assistant
  assert.equal(doms[1].entryId, "u2");
  assert.equal(doms[1].msgIdx, 4);
  assert.equal(doms[1].refIdx, 3);
  assert.deepEqual(
    doms[1].assistantList.map((a) => [a.markdown, a.msgIdx, a.refIdx]),
    [["a3", 5, 4], ["a4", 8, 5]],
  );

  // turn 2：msgIdx 9 / refIdx 6
  assert.equal(doms[2].entryId, "u3");
  assert.equal(doms[2].msgIdx, 9);
  assert.equal(doms[2].refIdx, 6);
  assert.deepEqual(
    doms[2].assistantList.map((a) => [a.markdown, a.msgIdx, a.refIdx]),
    [["a5", 10, 7]],
  );
});

test("buildDomTurns: 流式 assistant 并入最后回合，不产生新 turn", () => {
  const messages = [
    user("q1"),
    assistant("a1"),
    { role: "assistant", content: [{ type: "text", text: "streaming…" }], isStreaming: true },
  ];
  const entryIds = ["u1", "a1", ""];
  const doms = buildDomTurns(messages, entryIds);
  assert.equal(doms.length, 1);
  assert.equal(doms[0].entryId, "u1");
  assert.deepEqual(doms[0].assistantList.map((a) => a.markdown), ["a1", "streaming…"]);
});

test("getUserPreview: 纯附件消息给占位文案", () => {
  assert.equal(getUserPreview({ role: "user", content: [{ type: "image", data: "AAAA" }] }), "[attachment]");
  assert.equal(getUserPreview({ role: "user", content: "  hi  " }), "hi");
});

test("mergeTurns: 索引未覆盖的尾部新回合按序追加（新消息上导航条）", () => {
  const turnIndex = [
    { entryId: "u1", userText: "q1", assistantPreview: "a1" },
    { entryId: "u2", userText: "q2", assistantPreview: "a2" },
    { entryId: "u3", userText: "q3", assistantPreview: "a3" },
  ];
  // 已加载窗口 = u2, u3（索引内）+ u4（新消息，索引外）
  const messages = [user("q2"), assistant("a2"), user("q3"), assistant("a3"), user("q4"), assistant("a4")];
  const entryIds = ["u2", "a2", "u3", "a3", "u4", "a4"];
  const doms = buildDomTurns(messages, entryIds);

  const merged = mergeTurns(turnIndex, doms);
  assert.equal(merged.length, 4);
  assert.deepEqual(
    merged.map((t) => [t.entryId, t.loaded, t.userText]),
    [
      ["u1", false, "q1"],   // 窗口外：索引摘要
      ["u2", true, "q2"],    // 已加载：窗口数据
      ["u3", true, "q3"],
      ["u4", true, "q4"],    // 追加的新回合
    ],
  );
  // 新回合的 refIdx 正确（u4 在 refs 中下标 4）
  assert.equal(merged[3].refIdx, 4);
  assert.deepEqual(merged[3].assistantList.map((a) => a.markdown), ["a4"]);
  // 窗口外回合的 assistantPreviewText 用索引摘要
  assert.equal(merged[0].assistantPreviewText, "a1");
});

test("mergeTurns: 索引为空时退化为窗口内回合", () => {
  const messages = [user("q1"), assistant("a1"), user("q2"), assistant("a2")];
  const entryIds = ["u1", "a1", "u2", "a2"];
  const doms = buildDomTurns(messages, entryIds);
  const merged = mergeTurns([], doms);
  assert.equal(merged.length, 2);
  assert.ok(merged.every((t) => t.loaded));
  assert.deepEqual(merged.map((t) => t.entryId), ["u1", "u2"]);
});

test("mergeTurns: 已加载回合的 userText 取窗口全量而非索引截断", () => {
  const turnIndex = [{ entryId: "u1", userText: "q1(截断)", assistantPreview: "a1" }];
  const messages = [user("这是完整的 q1 内容，超出索引截断长度"), assistant("a1")];
  const entryIds = ["u1", "a1"];
  const doms = buildDomTurns(messages, entryIds);
  const merged = mergeTurns(turnIndex, doms);
  assert.equal(merged[0].userText, "这是完整的 q1 内容，超出索引截断长度");
});