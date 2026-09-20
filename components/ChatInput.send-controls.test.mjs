import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

test("mobile and desktop send controls share one implementation", () => {
  assert.match(source, /const renderSendControls = \(\) => \(/);
  assert.match(source, /\{isMobile && renderSendControls\(\)\}/);
  assert.match(source, /\{!isMobile && renderSendControls\(\)\}/);
});

test("streaming replaces send with stop + steer + follow-up", () => {
  const controls = source.slice(
    source.indexOf("const renderSendControls"),
    source.indexOf("const getNextSlashIndex"),
  );
  assert.match(controls, /isStreaming \? \(/);
  assert.match(controls, /onClick=\{onAbort\}/);
  assert.match(controls, /sendQueued\("steer"\)/);
  assert.match(controls, /sendQueued\("followup"\)/);
  assert.match(controls, /onClick=\{handleSend\}/);
});
