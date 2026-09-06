# Worktree 选择功能改造设计（任务卡 #16）

日期：2026-09-05
状态：待审阅

## 背景

worktree 选择/切换/新建功能目前位于侧边栏「文件」tab 顶部（`SessionSidebar.worktreeSection`）。用户需要进入文件 tab 才能操作，层级深、位置不合理、容易被遗忘。

会话的 cwd 在创建时（首条消息落盘）即固定，**会话中途切换 worktree 是伪需求**——不存在"给已有会话换环境"的场景。因此选择器只服务「新建会话前决定环境」这一个时刻。

## 目标

1. 把 worktree 选择/切换/新建入口放到对话区（新会话空态欢迎页），随手可达
2. 删除文件 tab 里的选择器（单一入口）
3. 抽成可复用组件：欢迎页、任务卡共用
4. 配套补齐：卡片会话标题前的 worktree 徽标、统计信息中的工作目录

## 现状梳理

- 切换动作 = `setSelectedCwd(wt.path)`（SessionSidebar 内部 state）→ `onCwdChange` → AppShell `setActiveCwd` → 全局有效上下文
- 新建会话：`handleNewSession(id, cwd)` → `setNewSessionCwd(cwd)`；空态 `effectiveNewSessionCwd = newSessionCwd ?? (selectedSession===null && activeCwd ? activeCwd : null)`；首条消息 `POST /api/agent/new { cwd: newSessionCwd }` 落盘
- 欢迎页右上角现有 `web v0.x / pi v0.x` 版本号，价值低（升级提示已被标题旁 `NewSessionUpdateLink` 承担），删除
- 侧边栏会话行已有 worktree 徽标（fork 图标 + 分支名）；看板会话卡没有
- AppShell 顶栏统计弹层已有 projectDir/gitBranch/gitWorktree；看板卡统计弹层（SessionNavBar）没有工作目录

## 设计

### 1. 可复用组件 `WorktreeSelector`（新 `components/WorktreeSelector.tsx`）

从 SessionSidebar 现有实现抽取，自包含状态（加载/下拉开合/过滤/新建分支输入/删除确认/错误/忙碌），复用 `/api/worktrees` 接口与 `AnimatedDropdown`。

Props：

```ts
interface WorktreeSelectorProps {
  /** 用于解析 worktree 列表的当前有效 cwd（项目根或任一 worktree 路径均可） */
  cwd: string;
  /** 切换/新建成功后回调（父级更新 activeCwd / newSessionCwd） */
  onSelect?: (wtPath: string) => void;
  /** 锁定态：已有历史会话，仅展示不可交互（当前无调用方，预留） */
  disabled?: boolean;
  /** 是否展示完整路径（默认只显示分支名，路径进 hover title） */
  showPath?: boolean;
}
```

触发按钮：`⎇ <分支名> ▾`（git 分支图标 + 分支名 + 下拉箭头）。主 worktree 显示 `main`。下拉面板包含：过滤输入（≥8 个 worktree 时）、worktree 列表（当前项高亮、主 worktree 标注 `main`、非主项可删除带 force 确认）、底部新建分支输入 + 创建按钮。

### 2. 欢迎页（新会话空态）右上角

- 删除版本号块（`web v0.x / pi v0.x`）
- 右上角挂 `<WorktreeSelector cwd={effectiveNewSessionCwd} onSelect={...} />`
- **只在新会话空态显示**（`isNew && messages.length===0`）；首条消息落盘后消失——环境锁定可见即所得
- `onSelect` 处理（AppShell 层）：`setNewSessionCwd(path)` + `setActiveCwd(path)`，两者同步更新。侧边栏文件浏览/项目分组经 `activeCwd → SessionSidebar selectedCwd prop` 自动跟随

### 3. 文件 tab 选择器删除

SessionSidebar 移除 `worktreeSection` 及其全部支撑：`worktreeState`/`worktreeLoadingCwd`/`wtDropdownOpen`/`wtFilter`/`wtNewBranch`/`wtBusy`/`wtError`/`wtConfirmRemove`/`wtTriggerHovered`/`wtRefreshKey` 等 state、worktree 加载 effect、`handleCreateWorktree`/`handleRemoveWorktree`/`handleSelectWorktree` 相关 handler、下拉相关 ref。i18n keys 一并清理。

### 4. 任务卡（TaskArea TaskCard）header

- 任务名 label 之后、操作按钮组之前，放紧凑版 `<WorktreeSelector>`；**与操作按钮组同 hover 显隐**（切换低频、分支名长度不定，常驻会挤占任务行；hover 显示与现有交互一致）
- 样式兼容要求：pill 需融入任务卡行样式（`--side-hover`/`--side-active`、12px 字号、行高对齐），**下拉内必须保留"新建 worktree"完整语义**（列表 + 新建 + 删除），不是纯展示
- 切换语义 = 更新全局 activeCwd（与侧边栏一致），为任务后续新建会话选择环境；不引入"任务级默认 cwd"存储
- 任务卡绑定 cwd：任务行按项目分组，取任务所属项目的当前上下文 cwd（随 activeCwd 变化），不持久化

### 5. 看板会话卡徽标

- `SessionCardData` 增加 `worktreeBranch` / `isWorktree` 字段（`board-reconcile` 后端权威带出，确定性 id 幂等）
- 标题前显示徽标（**非主 worktree 时**）：fork 图标 + 分支名，样式对齐侧边栏 SessionTreeItem（accent 色、9-10px）
- 新会话卡（cwd 绑定未转正）不显示（无会话数据），转正后由 reconcile 带出

### 6. 统计信息必须有工作目录

- **SessionNavBar 统计弹层**（看板卡）：增加"工作目录"行——worktree 显示 `分支名 + 路径`，主 worktree 显示路径；复刻 AppShell 顶栏 projectRows 逻辑
- AppShell 顶栏弹层已有，不动
- SessionStatsSummary 紧凑行不加路径（单行太长，弹层已覆盖）

## 数据流

```
环境条/任务卡 pill 切换
  → WorktreeSelector.onSelect(wtPath)
  → AppShell: setNewSessionCwd(wtPath) + setActiveCwd(wtPath)
  → 空态 effectiveNewSessionCwd = newSessionCwd → 首条消息落盘 cwd = wtPath
  → SessionSidebar selectedCwd prop 同步 → 文件浏览/项目分组/会话列表跟随
```

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `components/WorktreeSelector.tsx` | 新增：可复用选择器 |
| `components/ChatWindow.tsx` | 空态欢迎页右上角：删版本号、挂 WorktreeSelector；透传 onSelect |
| `components/AppShell.tsx` | 提供 `onEnvWorktreeChange`（setNewSessionCwd + setActiveCwd） |
| `components/SessionSidebar.tsx` | 删除 worktreeSection 及全部 worktree 状态/逻辑 |
| `components/TaskArea.tsx` | TaskCard header 挂紧凑 WorktreeSelector |
| `components/board/SessionCardNode.tsx` | 标题前 worktree 徽标 |
| `lib/board-reconcile.ts` | SessionCardData 带出 worktreeBranch/isWorktree |
| `components/canvas/SessionNavBar.tsx` | 统计弹层加工作目录行 |
| `hooks/useBoardCanvas.ts` | SessionCardData 类型扩展 |
| i18n（`locales/`） | 清理侧边栏 worktree keys，新增必要文案 |

## 不做

- 会话中切换 worktree（伪需求）
- 版本号迁移到别处（NewSessionUpdateLink 已覆盖升级提示）
- 任务级默认 cwd 持久化
- SessionStatsSummary 紧凑行加路径
