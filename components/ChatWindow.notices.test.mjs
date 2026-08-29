import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const drawerSource = await readFile(new URL("./NoticeDrawer.tsx", import.meta.url), "utf8");

test("renders desktop notices in the widget bar through NoticeDrawer (click-to-expand pill + drawer)", () => {
  // 桌面端浮动 NoticeShelf 已下线：公告改由底部 widget 栏内的通知抽屉承载
  assert.doesNotMatch(source, /right: 51,\s*bottom: 118/);
  // 播报槽合成上移至 ChatWindow（quota 由 useProviderQuota 提供额度数据）
  assert.match(source, /useBroadcast\(\{ notices: effectiveNotices, phase: phaseInfo, retryText, quota: quotaInfo \}\)/);
  // widget 栏内使用 NoticeDrawer（原位 + 闪烁胶囊 + 点击展开）；抽屉数据=持久化历史
  assert.match(source, /<NoticeDrawer\s+broadcast=\{noticeBroadcast\}\s+history=\{noticeHistory\}\s+onDismissError=\{dismissError\}\s+onRemoveNotice=\{removeNotice\}\s+onClearNotices=\{clearNotices\}\s+isDark=\{isDark\}\s*\/>/);

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

test("NoticeDrawer: pill reuses NoticeInline styling, flashes on new notices, expands upward into auto-height scrollable drawer", () => {
  // 折叠胶囊复用 NoticeInline（原位置原样式）+ 闪烁动画
  assert.match(drawerSource, /<NoticeInline/);
  assert.match(drawerSource, /notice-flash/);
  assert.match(drawerSource, /onClick=\{toggleOpen\}/);

  // 展开弹层：贴底向上、宽度对齐、高度自适应 + 最大高限制 + 纵向滚动
  assert.match(drawerSource, /createPortal/);
  assert.match(drawerSource, /position: "fixed"/);
  assert.match(drawerSource, /bottom: 40/);
  assert.match(drawerSource, /NOTICE_DRAWER_MAX_HEIGHT_RATIO/);
  assert.match(drawerSource, /maxHeight:/);
  assert.match(drawerSource, /overflowY: "auto"/);
  assert.match(drawerSource, /borderRadius: "10px 10px 0 0"/);

  // 消息默认完整展开（pre-wrap，无行数截断）
  assert.match(drawerSource, /whiteSpace: "pre-wrap"/);
  // 堆叠列表（history 数据源）
  assert.match(drawerSource, /history\.map\(\(notice\)/);
  // 单条清理 + 全部清理
  assert.match(drawerSource, /onRemoveNotice/);
  assert.match(drawerSource, /onClearNotices/);
  // 徽标数字（历史条数）
  assert.match(drawerSource, /historyCount/);
});
