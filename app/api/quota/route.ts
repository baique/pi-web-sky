import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/**
 * 按提供商查询余额/用量（设计见 .agent/spec/2026-08-26-quota-display-design.md）：
 * - opencode-go：GET /zen/go/v1/usage → 三时间窗（5h滚动/周/月）percent + resetsAt
 * - deepseek：GET /user/balance → 余额；峰谷由服务端按 UTC 计算
 * 密钥只从服务端 auth.json 读取，不落前端。结果内存缓存 30s，失败不缓存。
 */

const CACHE_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;

/** DeepSeek 峰时窗（UTC 小时区间，左闭右开）：01–04、06–10 */
const DS_PEAK_WINDOWS: [number, number][] = [
  [1, 4],
  [6, 10],
];

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
    if (isRecord(entry) && typeof entry.key === "string" && entry.key) return entry.key;
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

function nextPeakSwitch(now: Date): Date {
  // 候选切换点：今天与明天的每个峰时起止整点（UTC），取第一个晚于 now 的
  const candidates: number[] = [];
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    for (const [start, end] of DS_PEAK_WINDOWS) {
      for (const hour of [start, end]) {
        const d = new Date(now);
        d.setUTCDate(d.getUTCDate() + dayOffset);
        d.setUTCHours(hour, 0, 0, 0);
        if (d.getTime() > now.getTime()) candidates.push(d.getTime());
      }
    }
  }
  return new Date(Math.min(...candidates));
}

function isDeepSeekPeak(now: Date): boolean {
  const h = now.getUTCHours();
  return DS_PEAK_WINDOWS.some(([start, end]) => h >= start && h < end);
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
    nextSwitchAt: nextPeakSwitch(now).toISOString(),
  };
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
