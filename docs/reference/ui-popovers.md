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
4. **位置对齐**：面板宽高、锚点与同类浮层一致（顶栏浮层统一满宽 = 顶栏宽度）；改动前先看同类浮层怎么做，不要自创。

## 本仓库浮层清单

| 浮层 | 触发 | toggle | 点外部关 | Esc | 宽度 |
|---|---|---|---|---|---|
| 系统提示词 / MCP / 工具 | 顶栏"系统""MCP""工具" | ✓ | ✓ | ✓ | 顶栏满宽（同一 portal，单值互斥） |
| 分支 BranchNavigator | 顶栏"分支" | ✓ | ✓ | ✓ | 顶栏满宽（自己算，containerRef = 顶栏） |
| 会话信息 popover | 顶栏统计按钮 | ✓ | ✓ | ✓ | 右侧限宽 min(560px, 100%) |
| 终端面板 TerminalPanel | 顶栏"终端" + 消息区角标 | ✓ | ✓ | ✓ | 锚按钮，自己算 |
| 设置 SettingsPanel | 左下角"设置/模型/技能" | ✗（再点同一按钮只切分区，不收起） | ✓（backdrop 点击） | ✓ | 固定 1080px |
| 偏好/外观（已并入设置） | — | — | — | — | — |

> **顶栏满宽浮层**：系统提示词 / MCP / 工具共用同一个 portal（`activeTopPanel` 单值互斥，宽度 = 顶栏宽度），接入路径 = 面板自己不做 `fixed` 定位、不出 `createPortal`（McpConfigPanel 的 `embedded` 开关），只管铺满浮层；关闭行为（点外部 / Esc / 再点按钮）由浮层统一管，**面板不要再自建一套开关状态**（`mcpOpen` / `toolsOpen` 已合并进 `activeTopPanel`）。
> 满宽面板的**内层布局也用比例**，不要写死 px 上限：MCP 面板 = 左列表 `flex: 0 0 20%`（保底 168px）+ 右侧详情/表单铺满（见 `MCP_PANEL_COLUMNS`）——面板宽度随顶栏变、内层却是固定宽的话，满宽时右侧会空一大片。

> 设置面板是**唯一不满足铁律 1** 的浮层：三个入口按钮都直接 `setSettingsSection("…")`（模型/技能是固定分区，设置按钮走 `getLastSettingsSection()` 恢复上次分区），点同一段不会置 null，只能靠 backdrop / Esc / × 关闭。要收敛就改 `components/AppShell.tsx` 的三个入口（同段再点→ `setSettingsSection(null)`）。

> 新增浮层后更新此表。
