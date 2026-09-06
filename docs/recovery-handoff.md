# 会话压缩恢复手册 — dev/0904 看板核心治理审查（2026-09-05）

> 本文件用于压缩后快速恢复上下文。任何后续在此工作区继续审查/合并前，**先读本文件 + merge 分支 AGENTS.md + docs/reference/board-dev-traps.md**。

## 一、当前 git 拓扑（权威状态）

```
merge 分支 @ c107b00（集成分支，含全部已完成修复）
  ↑ 领先 main 77 个提交（高修复 3 + M系列 9 + resize 重构 + 低风险批次 2 + docs）
  ↑ 全部已验证：tsc ✓ 单测 786 中 785 pass（唯一 fail=models-config/test 预存，与本批无关）

待审功能分支（相对 merge 各领先 1-2 提交，未合入）：
  background-scrim @ d76b55d  卡片玻璃背景 scrim 叠加
  connection      @ a78332d  便笺/文本连线到会话卡发送按钮
  emoji           @ 2ac4f93  卡片 emoji 支持
  worktree        @ e250026  选择器迁移对话区（任务卡#16，含 5435733 docs）

main @ 0d6f1be（v0.1.41，未动）
```

## 二、Worktree 与端口映射

| worktree 目录 | 分支 | dev 端口 |
|---|---|---|
| `~/work/develop/project/pi-web-sky` | dev/0904（主开发） | 30143 |
| `.../background-scrim` | main（审查基线，已切走） | ~~30144~~ 已停 |
| `.../merge` | **merge（集成分支）** | **30145（tmux dev-merge）** |
| `.../connection` / `emoji` / `worktree` | 各自功能分支 | 无服务 |

merge worktree 有真实 node_modules（symlink 会导致 Turbopack 报错，**必须真装**）。
npm ci 时若被 install-scripts 拦：`npm install-scripts ls` 查待批脚本。

## 三、工作流程守则（王先生定的）

1. **审查流程**：功能分支 → subagent 审查（三维度：bug/隐患、ponytail 整洁度、第一性 vs 补丁）→ 王先生拍板改不改 → 父进程亲自改（subagent 两次越权教训：曾擅自提交+重启服务）→ e2e → squash 合入 merge
2. **e2e 五步法**（王先生强约束，违反必失败）：① 重置视口 ② 缩小留操作空间 ③ 自建元素到指定位置 ④ 激活/置顶/验证 elementFromPoint ⑤ 才正式操作。**绝不在存量污染数据上猜状态**
3. **playwright 限制**：RF 的鼠标合成事件（框选/resize 手柄/节点选中）**page.mouse 无法可靠触发**（d3 内部事件），这类场景**交给王先生手测**，不要死磕（曾陷入 20+ 轮死循环）
4. **yjs 验证用 dump**：node:sqlite 读 ~/.pi/agent/sync.db 的 yjs_documents，解码 Y.Doc 看落库值——比看 UI 快且准
5. **测试数据隔离**：e2e 建临时看板（POST /api/boards），用完 DELETE；真实库 pi-web.db 操作后必须清理
6. 验证命令：`node_modules/.bin/tsc --noEmit`；`node --test`（全量 786）；核心 `node --test lib/board-store.test.mjs lib/task-store.test.mjs lib/task-card-store.test.mjs lib/board-reconcile.test.mjs`（48 pass）

## 四、绝对不可丢失的领域知识（从坑里换来的）

详见 **docs/reference/board-dev-traps.md**（已在 merge 分支），核心 5 条：
1. **删字段前查库契约**：RF `nodeHasDimensions` 读 `measured?.width ?? width ?? initialWidth`（不读 style）→ cleanNode 剥 measured 曾致全画布节点隐形（visibility:hidden），点不中/resize 失效/拖入看不见
2. **优先官方公开 API**：resize 落库用 NodeResizer `onResizeEnd`（一次写全 style/顶层/data.w/h），别赌 onNodesChange 内部 change 流（onEnd 无 setAttributes 只写 measured 不写 style → 松手还原；RF 重初始化派幽灵 change 覆盖）
3. **尺寸落库三处对齐**：顶层 width/height > style > measured；改尺寸验证要 dump yjs 看真值
4. **写路径回归四件套**：拖拽 / resize / 拖入 / 选中+手柄
5. **派生元素后端 reconcile 权威**：前端不补卡不孤儿清理；UI 态（selected/dragging/resizing）不进 yjs

