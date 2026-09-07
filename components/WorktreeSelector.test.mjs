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
  // 删除当前 worktree → 回主分支：onSelect 上抛项目根（b11fd07 起带 project 身份第二参）
  assert.match(
    source,
    /if \(currentWorktree\?\.path === path\)[\s\S]*?onSelect\?\.\(state\.projectRoot,/,
  );
  assert.doesNotMatch(source, /const isCurrent = wt\.path === selectedCwd/);
});

test("switching/creating delegates to the parent via onSelect (no internal cwd state)", () => {
  // 切换：onSelect(path, project) —— 第二参携带项目身份（WorktreeProject）
  assert.match(source, /onSelect\?\.\(path, state \? \{/);
  // 新建即切：handleCreate 直接 onSelect(data.path, project)，不再经过 handleSelect
  assert.match(source, /onSelect\?\.\(data\.path, state \? \{/);
  assert.doesNotMatch(source, /setSelectedCwd/);
});
