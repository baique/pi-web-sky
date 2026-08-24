# 上游 PR 移植记录（Upstream Ports）

本仓库（`@baique/pi-web-sky`）是从 [agegr/pi-web](https://github.com/agegr/pi-web) fork 的独立分叉（Sky 皮肤 + 终端等自研能力）。本文件记录我们**已合并进本 fork 的上游 PR**，便于日后升级/排查时对照。

所有移植均经浏览器 e2e（playwright + chrome-devtools）或单元测试验证，并遵循项目「只做必要功能测试」的原则。

## 已合并的 PR

| 上游 PR | 主题 | 本 fork 提交 | 验证 | 备注 |
|---|---|---|---|---|
| **#519** | skills 开关写坏 SKILL.md 修复 | `04ac5bc` | e2e 双向 toggle | 显式 `disable-model-invocation: false` → 原地改，不产生重复 key |
| **#590** | 大图附件压缩 + toolResult 图片渲染 | `04ac5bc` | e2e 2000px PNG→1024 JPEG | 防多轮历史 413；`deferMedia` 已移除 |
| **#517** | 内置斜杠命令派发优化 | `04ac5bc` | e2e `/copy` 一次回车执行 | 精确命令直接执行；流式仅保留只读 builtin |
| **#536** | 文件管理器路径粘贴/拖入 | `04ac5bc` | e2e file://→本地路径 | 新增 `lib/clipboard-paths.ts` |
| **#587** | 会话历史尾部窗口分页 + BranchNavigator 爆栈修复 | `b5f18d9` | e2e 4382 条会话分页加载 | 见下方「与上游的差异」 |
| **#516** | 打开单会话不扫全量目录 | `5aa515f` | 单测 + 功能 e2e | 见下方「与上游的差异」 |

## 与上游的差异（必要修正，非原样照搬）

### #587 — 增加服务端 `hasMore` 标记

上游用 `rendered.length >= visibleCount` 推断「窗口已满」从而显示加载更多哨兵。但本 fork 的 **process-group 渲染会把多条 entry 折叠成少数组件**，导致一条 4382 条会话的 50-entry 尾部只剩 **47 条 UI 消息**（< 50），哨兵永不出现、无法继续分页（e2e 已实测复现）。

因此本 fork 改为**服务端返回 `hasMore`**（`lib/session-reader.ts` 的 `hasOlderHistory()`，以 entry 链长度为准），客户端 ChatWindow 用它决定是否显示哨兵。注意：滚到顶部且始终停在顶部时会连续加载多页（受 `hasMore` 上限约束），这是预期的「上滚持续加载」行为。

### #526 vs #516 — 同一优化的竞争 PR，选 #516

两者都是「路径缓存 miss 时不扫全量目录」。比较后选 **#516**：
- **#516**：只优化正向 `resolveSessionPath`（按 `<timestamp>_<id>.jsonl` 目录后缀定位 + 首行 header 校验），不碰 `loadAllSessions`。
- **#526**：额外优化反向 `resolveSessionIdByPath`，并把 `loadAllSessions` 改成按 realpath 只保留默认 sessions 目录内路径——**可能误伤符号链接 / 自定义布局的会话**，风险更高。

取了 #516 的低风险实现，正向热点路径收益相同（PR 基准 7ms vs 322ms）。

## 已审查但未合并/未采用的 PR

| PR | 说明 | 未采用原因 |
|---|---|---|
| **#526** | 同上 | #516 的低风险替代，见上 |
| **#581**（issue） | 斜杠面板中途触发 + 多 skill 选择 | 上游未实现（仅 issue 开放）；#319 对应的 feature request 被 `not_planned`。涉及 pi 侧仅展开首个 `/skill:` 的限制，需自行设计，工作量大，暂缓 |
| **#517**（已合） | — | — |

## 待办 / 下次考虑

- T2 大功能移植（分歧大、成本高，逐项确认后做）：#522（分隔条）、#458（会话分组）、#510（ask_user）、#470（MCP 管理）。
- T3 安全小补丁：#544（Origin 兼容）、#520（SVG CSP）。

---

## 移植流程备忘

1. 取 PR：`https://github.com/agegr/pi-web/pull/<n>.patch`
2. 逐 PR 移植 → `tsc --noEmit` + `npm run lint` + 单测
3. **浏览器 e2e**（playwright + chrome-devtools，dev server 在 `npm run dev` / 30143）
4. 若对上游逻辑有偏离，必须在本文件「与上游的差异」记录原因
