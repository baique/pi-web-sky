# 2026-08-18 玻璃效果改造 + todo 迁移（验收清单）

> 提交链（HEAD 起 7 个，全部已提交、工作区干净）：
> `4e4193a` → `adaf811` → `347e96c` → `c25eb73` → `6fe9159` → `db065bb` → `e9b6768`

## 变更摘要（验收时重点看）

| # | 问题 | 改动 | 提交 |
|---|------|------|------|
| 前置 | 提交上一会话玻璃成果（背景图+置底+毛玻璃基础） | — | `4e4193a` |
| q2 | 消息字体 | `--font-mono` 首位改 `'JetBrains Mono','Consolas'`；`.markdown-body` 显式挂 mono（中文回退保留 Noto/PingFang/YaHei） | `adaf811` |
| q3 | 文字颜色 | 浅色 `--text #1a1a1a→#0f172a`（偏青蓝深色）、muted/meta 同步加深；深色 `--text #ebebeb→#f5f7fa`、muted/meta 偏白 | `347e96c` |
| q1 | 玻璃效果 | 新增 `--glass-bg-input`；`--glass-bg` 0.82→0.65、`--glass-bg-strong` 0.90→0.78；扩展 widget 展开面板由实心 `--bg-panel` 改半透明玻璃 | `c25eb73` |
| q6 | 思考块实心色块 | 去掉无效的嵌套 backdrop-filter（气泡卡片已有 blur，嵌套采样失效），背景 alpha 降至 ≈0.34，视觉为玻璃片 | `6fe9159` |
| q4 | 统计面板被气泡遮挡 | 根因：top bar 的 `backdrop-filter` 创建 stacking context 把面板 z500 困在内部。修复：top bar 容器 `position:relative; zIndex:300`；session/system/language 三面板玻璃化 | `db065bb` |
| q5 | todo → 右上角 | 解析会话 `pi-todo.state`（custom 条目）→ `buildSessionContext.todos` → 顶栏右上 Tasks 按钮（进行中数量徽标）→ 点击向右上角展开 300px 窄面板（标题 + x/y completed + 任务行 + 优先级圆点），点击外部/Esc 关闭，会话切换自动关闭 | `e9b6768` |

## 验证状态

- `tsc --noEmit` 通过
- `npm test` 587 全过
- `eslint` 变更文件全过
- 浏览器 DOM 实证：q4 面板区域 elementFromPoint 命中面板内容（不再被气泡盖住）；q5 按钮/面板/内容/关闭逻辑正常
- 视觉模型（opencode-go/minimax-m3）第一轮验证：q1/q2/q3/q6 五项全部通过
- q4/q5 视觉复核两轮因视觉 agent 环境卡住未完成截图报告（DOM 层已验证），**验收时请重点目测这两个**

## 验收方式

- 本地 dev：`http://127.0.0.1:30142`（30141 生产未动）
- 验收通过后再由用户决定是否更新生产环境