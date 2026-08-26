import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const chatInputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

test("renders temporary notices as a responsive toast stack (mobile only)", () => {
  // 桌面端浮动 NoticeShelf 已下线：公告改由 composer 顶栏播报槽承载
  assert.doesNotMatch(source, /right: 51,\s*bottom: 118/);
  // 播报槽合成上移至 ChatWindow（useBroadcast 不带 quota；额度为顶栏模型后展示位）
  assert.match(source, /useBroadcast\(\{ notices: effectiveNotices, phase: phaseInfo, retryText \}\)/);
  assert.match(source, /notice=\{\s*isMobile \|\| !noticeBroadcast \? null :/);

  // Mobile: top-centered with `left: "50%", top: 60`
  const mobileMatch = source.match(
    /position: "fixed",\s*left: "50%",\s*top: 60,[\s\S]*?alignItems: "center",[\s\S]*?<NoticeShelf notices=\{notices\} floating \/>/,
  );
  assert.ok(mobileMatch, "mobile notice container should be top-centered");

  // NoticeShelf should accept a `floating` prop for mobile transform origin
  const floatingProp = source.match(/function NoticeShelf\(\{ notices, floating \}/);
  assert.ok(floatingProp, "NoticeShelf should accept a floating prop");

  // 移动端不向顶栏下发公告数据（避免双重显示）
  assert.match(source, /phase=\{isMobile \? null : phaseBroadcast\}/);
});
