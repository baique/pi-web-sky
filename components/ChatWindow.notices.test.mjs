import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("renders temporary notices as a responsive toast stack", () => {
  // Desktop: bottom-right with `right: 51, bottom: 118`
  const desktopMatch = source.match(
    /position: "fixed",\s*right: 51,\s*bottom: 118,[\s\S]*?alignItems: "flex-end",[\s\S]*?<NoticeShelf notices=\{notices\} \/>/,
  );
  assert.ok(desktopMatch, "desktop notice container should be pinned bottom-right");

  // Mobile: top-centered with `left: "50%", top: 60`
  const mobileMatch = source.match(
    /position: "fixed",\s*left: "50%",\s*top: 60,[\s\S]*?alignItems: "center",[\s\S]*?<NoticeShelf notices=\{notices\} floating \/>/,
  );
  assert.ok(mobileMatch, "mobile notice container should be top-centered");

  // NoticeShelf should accept a `floating` prop for mobile transform origin
  const floatingProp = source.match(/function NoticeShelf\(\{ notices, floating \}/);
  assert.ok(floatingProp, "NoticeShelf should accept a floating prop");
});
