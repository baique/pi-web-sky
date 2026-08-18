import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("renders temporary notices once as a toast stack pinned to the bottom-right", () => {
  const noticeShelfUsages = source.match(/<NoticeShelf notices=\{notices\}/g) ?? [];

  assert.equal(noticeShelfUsages.length, 1);
  assert.match(
    source,
    /position: "fixed",\s*right: 51,\s*bottom: isMobile \? 168 : 118,[\s\S]*?alignItems: "flex-end",[\s\S]*?<NoticeShelf notices=\{notices\} \/>/,
  );
});