## 五、审查发现的 M 系列修复清单（全在 merge）

- **高3**：H1 compact 对运行进程无效（flush+unloadDocument 修复）；H2 10s reconcile 调度器恢复；H3 删会话不清理 task_cards.session_id（死分支早退，僵尸 running 卡）
- **M1** resize 每帧写 yjs → 最终重构为官方 onResizeEnd
- **M2** 全量闭包 patch → 增量 patch（防抖窗口回滚）
- **M3** reconcile 测试旧断言对齐
- **M4** 自由元素删不级联删边（幽灵边）
- **M5** 归属原子化：POST /api/tasks/[id]/assign-session（新路由）
- **M6** 重复拖入整卡覆盖 → has 判断只移位置
- **M7** 右键菜单 client 坐标当 flow 坐标 → menu 加 flowX/flowY（screenToFlowPosition）
- **M8** board-assets 无回收 → DELETE 端点 + 删 image-node 前端接线
- **M9** flushDelay 500ms 丢写 → destroy 前 flushPendingUpdates
- **M10** 改名 Escape 被 blur 重提交 → cancelRenameRef

## 六、低风险批次（b5ecc3a + c107b00）

- 死代码层清理（-1334 行）：purge-orphans、board-store nodes/edges 层、ensureTaskSessionCard、board-utils、死事件（CANVAS_CHANGED/BASE_UPDATED）、board-types 死类型
- diag 日志删除、nodeCount 假数据全链删、saveViewport 去重、复制放行文本选区、多选删除遍历、删卡 await、edge id 防撞
- 文档修正（task-cards.md/boards.md/SessionWorkbench 去 tldraw 化）、ADR 0002（分组移除原因）

## 七、⚠️ 待办 / 风险（王先生需决策）

1. **merge 领先 main 77 提交未合并**——最大风险：主工作区仍是旧代码，应尽快决策合并/发版
2. **3 项改动 e2e 卡在 playwright 鼠标限制，需王先生手测**：① 框选多便笺 Delete（多选删除）② 双 tab 平移是否互跳（saveViewport 去重）③ 删图片后 board-assets 文件是否回收
3. **models-config/test 预存 fail** 未查根因（可能是真 bug 或环境）
4. **真实库曾被 cleanNode bug 期污染**（剥 measured），理论上 reload 自愈未逐一确认
5. **sync.db / pi-web.db 无完整备份**——大量测试建删后建议备份
6. **resize 吸附已定案为纯展示**（不磁吸），用户已确认可接受

## 八、重要文件脉络（改动涉及）

- `hooks/useBoardCanvas.ts`——核心：cleanNode、onResizeEnd 契约、addSessionNode（原子归属+has 判断）、deleteNodeWithConfirm、saveViewport 去重
- `lib/board-store.ts`——已裁剪 ~330 行（board 层 + removeSessionFromBoards 纯业务闭环）
- `lib/board-reconcile.ts`——后端派生 reconcile（不补任务卡，只删孤儿）
- `lib/board-types.ts`——只剩 BoardInfo + running 状态类型
- `lib/yjs-room-server.mjs`——compact 治理（flush + unloadDocument）
- `components/canvas/CanvasStage.tsx`——坐标转换、复制/删除/键盘、onBeforeDelete 遍历
- `components/board/*Node.tsx`——四类节点 onResizeEnd 落库
- `app/api/tasks/[id]/assign-session/route.ts`——新增原子归属端点
- `docs/reference/board-dev-traps.md` + `docs/adr/0002-drop-board-grouping.md`——经验沉淀

## 九、对话中王先生确认的决策

1. 分组功能移除原因：**使用频率不高 + 引入一堆样式/操作问题**（ADR 0002 已记）
2. resize 吸附定案：纯展示不磁吸（松手落库原始尺寸）
3. 待审功能分支逐个审查流程，测试由王先生负责
4. background-scrim 开发会话 id：`46152843-9a1b-4d50-a679-6623a28686ad`（在磁盘完好，若 UI 列表不见可直接访问）
