import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./WorktreeSelector.tsx", import.meta.url), "utf8");

test("uses the server-resolved current worktree identity", () => {
  assert.match(source, /currentWorktreePath: string \| null/);
  assert.match(
    source,
    /const currentWorktree =[\s\S]*?state\.currentWorktreePath[\s\S]*?w\.path === state\.currentWorktreePath/,
  );
  assert.match(source, /if \(currentWorktree\?\.path === path\) handleSelect\(state\.projectRoot\)/);
  assert.doesNotMatch(source, /const isCurrent = wt\.path === selectedCwd/);
});

test("switching/creating delegates to the parent via onSelect (no internal cwd state)", () => {
  assert.match(source, /onSelect\?\.\(path\)/);
  assert.match(source, /handleSelect\(data\.path\)/);
  assert.doesNotMatch(source, /setSelectedCwd/);
});
