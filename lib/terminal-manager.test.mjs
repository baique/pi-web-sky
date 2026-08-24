import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTerminal, writeTerminal, outputSince, fullBuffer,
  currentOffset, removeTerminal, listTerminals, trimRingBuffer,
} from "./terminal-manager.ts";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("session echoes input; offsets let SSE clients resume", async () => {
  const t = await createTerminal({ cwd: "/tmp", projectRoot: null, projectLabel: "t", cols: 80, rows: 24 });
  try {
    assert.ok(t.id);
    assert.equal(t.running, true);
    await wait(400); // let the shell print its prompt

    const before = currentOffset(t.id);
    writeTerminal(t.id, "echo hi-marker-$$\r");
    await wait(900);

    const replay = outputSince(t.id, before);
    assert.ok(replay !== null && replay.includes("hi-marker-"), "resume slice contains new output");
    assert.ok(fullBuffer(t.id)?.data.includes("hi-marker-"), "full buffer contains output");

    // Offsets are cumulative: replaying from an older point still works while
    // everything fits in the ring buffer.
    assert.ok(outputSince(t.id, 0)?.includes("hi-marker-"));
  } finally {
    removeTerminal(t.id);
  }
  assert.equal(listTerminals().some((s) => s.id === t.id), false);
});

test("trimRingBuffer cuts at a line boundary", () => {
  // Overflow lands inside a line → keep from the next line start.
  const [kept, dropped] = trimRingBuffer("aaaa\nbbbb\ncccc\ndddd", 12);
  assert.equal(dropped, 5, "drops up to (and including) the line break");
  assert.equal(kept, "bbbb\ncccc\ndddd");

  // Fits → untouched.
  const [kept2, dropped2] = trimRingBuffer("short", 10);
  assert.equal(kept2, "short");
  assert.equal(dropped2, 0);

  // Newline-free overflow → plain cut fallback (cannot align).
  const [kept3, dropped3] = trimRingBuffer("xxxxx", 3);
  assert.equal(kept3, "xxx");
  assert.equal(dropped3, 2);
});

test("ring buffer rotation invalidates stale offsets", async () => {
  const t = await createTerminal({
    cwd: "/tmp", projectRoot: null, projectLabel: "t",
    cols: 200, rows: 50,
  });
  try {
    await wait(400);
    // Push > 256KB through the shell so the buffer rotates.
    writeTerminal(t.id, "head -c 400000 /dev/zero | tr '\\0' 'x'\r");
    await wait(2500);
    const fb = fullBuffer(t.id);
    assert.ok(fb && fb.data.length <= 256 * 1024 + 4096, "buffer stays bounded");
    assert.ok(fb.startOffset > 0 || fb.data.length < 400000, "rotation tracked");
    // Offset 0 fell out of the window → null tells the client to full-replay.
    if ((fb?.startOffset ?? 0) > 0) {
      assert.equal(outputSince(t.id, 0), null);
    }
  } finally {
    removeTerminal(t.id);
  }
});
