import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./subagent-widget.ts");
  } catch {
    return import("./subagent-widget.ts");
  }
}

const {
  parseSubagentSnapshot,
  parseSubagentInspectReply,
  widgetParsers,
  SUBAGENT_ASYNC_JSON_PREFIX,
  SUBAGENT_INSPECT_JSON_PREFIX,
} = await loadSubject();

const SNAPSHOT = {
  kind: "pi-subagents.async-status-snapshot",
  version: 1,
  generatedAt: 1787999999000,
  caps: { maxRuns: 20, maxChildrenPerNode: 8, maxDepth: 3, maxStringLength: 160, maxSerializedBytes: 32768 },
  omitted: { runs: 0, children: 0, byteLimitExceeded: false },
  runs: [
    {
      id: "run-1",
      kind: "subagent",
      label: "worker",
      state: "running",
      startedAt: 1787999998000,
      activity: { currentTool: "read", toolCount: 3 },
    },
  ],
};

test("解析正常快照，字段映射正确", () => {
  const lines = [`${SUBAGENT_ASYNC_JSON_PREFIX}${JSON.stringify(SNAPSHOT)}`];
  const parsed = parseSubagentSnapshot(lines);
  assert.ok(parsed);
  assert.equal(parsed.kind, "pi-subagents.async-status-snapshot");
  assert.equal(parsed.runs.length, 1);
  assert.equal(parsed.runs[0].label, "worker");
  assert.equal(parsed.runs[0].state, "running");
  assert.equal(parsed.runs[0].activity?.currentTool, "read");
});

test("非 JSON 前缀返回 null", () => {
  assert.equal(parseSubagentSnapshot(["plain text line"]), null);
});

test("前缀对但 JSON 非法返回 null", () => {
  assert.equal(parseSubagentSnapshot([`${SUBAGENT_ASYNC_JSON_PREFIX}{not-json`]), null);
});

test("前缀对但 kind 不符返回 null", () => {
  const lines = [`${SUBAGENT_ASYNC_JSON_PREFIX}${JSON.stringify({ kind: "other.kind", runs: [] })}`];
  assert.equal(parseSubagentSnapshot(lines), null);
});

test("runs 非数组返回 null", () => {
  const lines = [
    `${SUBAGENT_ASYNC_JSON_PREFIX}${JSON.stringify({ kind: "pi-subagents.async-status-snapshot", runs: "nope" })}`,
  ];
  assert.equal(parseSubagentSnapshot(lines), null);
});

test("解析 inspect 回包", () => {
  const reply = {
    kind: "pi-subagents.inspect-reply",
    version: 1,
    requestId: "req-1",
    asyncId: "run-1",
    status: "running",
    messages: [{ role: "assistant", kind: "toolCall", name: "read", text: "read src/a.ts" }],
  };
  const parsed = parseSubagentInspectReply([`${SUBAGENT_INSPECT_JSON_PREFIX}${JSON.stringify(reply)}`]);
  assert.ok(parsed);
  assert.equal(parsed.requestId, "req-1");
  assert.equal(parsed.messages?.[0].kind, "toolCall");
});

test("注册表骨架含 subagent-async 解析器", () => {
  assert.equal(typeof widgetParsers["subagent-async"], "function");
});
