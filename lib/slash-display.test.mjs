import assert from "node:assert/strict";
import test from "node:test";

const { skillExpansionToCommand } = await import("./slash-display.ts");

function skillExpansion({
  name = "review",
  location = "/path/to/review/SKILL.md",
  baseDir = "/path/to/review",
  body = "Review the supplied files.",
  args,
} = {}) {
  return `<skill name="${name}" location="${location}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>${args === undefined ? "" : `\n\n${args}`}`;
}

test("restores a complete SDK skill expansion with arguments", () => {
  const result = skillExpansionToCommand(skillExpansion({ args: "src/main.ts" }));
  assert.equal(result?.command, "/skill:review src/main.ts");
});

test("restores a complete SDK skill expansion without arguments", () => {
  const result = skillExpansionToCommand(skillExpansion());
  assert.equal(result?.command, "/skill:review");
});

test("restores multiline arguments", () => {
  const result = skillExpansionToCommand(
    skillExpansion({ args: "first line\nsecond line" }),
  );
  assert.equal(
    result?.command,
    "/skill:review first line\nsecond line",
  );
});

test("uses the final closing tag when the skill body contains an example", () => {
  const result = skillExpansionToCommand(
    skillExpansion({
      body: "Example:\n</skill>\nContinue.",
      args: "src",
    }),
  );
  assert.equal(result?.command, "/skill:review src");
});

test("does not collapse incomplete or lookalike user text", () => {
  assert.equal(
    skillExpansionToCommand(
      '<skill name="review" location="/path/to/review/SKILL.md">\nordinary user text',
    ),
    null,
  );
  assert.equal(
    skillExpansionToCommand(
      '<skill name="review" location="/path/to/review/SKILL.md">\nReferences are elsewhere.\n\nbody\n</skill>',
    ),
    null,
  );
  assert.equal(skillExpansionToCommand("ordinary user text"), null);
});

test("collapse keeps session auto-naming free of skill XML", () => {
  const firstMessage = skillExpansion({ name: "agent-md", args: "写计划" });
  const result = skillExpansionToCommand(firstMessage);
  const collapsed = result?.command ?? firstMessage;
  assert.equal(collapsed, "/skill:agent-md 写计划");
  // The sidebar slices the display form to 50 chars for the fallback title.
  assert.ok(collapsed.length <= 50);
  assert.ok(!collapsed.includes("<skill"));
});

test("plain first messages pass through unchanged for naming", () => {
  assert.equal(
    skillExpansionToCommand("hello world")?.command ?? "hello world",
    "hello world",
  );
  assert.equal(
    skillExpansionToCommand("")?.command ?? "",
    "",
  );
});

test("extracts the skill body (document) for expanded view", () => {
  const result = skillExpansionToCommand(
    skillExpansion({ body: "## 使用说明\n\n这是技能文档内容。" }),
  );
  assert.equal(result?.command, "/skill:review");
  assert.equal(result?.skillBody, "## 使用说明\n\n这是技能文档内容。");
});

test("extracts a multiline skill body without leaking the envelope", () => {
  const input = `<skill name="analyze" location="/path/SKILL.md">\nReferences are relative to /path.\n\n第一步：调研\n第二步：建模\n</skill>\n\n请分析一下项目结构`;
  const result = skillExpansionToCommand(input);
  assert.equal(result?.command, "/skill:analyze 请分析一下项目结构");
  // skillBody must be exactly the skill document, not the whole envelope.
  assert.equal(result?.skillBody, "第一步：调研\n第二步：建模");
  assert.ok(!result?.skillBody.includes("<skill"));
  assert.ok(!result?.skillBody.includes("</skill>"));
});

test("extracts user message after closing skill tag", () => {
  const input = `<skill name="review" location="/path/SKILL.md">\nReferences are relative to /path.\n\nbody text\n</skill>\n\nThis is the user's actual message.`;
  const result = skillExpansionToCommand(input);
  // Group 4 captures the text after </skill>\n\n which doubles as args
  // AND the user's prompt.
  assert.equal(result?.command, "/skill:review This is the user's actual message.");
  assert.equal(result?.userMessage, "This is the user's actual message.");
});

test("userMessage is undefined when skill has no trailing message", () => {
  const input = `<skill name="review" location="/path/SKILL.md">\nReferences are relative to /path.\n\nbody text\n</skill>`;
  const result = skillExpansionToCommand(input);
  assert.equal(result?.command, "/skill:review");
  assert.equal(result?.userMessage, undefined);
});

test("userMessage includes args when args are after skill tag", () => {
  const input = `<skill name="review" location="/path/SKILL.md">\nReferences are relative to /path.\n\nbody\n</skill>\n\n--arg1 value1`;
  const result = skillExpansionToCommand(input);
  assert.equal(result?.command, "/skill:review --arg1 value1");
  assert.equal(result?.userMessage, "--arg1 value1");
});