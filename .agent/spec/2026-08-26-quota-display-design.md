# 余额查询功能（按提供商）— 设计

> 2026-08-26 · 提供商：opencode-go、deepseek · 展示位：底栏通知槽（NoticeInline 空闲态 P3；用户确认底部即可，顶栏预留位不用）

## 背景

composer-console 改造时已预留额度展示契约与渲染位，本期补数据链路：

- 契约：`hooks/useBroadcast.ts` 的 `QuotaInfo`（`balance` 文本型 / `usage` 条型）
- 渲染：`components/ComposerHeader.tsx` 的 `QuotaView`（空闲态显示，流式时让位给运行状态）

## 接口实测（2026-08-26，真实 key 锁定形状）

### opencode-go（分时限流，无金额无余额）

```
GET https://opencode.ai/zen/go/v1/usage   Authorization: Bearer <auth.json key>
→ {"usage":{"rolling":{"status":"ok","percent":24,"resetsAt":"2026-08-26T10:30:27.049Z"},
           "weekly":{...},"monthly":{"percent":95,...}}}
```

注意：嵌套在 `usage` 下；重置是 ISO 时间戳（非 resetInSec）；percent 0-100。

### deepseek（余额 + 峰谷计价）

```
GET https://api.deepseek.com/user/balance   Authorization: Bearer <auth.json key>
→ {"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"10.91",
   "granted_balance":"0.00","topped_up_balance":"10.91"}]}
```

峰谷规则：峰时 01:00–04:00、06:00–10:00 UTC（北京 09–12 / 14–18 点），其余时段 token 半价。

## 设计

### 后端 `app/api/quota/route.ts`

- `GET /api/quota?provider=<id>`，`isApiRequestAllowed` 守卫（沿用既有安全模式）
- 服务端直读 `~/.pi/agent/auth.json` 取 key，密钥不出服务端
- 内存缓存 30s/提供商，避免渲染频繁打上游；上游失败返回 `{ok:false,error}` 不缓存失败结果
- **ocg** → 返回三窗 `{rolling,weekly,monthly}` 的 percent + resetsAt + status
- **ds** → 返回 `{currency,totalBalance,isPeak,nextSwitchAt}`；峰谷由服务端按 UTC 计算

### 前端适配

- ChatWindow 内轻量 hook `hooks/useProviderQuota.ts`：
  - provider 变化时触发查询 + 60s 轮询；非 ocg/ds 返回 null（区域留空）
  - 映射为 `QuotaInfo` 传入 `useBroadcast({ quota })` → 空闲态经 NoticeInline 在底栏展示
- **ocg → usage 型**：三窗平铺纯文本 `5h 24% · 周 84% · 月 95%`（不用进度条，用户确认）；
  悬停 title 逐窗展示倒计时 + 重置时间
- **ds → balance 型**：`¥10.91 · 峰 · 18:00转谷 (1h19m)`
- QuotaView 小改：usage 分支多窗平铺 + title 悬停明细，样式不变（纯文本 mono，复用现有 token）

## 验证

tsc --noEmit + eslint 变更文件 + dev 起 playwright 目检两种提供商的展示与流式让位行为。
