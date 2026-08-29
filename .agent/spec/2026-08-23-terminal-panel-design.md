# 内置终端面板设计（Terminal Panel）

> 日期：2026-08-23
> 状态：设计已与用户对齐（生命周期=B 服务端保活；安全=A 不加防护；项目绑定=A 全局列表按项目分组）
> 更新：2026-08-29 增量——面板自由拖拽+缩放、Esc 进终端、点击空白不再收起（提交 5cae3f3）

## 需求

在 pi-web-sky 中内置 Web 终端：

- 两个入口：顶栏“系统”按钮右侧常驻显示带文字的“终端”项（面板**向下**弹出）、扩展事件触发后出现的最下方栏右侧 Pi Web 工具区显示“终端”项（面板**向上**弹出）；两入口共用同一份开关状态。底栏左侧保留原有 TUI 扩展区（pi-todo、MCP 等），无扩展内容时底栏整体不显示。
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
- 入口挂载于 AppShell/ChatWindow，共用同一份 open 状态：
  - 顶栏“系统”右侧的文字按钮 → 向下弹出，复用 todo 面板的 portal 锚定模式；
  - 扩展事件出现后，底栏右侧 Pi Web 工具区的文字按钮 → 向上弹出，右边缘与按钮/窗口右侧对齐，避免面板溢出屏幕。
- 动效：从锚点方向 scale+fade ~150ms；`prefers-reduced-motion` 时关闭；移动端全屏 sheet。

### 面板交互（2026-08-29 增量）

- **自由拖拽**：tab 条（含 chip）按下并移动即可拖动整个面板到任意位置，位置钳制在视口内（不越界）。
  - 按下后移动超过 4px 阈值才进入拖拽态（此时才 `setPointerCapture` 并显示 `move` 光标），
    避免提前 capture 吞掉 chip 的 click——chip 上按住不移动仍是切换会话。
  - 拖拽后的位置保存在组件 state：关闭再打开面板位置保持；页面刷新后回到锚定默认（不持久化）。
- **自由缩放**：右下角透明缩放手柄（`nwse-resize` 光标，hover 时仅显示极淡斜角提示，
  平时完全融入玻璃、无边框无背景），拖拽改宽高，最小 320×200，最大钳制在视口内。
  - 缩放后 xterm 由 ResizeObserver → `fitWhenReady` 自动跟随 refit，无需手动操作。
  - 缩放尺寸同样保存在组件 state，关闭重开保持。
- **Esc 一律进终端**：面板可见时，无论焦点在 xterm 还是面板其它区域/body，Esc 都转发
  `\x1b` 到 pty（进入终端正常指令），不再关闭面板。关闭面板只保留「×」按钮。
- **点击空白不再收起**：已移除 outside-click 关闭监听（原 `onPointerDown` + `fabRef` 那套），
  点击面板外任何区域面板保持打开。
- **快捷键兜底（保留）**：面板可见且焦点不在文本输入控件时，纯 Ctrl+A-Z 由 document 级
  监听转发到 pty；Ctrl+W 在焦点于 xterm/body 时均被拦截并转发 `\x17`（bash/zsh 删前一词），
  浏览器不关标签页。Ctrl+N 未劫持（保持浏览器新窗口语义）。

## 毛玻璃融合

外壳与其他顶栏面板同款配方（`color-mix(in srgb, var(--glass-bg-strong) …)` + backdrop-blur）；终端内容区垫半透明深色底保证可读性，玻璃边框与模糊在四周透出。底栏继续保持“左侧 TUI 扩展 + 右侧 Pi Web 工具”的两段式结构。

## 边界情况

| 场景 | 行为 |
|---|---|
| 页面刷新 | 重连 attach，环形缓冲整体回放 |
| SSE 断线 | 按 `since` 偏移自动重连续传 |
| 进程退出 | 会话变灰显示 `exited (code N)`，输出可查，直到手动关闭 |
| 服务重启 | 会话全消失；客户端 attach 收到 404 后清空对应标签 |
| 无激活会话时新建 | cd 到用户主目录 |
| 点击面板外空白 | 面板保持打开（不自动收起，只靠 × 按钮关闭） |
| 焦点在 body 按 Esc | 转发 `\x1b` 进终端，面板不关 |
| 拖拽出视口 | 位置钳制在视口内，不会拖丢 |
| 缩放过小 | 钳制在最小 320×200 |
| 关闭重开面板 | 拖拽位置与缩放尺寸保持（组件 state 存活）；页面刷新后回到锚定默认 |

安全边界：不加防护，与 Agent 同等信任模型；LAN 部署等同于把 shell 交给局域网（用户已知悉，整体认证留作未来独立议题）。

## 测试

- 单测（node:test `.test.mjs`）：环形缓冲偏移计算、注册表增删回收逻辑。
- E2E（playwright）：打开终端→执行命令见输出→刷新页面验证重连回放→退出进程验证状态展示。

## 明确不做

- 终端分屏、搜索、自定义 shell 配置项（后续有需求再加）。
- 整站访问认证（独立议题）。
- 面板位置/尺寸持久化到 localStorage（目前仅组件内存态，刷新即回锚定默认；如需要可后续加）。
- Ctrl+N 劫持为新建终端（与浏览器新窗口冲突，未做）。
