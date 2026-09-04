"use client";

import { useEffect, useRef, useState } from "react";
import type { QuotaInfo } from "@/hooks/useBroadcast";

/**
 * 当前模型提供商 → 顶栏额度展示（QuotaInfo）。
 * - opencode-go：三时间窗（5h/周/月）
 * - deepseek：余额 + 服务端算好的峰谷档位与下次切换时间
 * - commandcode：三时间窗（5h/周/月），与 opencode-go 同构
 * - 其他提供商返回 null（区域留空）
 * 查询失败返回 error 分类（auth=凭据失效 / no-credential=未登录 / transient=瞬时故障），供常驻位提示。
 */

const SUPPORTED_PROVIDERS = new Set(["opencode-go", "deepseek", "commandcode"]);
const POLL_MS = 60_000;

export type QuotaErrorKind = "auth" | "no-credential" | "transient";

export interface QuotaResult {
  /** 最近一次成功额度；无则 null */
  quota: QuotaInfo | null;
  /** 最近一次失败分类；成功或未查询过则为 null */
  error: QuotaErrorKind | null;
}

interface QuotaResponse {
  ok: boolean;
  quota?: QuotaPayload;
  error?: string;
  status?: number | null;
}

type QuotaPayload =
  | { kind: "usage"; windows: { label: string; percent: number; status: string; resetsAt: string }[] }
  | { kind: "balance"; currency: string; totalBalance: string; isPeak: boolean; nextSwitchAt: string };

/** 紧凑倒计时：2h10m / 3d4h / 45s；过期或无效返回空串 */
export function formatResetIn(resetsAt: string, now = Date.now()): string {
  const ts = Date.parse(resetsAt);
  if (!Number.isFinite(ts)) return "";
  let sec = Math.round((ts - now) / 1000);
  if (sec <= 0) return "";
  const d = Math.floor(sec / 86400);
  sec %= 86400;
  const h = Math.floor(sec / 3600);
  sec %= 3600;
  const m = Math.floor(sec / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${Math.max(m, 1)}m`;
}

function currencySymbol(code: string): string {
  if (code === "CNY") return "¥";
  if (code === "USD") return "$";
  return code ? `${code} ` : "";
}

function toQuotaInfo(payload: QuotaPayload, now = Date.now()): QuotaInfo | null {
  if (payload.kind === "usage") {
    const items = payload.windows
      .map((w) => {
        const resetLocal = (() => {
          const ts = Date.parse(w.resetsAt);
          return Number.isFinite(ts) ? new Date(ts).toLocaleString() : "—";
        })();
        const resetIn = formatResetIn(w.resetsAt, now);
        return {
          label: w.label,
          pct: Math.max(0, Math.min(1, w.percent / 100)),
          // 行内仅百分比，倒计时放悬停明细（多窗平铺时行内放不下）
          text: `${w.percent}%`,
          detail: [`${w.label}窗 ${w.percent}%`, resetIn && `剩 ${resetIn}`, `重置 ${resetLocal}`].filter(Boolean).join("，"),
        };
      });
    if (items.length === 0) return null;
    return { kind: "usage", items };
  }
  const tier = payload.isPeak ? "峰" : "谷(半价)";
  const resetIn = formatResetIn(payload.nextSwitchAt, now);
  // 切换时刻的本地 HH:mm 比倒计时更直观（峰谷以整点翻转）
  const hhmm = (() => {
    const ts = Date.parse(payload.nextSwitchAt);
    if (!Number.isFinite(ts)) return "";
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  })();
  const switchText = [hhmm && `${hhmm}${payload.isPeak ? "转谷" : "转峰"}`, resetIn && `(${resetIn})`].filter(Boolean).join(" ");
  return {
    kind: "balance",
    text: [`${currencySymbol(payload.currency)}${payload.totalBalance}`, tier, switchText].filter(Boolean).join(" · "),
  };
}

/**
 * 拉取并轮询当前提供商的额度。provider 为空或不支持时静默返回 null。
 * 失败分类：
 * - auth（401/403）：凭据失效 → 清空额度并返回 error（供常驻位提示重新登录）
 * - no-credential：未登录 → 同上
 * - transient（网络/5xx/超时）：保留上一次成功额度，error 置 transient（低调提示）
 */
export function useProviderQuota(provider: string | null | undefined): QuotaResult {
  const supported = Boolean(provider && SUPPORTED_PROVIDERS.has(provider));
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [error, setError] = useState<QuotaErrorKind | null>(null);
  const providerRef = useRef(provider);
  providerRef.current = provider;

  useEffect(() => {
    if (!supported || !provider) {
      setQuota(null);
      setError(null);
      return;
    }

    let alive = true;

    const refresh = async () => {
      // 响应回来时若已切换提供商则丢弃，防止旧数据串台
      try {
        const res = await fetch(`/api/quota?provider=${encodeURIComponent(provider)}`);
        const data = (await res.json()) as QuotaResponse;
        if (!alive || providerRef.current !== provider) return;
        if (data.ok && data.quota) {
          setQuota(toQuotaInfo(data.quota));
          setError(null);
        } else {
          const kind: QuotaErrorKind =
            data.status === 401 || data.status === 403
              ? "auth"
              : data.error === "no credential for provider"
                ? "no-credential"
                : "transient";
          // 凭据失效/未登录：旧数据无意义，清空并提示；瞬时故障：保留旧展示
          if (kind === "auth" || kind === "no-credential") {
            setQuota(null);
            setError(kind);
          } else {
            setError(kind);
          }
        }
      } catch {
        // 网络失败保留现有展示，等下一轮询
        if (!alive || providerRef.current !== provider) return;
        setError("transient");
      }
    };

    // 链式调度：上一次完成后再排下一次（响应慢自动降频，绝不叠加堆积）。
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      await refresh();
      if (alive) timer = setTimeout(loop, POLL_MS);
    };
    void loop();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [provider, supported]);

  return { quota, error };
}
