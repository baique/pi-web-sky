# 动态毛玻璃降级（滚动/拖拽期间）

> 日期：2026-09-01　范围：pi-web-sky
> 状态：已确认方案，实现中
> 目的：降低消息滚动、看板卡片拖拽时 backdrop-filter 实时模糊的 GPU 消耗，静止时显示效果 100% 不变。

---

## 0. 背景与根因

毛玻璃全部走 `backdrop-filter: blur(Npx) saturate(S)` + 半透明背景色。浏览器对 backdrop-filter 的代价主要在**背后像素变化时**：

- 背后内容静止（fixed 侧栏/顶栏/面板）→ backdrop root 被缓存，不重算，**不耗**。
- 背后像素每帧变化 → 每帧重采样 + 高斯模糊（成本 ∝ 半径²）。

真正的高消耗场景只有两个：
1. **消息列表滚动**：气泡随内容滚动，背后像素区域每帧变 → 每帧对全部可见气泡重模糊。
2. **看板大量卡片拖拽移动**：卡片移动，背后像素每帧变 → 每帧重模糊。

因此不做全局 canvas 预模糊方案，只针对动态场景**临时降级 blur 档位**，静止恢复。改动量一个量级更小，静止观感完全不变。

## 1. 机制

一个全局 hook 监听「滚动中」+「指针拖拽中」，期间给 `<html>` 加 `glass-dynamic` class，停止后（滚动停 120ms / 松手）移除。

```css
html.glass-dynamic {
  --glass-blur: 2px;
  --glass-blur-heavy: 3px;
  --glass-blur-panel: 3px;
  --glass-blur-popover: 3px;
  --glass-blur-bubble: 2px;
  --board-blur: 3px;
  --board-scrim-filter: none;   /* scrim 磨砂直接关，只留暗色承托 */
  --glass-saturate: 100%;       /* 去饱和操作也省 */
}
```

组件零改动：所有 backdrop-filter 都引用 `--glass-blur-*` / `--board-blur` / `--glass-saturate` / `--board-scrim-filter` CSS 变量，覆盖变量即全量生效。

> **!important 的必要性**：`--glass-blur-bubble` 与 `--board-scrim-filter` 由 `applyWallpaperCss` **JS 内联**写到 `<html>` style，普通 CSS 规则优先级压不过内联样式，必须加 `!important`（CSS important 声明 > 内联非 important 声明）。其余 blur 变量定义在 `:root`，普通规则即可覆盖。

降级值说明（高斯成本 ∝ 半径²）：
- 气泡 8px→2px：模糊成本降为 2²/8² ≈ 6%（省 94%）
- chrome/卡片 12px→3px：3²/12² ≈ 6%（省 94%）
- saturate 置 100%：省去 backdrop 去饱和的逐像素运算

## 2. 检测策略（useDynamicGlass）

- **滚动**：`window.addEventListener('scroll', fn, { capture: true, passive: true })` 捕获所有内部容器滚动（scroll 不冒泡，但 capture 阶段可在 window 收到）。
- **拖拽**：`pointerdown` 记录起点，`pointermove` 位移 > 3px 判定为拖拽（覆盖看板卡片拖拽、画布平移、滚动条拖拽）；点击按钮（无位移）不触发。
- **停止**：最后一次 scroll 后 120ms 超时 / `pointerup` 后 120ms，移除 class。滚动中持续触发会不断重置超时。
- 卸载时清理监听并移除 class。

## 3. 改动清单

| 文件 | 改动 |
|---|---|
| `hooks/useDynamicGlass.ts` | 新增：滚动/拖拽检测 hook |
| `app/globals.css` | 新增 `html.glass-dynamic` 变量覆盖 |
| `components/AppShell.tsx` | 挂载 `useDynamicGlass()` |

## 4. 验证

- 单元：useDynamicGlass 的事件行为（可选，逻辑简单）
- e2e（playwright + chrome-devtools）：滚动消息列表 / 拖拽看板卡片，断言 `html.glass-dynamic` 出现、停止后移除；肉眼确认滚动中模糊变弱、静止完整恢复。
- 性能：滚动/拖拽期间浏览器 GPU 占用 / 帧率对比（降级前 vs 后）。

## 5. 不做项

- 不碰视频背景（维持现状）。
- 不做 canvas 预模糊（动态降级足够时）。
- 不改变静止状态的任何观感与 blur 值。
