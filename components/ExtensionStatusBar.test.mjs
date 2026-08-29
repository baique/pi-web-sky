import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  ExtensionStatusBar,
  formatExtensionStatusLine,
  sanitizeExtensionStatusText,
} = await jiti.import("./ExtensionStatusBar.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function renderStatusBar(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ExtensionStatusBar, props),
    ),
  );
}

test("sorts status text by hidden key like the Pi CLI footer", () => {
  const statuses = [
    { key: "20-memory", text: "memory" },
    { key: "90-notify", text: "notify" },
    { key: "10-permissions", text: "permissions" },
    { key: "05-ponytail", text: "ponytail" },
  ];

  assert.equal(
    formatExtensionStatusLine(statuses),
    "ponytail permissions memory notify",
  );
});

test("sanitizes status text for a single-line display", () => {
  assert.equal(
    sanitizeExtensionStatusText("  first\tsecond \r\n third  "),
    "first second third",
  );
});

test("renders a single status line without identifier keys", () => {
  const html = renderStatusBar({
    statuses: [
      { key: "20-memory", text: "\x1b[32mmemory\x1b[0m" },
      { key: "05-ponytail", text: "ponytail" },
    ],
  });

  assert.match(html, /aria-label="ponytail memory"/);
  assert.match(html, /extension-status-shelf/);
  assert.match(html, /extension-status-line/);
  assert.match(html, /extension-status-text/);
  assert.match(html, />ponytail <\/span>/);
  assert.match(html, />memory</);
  assert.doesNotMatch(html, /05-ponytail|20-memory/);
});

test("renders widgets and status text in one footer", () => {
  const html = renderStatusBar({
    statuses: [{ key: "status", text: "connected" }],
    widgets: [{
      key: "usage",
      lines: ["42%"],
      placement: "aboveEditor",
    }],
  });

  assert.match(html, /extension-status-shelf has-widgets has-status/);
  assert.match(html, /extension-widget-triggers/);
  assert.match(html, /usage/);
  assert.match(html, /connected/);
});

test("subagent-async 快照渲染为结构化卡片", () => {
  const snapshot = {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    generatedAt: 1787999999000,
    runs: [{ id: "r1", kind: "subagent", label: "worker", state: "running" }],
  };
  const html = renderStatusBar({
    statuses: [],
    widgets: [{
      key: "subagent-async",
      lines: [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(snapshot)}`],
      placement: "belowEditor",
    }],
  });

  assert.match(html, /subagent-widget-card/);
  assert.match(html, /1 runs · 1 running · 0 done/);
});

test("subagent-async 解析失败降级为文本 widget", () => {
  const html = renderStatusBar({
    statuses: [],
    widgets: [{
      key: "subagent-async",
      lines: ["plain text line"],
      placement: "belowEditor",
    }],
  });

  assert.doesNotMatch(html, /subagent-widget-card/);
  assert.match(html, /extension-widget-triggers/);
  assert.match(html, /subagent-async/);
});

test("非 subagent widget 保持原样", () => {
  const html = renderStatusBar({
    statuses: [],
    widgets: [{
      key: "web-activity",
      lines: ["─── Web Search Activity ───", "  No activity yet"],
      placement: "aboveEditor",
    }],
  });

  assert.doesNotMatch(html, /subagent-widget-card/);
  assert.match(html, /extension-widget-triggers/);
  assert.match(html, /No activity yet/);
});
