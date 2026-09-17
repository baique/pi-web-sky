# 浮层交互规范（Popovers / Panels / Dialogs）

> 适用范围：所有悬浮层——顶栏/侧栏按钮弹出的面板（终端、MCP、工具面板）、设置对话框、右键菜单、下拉等。**新增任何浮层必须遵守本节，浏览器 e2e 验证后再合入。**

## 铁律

1. **触发按钮可多次点击 toggle 开关**：点一次打开，再点一次收起（`setOpen((v) => !v)`），不要做成"只能开、必须点别处关"。
2. **点击弹层外部必须关闭**：`pointerdown` 监听在 `document` 上，判断 `event.target` 不在触发按钮内、不在弹层内时关闭。典型实现：

   ```tsx
   useEffect(() => {
     if (!open) return;
     const onPointerDown = (event: PointerEvent) => {
       const btn = triggerBtnRef.current;
       if (btn && btn.contains(event.target as Node)) return;          // 点按钮 → 交给 onClick toggle
       const panel = document.querySelector("[data-some-panel]");
       if (panel && panel.contains(event.target as Node)) return;      // 点面板内 → 不关
       setOpen(false);
     };
     document.addEventListener("pointerdown", onPointerDown);
     return () => document.removeEventListener("pointerdown", onPointerDown);
   }, [open]);
   ```

   注意：面板根节点要带可定位的 `data-*` 属性（如 `data-tools-panel`），不要用 className 查询。
3. **Esc 关闭**（适用时，与其他弹层一致）：`keydown` 监听 Esc → `preventDefault` + 关闭，已打开的输入法组合（`event.isComposing`）不拦截。
4. **位置对齐**：面板宽高、锚点与同类浮层一致（如工具面板 = 视口 45% 宽）；改动前先看同类浮层怎么做，不要自创。

## 本仓库浮层清单

| 浮层 | 触发 | toggle | 点外部关 | Esc |
|---|---|---|---|---|
| 终端面板 TerminalPanel | 顶栏"终端" | ✓ | ✓ | ✓ |
| MCP 面板 McpConfigPanel | 顶栏"MCP" | ✓ | ✓ | ✓ |
| 工具面板 ToolDefinitionsPanel | 顶栏"工具" | ✓ | ✓ | ✓ |
| 设置 SettingsPanel | 左下角"设置/模型/技能" | ✗（再点同一按钮只切分区，不收起） | ✓（backdrop 点击） | ✓ |
| 偏好/外观（已并入设置） | — | — | — | — |

> 设置面板是**唯一不满足铁律 1** 的浮层：三个入口按钮各自 `setSettingsSection("…")`，点同一段不会置 null，只能靠 backdrop / Esc / × 关闭。要收敛就改 `components/AppShell.tsx` 的三个入口（同段再点→ `setSettingsSection(null)`）。

> 新增浮层后更新此表。
