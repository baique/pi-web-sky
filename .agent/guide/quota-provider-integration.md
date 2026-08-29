# 额度查询 · 提供商接入说明

> 功能设计：[2026-08-26-quota-display-design.md](./2026-08-26-quota-display-design.md)
> 展示位：**底栏常驻**（通知 NoticeDrawer 之后、Terminal 之前），不受通知/流式状态影响（2026-08-29 改，原设计为通知槽 idle 态，已废弃）

## 数据流

```
auth.json(服务端) → GET /api/quota?provider=X → useProviderQuota(60s轮询)
  → { quota, error } → ChatWindow 底栏常驻（额度/错误提示排在通知后面）
```

## 错误反馈（2026-08-29 加）

额度查询失败不再静默留空，底栏常驻位按分类提示：

| error kind | 触发 | 展示 |
|---|---|---|
| `auth` | 上游 401/403（key 被拒/过期） | 红色 ⚠ `额度凭据失效，请重新登录`，清空旧额度 |
| `no-credential` | auth.json 无该提供商凭据 | 黄色 ● `未登录，额度不可用` |
| `transient` | 网络失败/5xx/超时 | 低调 `额度查询失败`（若已有旧额度则保留旧值不提示） |

- 后端 `fetchJson` 抛 `QuotaHttpError(status)`，`GET /api/quota` 失败响应带 `status` 字段供前端区分
- 前端 `useProviderQuota` 返回 `{ quota, error }`（`QuotaErrorKind = auth | no-credential | transient`）

## 接入一个新提供商的步骤（共 3 处）

### 1. 后端加查询分支 — `app/api/quota/route.ts`

在 `queryQuota()` 里加分支，并在文件顶部补解析函数：

```ts
if (provider === "your-provider") {
  return parseYourProvider(await fetchJson("https://api.example.com/balance", key));
}
```

解析函数返回 `QuotaPayload`（二选一）：

```ts
// 余额型（有金额概念）
{ kind: "balance", currency: "CNY", totalBalance: "10.91",
  isPeak: false, nextSwitchAt: "..." }   // isPeak/nextSwitchAt 仅 deepseek 峰谷用，无则随意给值

// 用量型（订阅制时间窗/次数）
{ kind: "usage", windows: [
    { label: "5h", percent: 24, status: "ok", resetsAt: "<ISO时间>" }, ... ] }
```

要点：
- `percent` 统一为 0–100；`resetsAt` 统一转成 ISO 字符串（上游给秒数就 `new Date(Date.now()+sec*1000).toISOString()`）
- 上游字段名与文档不符是常态，**接入前先用真实 key curl 实测**锁定形状，解析做防御性兼容
- key 从 `auth.json` 的 `<provider>.key` 读取（`readProviderKey` 已通用，无需改）

### 2. 前端声明支持 — `hooks/useProviderQuota.ts`

```ts
const SUPPORTED_PROVIDERS = new Set(["opencode-go", "deepseek", "your-provider"]);
```

### 3. 展示文案 — `toQuotaInfo()`

- **usage 型**：行内自动渲染 `label percent%` 平铺（QuotaView 通用，无需改组件）；
  每窗的 `detail` 字段写悬停明细，建议格式：`5h窗 24%，剩 1h27m，重置 8/26 18:30`
- **balance 型**：拼 `text`，参考 deepseek：`¥10.91 · 峰 · 18:00转谷 (1h19m)`；
  币种符号映射加在 `currencySymbol()`
- **commandcode 分时窗（usage 型，2026-08-29 接入）**：
  - 凭据是 **OAuth access token**（`auth.json` 里 `{type:"oauth",access}`，非 key）——后端 `readProviderKey` 已兼容
  - 上游：`GET /alpha/whoami`（拿 orgId，个人账号为 null 则不传）→
    `GET /alpha/billing/credits`（`windowLimits.fiveHour/weekly`：used/cap/resetAt，resetAt 为**毫秒**）
    + `GET /alpha/usage/summary`（totalCost 本期已用）
  - 映射与 opencode-go 对齐的三窗：5h 窗（used/cap 百分比）、周窗（used/cap 百分比）、
    月窗（本期消费占比 `spent/(spent+remaining)`，resetsAt 留空）
  - 展示示例：`5h 52% · 周 26% · 月 15%`（悬停看重置时刻）

## 展示位（常驻）

- 额度不再走通知槽 idle（NoticeDrawer 只负责 P0/P1 通知）
- ChatWindow bottom-band 的 `notice` 容器内：`<NoticeDrawer/>` 后追加额度展示（`QuotaView` 或错误提示），常驻渲染
- 无额度且无错误时区域留空

## 验证清单

1. `curl "http://127.0.0.1:30143/api/quota?provider=<id>"` 形状正确、30s 内二次请求走缓存
2. 浏览器切到该提供商的模型，底栏出现额度文本；切到不支持的提供商区域留空
3. 发消息（流式中）额度让位给运行状态，结束后恢复
4. `tsc --noEmit` + `npx eslint <变更文件>` + `npm test`

## 已知约束

- 底栏通知槽 maxWidth `min(46vw, 480px)`（约 66 字符 mono），usage 型窗口数 ≤3 时放得下；
  更多窗口会省略号截断，悬停仍可看全量
- 失败不缓存：上游持续 5xx 时前端 `transient` 提示（有旧额度则保留展示），60s 后重试
- 无凭据（`no-credential`）/凭据失效（`auth`）明确提示，不静默
