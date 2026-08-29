import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isApiRequestAllowed } from "@/lib/request-security";
import { isDeepSeekPeak, nextDeepSeekSwitch } from "@/lib/deepseek-pricing";

export const dynamic = "force-dynamic";

/**
 * 按提供商查询余额/用量（设计见 .agent/spec/2026-08-26-quota-display-design.md）：
 * - opencode-go：GET /zen/go/v1/usage → 三时间窗（5h滚动/周/月）percent + resetsAt
 * - deepseek：GET /user/balance → 余额；峰谷由服务端按 UTC 计算
 * - commandcode：GET /alpha/whoami + /alpha/billing/credits → 月度额度 + 分时窗口（5h/周）
 *   凭据为 OAuth access token（auth.json {type:"oauth",access}），非 api key
 * 密钥只从服务端 auth.json 读取，不落前端。结果内存缓存 30s，失败不缓存。
 */

const CACHE_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;

type QuotaPayload =
  | {
      kind: "usage";
      windows: { label: string; percent: number; status: string; resetsAt: string }[];
    }
  | {
      kind: "balance";
      currency: string;
      totalBalance: string;
      /** 当前是否峰时（半价谷时的反面） */
      isPeak: boolean;
      /** 下次峰谷切换的 ISO 时间 */
      nextSwitchAt: string;
    };

const cache = new Map<string, { at: number; data: QuotaPayload }>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProviderKey(provider: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf-8"));
    if (!isRecord(parsed)) return null;
    const entry = parsed[provider];
    if (!isRecord(entry)) return null;
    // 常规 API key；commandcode 走 OAuth access token（auth.json 存 {type:"oauth",access}）
    if (typeof entry.key === "string" && entry.key) return entry.key;
    if (entry.type === "oauth" && typeof entry.access === "string" && entry.access) return entry.access;
  } catch {
    // auth.json 缺失或损坏按无 key 处理
  }
  return null;
}

async function fetchJson(url: string, key: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function parseOcgUsage(data: unknown): QuotaPayload {
  if (!isRecord(data) || !isRecord(data.usage)) throw new Error("ocg usage: unexpected shape");
  const usage = data.usage;
  const windows: { label: string; percent: number; status: string; resetsAt: string }[] = [];
  for (const [key, label] of [["rolling", "5h"], ["weekly", "周"], ["monthly", "月"]] as const) {
    const w = usage[key];
    if (!isRecord(w)) continue;
    const percent = typeof w.percent === "number" ? w.percent : typeof w.usagePercent === "number" ? w.usagePercent : null;
    if (percent == null) continue;
    windows.push({
      label,
      percent,
      status: typeof w.status === "string" ? w.status : "unknown",
      resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : typeof w.resetInSec === "number" ? new Date(Date.now() + w.resetInSec * 1000).toISOString() : "",
    });
  }
  if (windows.length === 0) throw new Error("ocg usage: no usable window");
  return { kind: "usage", windows };
}

function parseDeepSeekBalance(data: unknown): QuotaPayload {
  if (!isRecord(data) || !Array.isArray(data.balance_infos)) throw new Error("ds balance: unexpected shape");
  const info = data.balance_infos.find(isRecord);
  if (!info || typeof info.total_balance !== "string") throw new Error("ds balance: no balance_infos entry");
  const now = new Date();
  return {
    kind: "balance",
    currency: typeof info.currency === "string" ? info.currency : "",
    totalBalance: info.total_balance,
    isPeak: isDeepSeekPeak(now),
    nextSwitchAt: nextDeepSeekSwitch(now).toISOString(),
  };
}

/** 毫秒时间戳 → ISO 字符串（credit resetAt 为毫秒，其他上游可能给秒，统一防御） */
function normalizeTs(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // ≥1e12 视为毫秒，否则视为秒
    return new Date(value >= 1e12 ? value : value * 1000).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const ts = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Date.parse(value.trim());
    if (Number.isFinite(ts) && ts > 0) return new Date(ts >= 1e12 ? ts : ts * 1000).toISOString();
  }
  return "";
}

