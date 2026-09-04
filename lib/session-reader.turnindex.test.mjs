import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { extractTurnIndex } = await jiti.import("./session-reader.ts");

function userEntry(id, parentId, content, timestamp = "2026-01-01T00:00:00.000Z") {
  return { type: "message", id, parentId, timestamp, message: { role: "user", content } };
}

function assistantEntry(id, parentId, blockText, timestamp = "2026-01-01T00:00:00.000Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      provider: "test",
      model: "test-model",
      content: blockText,
    },
  };
}

test("collects one index entry per user turn with previews", () => {
  const entries = [
    userEntry("u1", null, "first request"),
    assistantEntry("a1", "u1", [{ type: "text", text: "first answer" }]),
    { type: "toolResult", id: "t1", parentId: "a1", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "tool output" }] } },
    userEntry("u2", "t1", "second request"),
    assistantEntry("a2", "u2", [{ type: "text", text: "second answer" }]),
  ];

  const turns = extractTurnIndex(entries, null);
  assert.deepEqual(
    turns.map((t) => [t.entryId, t.userText, t.assistantPreview]),
    [
      ["u1", "first request", "first answer"],
      ["u2", "second request", "second answer"],
    ],
  );
});

test("assistant preview keeps the latest answer of the turn", () => {
  const entries = [
    userEntry("u1", null, "request"),
    assistantEntry("a1", "u1", [{ type: "text", text: "first answer" }]),
    assistantEntry("a2", "a1", [{ type: "text", text: "second answer" }]),
  ];
  const turns = extractTurnIndex(entries, null);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].assistantPreview, "second answer");
});

test("ignores non-text assistant blocks in the preview", () => {
  const entries = [
    userEntry("u1", null, "request"),
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        provider: "test",
        model: "test-model",
        content: [{ type: "thinking", thinking: "deep thoughts", signature: "" }],
      },
    },
  ];
  const turns = extractTurnIndex(entries, null);
  assert.equal(turns[0].assistantPreview, "");
});

test("truncates long previews", () => {
  const longText = "x".repeat(300);
  const entries = [
    userEntry("u1", null, longText),
    assistantEntry("a1", "u1", [{ type: "text", text: longText }]),
  ];
  const turns = extractTurnIndex(entries, null);
  assert.ok(turns[0].userText.length <= 121); // 120 chars + ellipsis
  assert.ok(turns[0].userText.endsWith("…"));
  assert.ok(turns[0].assistantPreview.length <= 141);
  assert.ok(turns[0].assistantPreview.endsWith("…"));
});

test("resolves the branch from the given leaf only", () => {
  const entries = [
    userEntry("u1", null, "root request"),
    assistantEntry("a1", "u1", [{ type: "text", text: "root answer" }]),
    userEntry("u2", "a1", "mid request"),
    assistantEntry("a2", "u2", [{ type: "text", text: "mid answer" }]),
  ];
  const turns = extractTurnIndex(entries, "u2");
  assert.deepEqual(
    turns.map((t) => [t.entryId, t.userText]),
    [["u1", "root request"], ["u2", "mid request"]],
  );
});

test("attachment-only user messages get a placeholder preview", () => {
  const entries = [
    userEntry("u1", null, [{ type: "image", data: "AAAA" }]),
  ];
  const turns = extractTurnIndex(entries, null);
  assert.equal(turns[0].userText, "[attachment]");
});

test("skips non-message entries (compaction, model_change)", () => {
  const entries = [
    userEntry("u1", null, "request"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: "summary text",
      firstKeptEntryId: "u1",
      tokensBefore: 10,
    },
    userEntry("u2", "cmp", "kept request"),
  ];
  const turns = extractTurnIndex(entries, "u2");
  assert.deepEqual(turns.map((t) => t.entryId), ["u1", "u2"]);
});