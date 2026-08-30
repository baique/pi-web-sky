# /goal 提示词：pi-web 会话看板 v2（卡片即工作台）

开发 pi-web-sky（项目根：/home/wa/project/pi-web-sky，Next.js 16 + React 19）的「会话看板」功能，目标是一次 /goal 会话内完成 P0 全量交付。

## 背景与硬约束

- 唯一设计依据：`.agent/spec/2026-08-29-session-canvas-v2.md`（**以 v2 为准，忽略同目录 08-29 旧版 v1**）。先通读该 spec 再动手。
- 本仓库铁律：**会话 .jsonl 文件原地不动**，一切组织/归属/关系只写旁路元数据（sqlite `~/.pi/agent/pi-web.db`，复用 `lib/sqlite-db.ts` 单例 + 版本化迁移）。
- 数据层 lib（sqlite-db / board-store）保持 **SDK-free**，`.mjs` 测试不写 TS 类型注解（node strip-types 只处理 .ts）。
- 样式强制套 `.agent/spec/2026-08-24-glass-spec.md` 毛玻璃规范：**禁止硬编码玻璃 rgba/px**，一律引 token（`--panel-glass` / `--frame-glass` / `--glass-blur-panel` / `--glass-blur-heavy` / `var(--glass-saturate)`）；背景墙纸 + 明暗主题 + prefers-reduced-transparency/contrast 四象限目测一致。
- 动效用 thinking-orbs（已装 0.3.1），**必须显式传** `theme={isDark ? "dark":"light"}`（useTheme().isDark），浅色加 `filter: brightness(0.57) contrast(1.15)`，尺寸 20。
- 画布引擎锁定 **tldraw@^5.3.2**（react19 兼容；v1 里写的 tldraw 3 已过时），`next/dynamic` ssr:false 按需加载（参照 TerminalPanel 的 xterm 做法），仅进入看板时下载。
- 测试原则：只做必要功能测试（`.agent/guide` 与 dev skill 约定）；数据层用事务+try/finally 回滚不保留测试数据；前端用 playwright + chrome-devtools 真实浏览器 e2e，不写前端单测。
- 全程遵守 writing-plans 的技能约束：每个任务先写失败测试再实现，任务粒度小，完成一步提交一次 git（feat/fix 前缀，避免巨大单次提交）。
- 每完成一个里程碑（M0~M5）停下向用户汇报，确认后再继续；任何 spec 与代码不一致处，先读 spec 为准，拿不准的停下来问。

## 核心需求（用户拍板，逐条实现）

1. **会话状态系统（本期必须完成）**：卡片与看板实时展示会话状态 —— 思考中 / 执行工具命令 / 等待输入 / 空闲 / 刚结束(30s 脉冲)；扩展 `GET /api/agent/running` 返回细分 states；orb 动效；侧栏与看板共用。
2. **多看板管理（必要）**：boards CRUD（新建/改名/删除，按 projectKey 隔离）；**系统「运行中」看板默认存在、不可改名删除**，自动聚合**所有项目**运行中会话为实时卡片（结束保留 30s 后消失），看板名旁显示运行数徽标。
3. **看板模式布局**：进入看板后主区域（原 ChatWindow 区域）**整体替换为画布**，侧栏保留；画布上方固定**看板栏**（返回 / 看板名下拉切换 / 运行数徽标 / 新建改名删除）+ **工具行**（添加会话 / 连线 / 清理失效节点；自动布局置灰占位）。
4. **卡片即工作台（核心，不是弹窗）**：会话节点两态 —— 收合卡（280×120，状态行+标题+元信息）与**展开工作台（同一卡片放大，portal 浮层 + 1/zoom 反补偿保持恒常 UI 尺寸，zoom<60% 降级骨架态）**；工作台 = 复用现有 MessageView 消息区 + ChatInput 完整输入 + **底栏（左侧复用 ExtensionStatusBar 的 widget 区与状态文本 [pi-todo / MCP / subagent]，右侧通知 NoticeDrawer + quota QuotaView + 上下文用量）** + 顶栏统计入口（浮层展示 SessionStatsInfo）；**不做终端**（ExtensionStatusBar 的 tools slot 不传）；同会话只允许一张展开卡，展开上限 3 张。
5. **美观是硬性验收项**：统一动效语言（展开/收合 200ms ease-out 可打断、拖拽弹性缓动、选中 accent 光晕、刚结束脉冲、prefers-reduced-motion 降级）；四象限主题目测通过才算完成。
6. 数据层：迁移 v3（boards / board_nodes / board_edges / board_view）+ `lib/board-store.ts`（SDK-free CRUD）+ 看板 API 全集（列表/建/改/删/整画布 GET+PUT 防抖全量保存单飞/节点增删改/边增删）+ 失效节点灰化与清理。
7. 连线：节点间连线 + 颜色/线型/箭头/标签，纯元数据。
8. 收尾：i18n 中英补全、`npm test`、`node_modules/.bin/tsc --noEmit`、`npm run lint` 全绿；playwright e2e 覆盖（建看板→添加会话→展开工作台发消息→状态实时刷新→刷新页面布局不丢）。

## 关键实现注意（spec §3.3/§6 细化）

- 展开工作台必须 portal 到画布 overlay 层（不受画布 transform 影响），位置用 `editor.pageToScreen` 换算 + rAF 跟手；缩放时内容按 1/zoom 反补偿。
- 底栏「weight」已确认 = **widget**（用户原话：终端左边显示 pi-todo / MCP / subagent 的扩展 widget 区）：卡片底栏左侧复用 `ExtensionStatusBar`（widgets + statuses，tools 不传即无终端按钮），右侧传通知 + quota。
- 卡片内状态以 useAgentSession 的 SSE 为准，看板聚合态以轮询为准，避免双源打架。
- 先验证 `useAgentSession` 复用可行性（读其 props/依赖与 AppShell 解耦程度）；耦合过深就抽 `useSessionMessages` 核心子集给工作台与 ChatWindow 共用，禁止双实现。
- M2 开工前先做 tldraw@5 + react19 + Next16 + dynamic ssr:false + 自定义 ShapeUtil 渲染单卡的技术验证（20 分钟），通过再铺开。

## 验收（全部满足才算 done）

- [ ] 进入看板模式：主区域为无限画布，缩放/平移/拖拽/框选/对齐线正常，看板栏+工具行可见
- [ ] 从侧栏/看板内添加会话到画布（拖入或按钮），收合卡显示状态/标题/元信息
- [ ] 双击卡片展开为工作台：消息历史渲染、可输入发送、模型/thinking/tools 可用、底栏通知+quota+上下文显示、统计浮层正确
- [ ] 连线建立/删除/样式可编辑；布局刷新页面后不丢
- [ ] 运行中看板自动聚合所有运行中会话，状态实时刷新，结束后自动消失
- [ ] 明暗×壁纸×减弱透明四象限目测无违和；动效无跳变
- [ ] npm test / tsc --noEmit / npm run lint 全绿；e2e 通过

## 交付物

- 全部代码提交到 git（里程碑粒度提交）
- `.agent/spec/2026-08-29-session-canvas-v2.md` 为唯一 spec，实现中发现偏差就地修订该文件并记录
- 完成后在仓库 `.agent/` 下给出简短验收报告（对照上述验收项逐条给证据）