/**
 * commandcode：月度额度（剩余 $） + 分时窗口（5h / 周，cap 内用量百分比）。
 * 实测形状（2026-08-29）：
 * credits: { monthlyCredits, purchasedCredits, freeCredits }
 * windowLimits: { fiveHour:{used,cap,resetAt(ms)}, weekly:{used,cap,resetAt(ms)} }
 * summary: { totalCost, totalCount }
 */
function parseCommandCode(data: unknown): QuotaPayload {
  if (!isRecord(data) || !isRecord(data.credits)) throw new Error("cc credits: unexpected shape");
  const credits = data.credits;
  const monthly =
    typeof credits.monthlyCredits === "number" ? credits.monthlyCredits : 0;
  const summary = isRecord(data.summary)
    ? data.summary
    : isRecord(data.usage) && isRecord(data.usage.summary)
      ? data.usage.summary
      : null;
  const spent = summary && typeof summary.totalCost === "number" ? summary.totalCost : 0;
  const pool = monthly + spent;

  const windows: { label: string; percent: number; status: string; resetsAt: string }[] = [];
  const wl = isRecord(data.windowLimits) ? data.windowLimits : null;
  for (const [key, label] of [
    ["fiveHour", "5h"],
    ["weekly", "周"],
  ] as const) {
    const w = wl && isRecord(wl[key]) ? wl[key] : null;
    if (!w) continue;
    const used = typeof w.used === "number" ? w.used : 0;
    const cap = typeof w.cap === "number" ? w.cap : 0;
    if (!(cap > 0)) continue;
    windows.push({
      label,
      percent: Math.round((used / cap) * 100),
      status: "ok",
      resetsAt: normalizeTs(w.resetAt),
    });
  }
  if (windows.length === 0) throw new Error("cc credits: no window limit");

  // 主条把剩余月度额度带上（5h 40% · 周 20% · 余 $7.70）——行内紧凑，放得下
  // 约定：percent 字段承载金额数值，前端按 label==="余" 渲染为 $ 金额
  if (pool > 0) {
    windows.push({
      label: "余",
      percent: monthly,
      status: "ok",
      resetsAt: "",
    });
  }
  return { kind: "usage", windows };
}

async function queryQuota(provider: string): Promise<QuotaPayload> {
  const key = readProviderKey(provider);
  if (!key) throw new Error("no credential for provider");

  if (provider === "opencode-go") {
    return parseOcgUsage(await fetchJson("https://opencode.ai/zen/go/v1/usage", key));
  }
  if (provider === "deepseek") {
    return parseDeepSeekBalance(await fetchJson("https://api.deepseek.com/user/balance", key));
  }
  if (provider === "commandcode") {
    const base = "https://api.commandcode.ai";
    // whoami → orgId（个人账号为 null，此时不传 orgId）
    const whoami = (await fetchJson(`${base}/alpha/whoami`, key)) as Record<string, unknown>;
    const orgId = isRecord(whoami.org) && typeof whoami.org.id === "string" ? whoami.org.id : null;
    const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
    const [creditsRaw, summaryRaw] = await Promise.all([
      fetchJson(`${base}/alpha/billing/credits${qs}`, key),
      fetchJson(`${base}/alpha/usage/summary${qs}`, key),
    ]);
    return parseCommandCode({ ...(creditsRaw as object), summary: summaryRaw });
  }
  throw new Error(`unsupported provider: ${provider}`);
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ ok: false, error: "Untrusted API request" }, { status: 403 });
  }

  const provider = new URL(req.url).searchParams.get("provider")?.trim() ?? "";
  if (!provider) return NextResponse.json({ ok: false, error: "provider is required" }, { status: 400 });

  const hit = cache.get(provider);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json({ ok: true, quota: hit.data });
  }

  try {
    const quota = await queryQuota(provider);
    cache.set(provider, { at: Date.now(), data: quota });
    return NextResponse.json({ ok: true, quota });
  } catch (error) {
    // 过期缓存兜底：上游偶发失败时先展示旧数据
    if (hit) return NextResponse.json({ ok: true, quota: hit.data });
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
