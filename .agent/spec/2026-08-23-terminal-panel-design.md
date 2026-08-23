# 内置终端面板设计（Terminal Panel）

> 日期：2026-08-23
> 状态：设计已与用户对齐（生命周期=B 服务端保活；安全=A 不加防护；项目绑定=A 全局列表按项目分组）

## 需求

在 pi-web-sky 中内置 Web 终端：

- 两个入口：顶栏系统按钮右侧新按钮（面板**向下**弹出）、主消息区右下角悬浮按钮（面板**向上**弹出）；两入口共用同一份开关状态。
- 支持多会话、完整 TUI（vim/htop 等）。
- 新建终端自动 cd 到当前激活会话所属项目的 cwd（worktree 会话 cd 到 worktree 路径）。
- 尽量用现成轮子，视觉与现有毛玻璃风格融合。

## 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 前端渲染 | `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links` | 业界标准（VS Code 同款），完整 TUI |
| 后端 PTY | `@lydell/node-pty`（prebuilt 二进制） | 规避原版 node-pty 的 node-gyp 安装编译失败问题（本项目 npm 发布 .next 产物） |
| 数据通道 | SSE 下行 + POST 上行 | 与 `/api/agent/[id]/events` 架构一致；Next.js 标准 server 对 WebSocket 不友好 |
| 服务端会话管理 | `globalThis.__piTerminals` 注册表 | 仿 `rpc-manager.ts`，防 Next.js 热重载丢状态 |

排除方案：ttyd/gotty 独立二进制 + iframe（样式无法融合、多会话弱）。

## 数据流

```
Browser                          Next.js Server                    OS
  │                                  │                              │
  ├─ POST /api/terminal ─────────────▶ spawn pty (cwd=项目路径) ────▶ shell
  ├─ POST /api/terminal/[id] ────────▶ pty.write(data) / resize ────▶
  ├─ GET /api/terminal/[id]/events ──▶ SSE：先回放缓冲，再推流 ◀───── pty.onData
  ├─ GET /api/terminal/list ─────────▶ 所有存活会话元数据            │
  └─ DELETE /api/terminal/[id] ──────▶ pty.kill()                   │
```

## 服务端

### `lib/terminal-manager.ts`

- 注册表：`globalThis.__piTerminals: Map<terminalId, TerminalSession>`。
- `TerminalSession`：pty 句柄、输出环形缓冲（约 256KB，配单调递增字节偏移）、cols/rows、创建时 cwd 与 `projectRoot`（复用 `lib/worktree.ts` 解析，用于 UI 分组标注）、退出码。
- **保活策略**：进程存活则一直保留；已退出的会话保留输出供查看，手动关闭或总数超上限（12）时按"先退出者先清"回收。
- shell 选择：unix `$SHELL || bash`，Windows powershell。cd 通过 spawn 的 `cwd` 参数实现，不发命令。

### API routes

| Route | 方法 | 行为 |
|---|---|---|
| `app/api/terminal/route.ts` | POST | 创建会话 `{ cwd }` → `{ id }` |
| 同上 | GET | 列出全部会话元数据（id、项目标注、运行状态、cols/rows） |
| `app/api/terminal/[id]/route.ts` | POST | `{type:"input", data}` 写入 / `{type:"resize", cols, rows}` 缩放 |
| 同上 | DELETE | kill 进程并移除会话 |
| `app/api/terminal/[id]/events/route.ts` | GET | SSE；`?since=<byteOffset>` 从偏移回放后转实时流 |

## 前端

### `components/TerminalPanel.tsx`

- 头部标签条：按项目分组的会话 chips（含运行状态圆点）+ 新建按钮 + 每会话关闭按钮。
- xterm 实例生命周期跟随浏览器标签页：切走 detach（停流），切回 attach 并按偏移补齐增量；关闭 chip = DELETE 服务端会话。
- xterm 主题从 CSS 变量派生（`--text`/`--font-mono` 等），亮暗色自动跟随。
- 入口挂载于 AppShell，共用同一份 open 状态：
  - 顶栏按钮 → 向下弹出，复用 todo 面板的 portal 锚定模式；
  - 右下角悬浮按钮 → 向上弹出，锚定逻辑镜像。
- 动效：从锚点方向 scale+fade ~150ms；`prefers-reduced-motion` 时关闭；移动端全屏 sheet。

## 毛玻璃融合

外壳与其他顶栏面板同款配方（`color-mix(in srgb, var(--glass-bg-strong) …)` + backdrop-blur）；终端内容区垫半透明深色底保证可读性，玻璃边框与模糊在四周透出。

## 边界情况

| 场景 | 行为 |
|---|---|
| 页面刷新 | 重连 attach，环形缓冲整体回放 |
| SSE 断线 | 按 `since` 偏移自动重连续传 |
| 进程退出 | 会话变灰显示 `exited (code N)`，输出可查，直到手动关闭 |
| 服务重启 | 会话全消失；客户端 attach 收到 404 后清空对应标签 |
| 无激活会话时新建 | cd 到用户主目录 |

安全边界：不加防护，与 Agent 同等信任模型；LAN 部署等同于把 shell 交给局域网（用户已知悉，整体认证留作未来独立议题）。

## 测试

- 单测（node:test `.test.mjs`）：环形缓冲偏移计算、注册表增删回收逻辑。
- E2E（playwright）：打开终端→执行命令见输出→刷新页面验证重连回放→退出进程验证状态展示。

## 明确不做

- 终端分屏、搜索、自定义 shell 配置项（后续有需求再加）。
- 整站访问认证（独立议题）。
