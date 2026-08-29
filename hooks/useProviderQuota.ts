"use client";

import { useEffect, useRef, useState } from "react";
import type { QuotaInfo } from "@/hooks/useBroadcast";

/**
 * 当前模型提供商 → 顶栏额度展示（QuotaInfo）。
 * - opencode-go：三时间窗（5h/周/月），主条取最紧窗口，悬停看全部
 * - deepseek：余额 + 服务端算好的峰谷档位与下次切换时间
 * - commandcode：分时窗口（5h/周）用量百分比 + 主条剩余月度额度（余 $x.xx）
 * - 其他提供商返回 null（区域留空）
 */

const SUPPORTED_PROVIDERS = new Set(["opencode-go", "deepseek", "commandcode"]);
const POLL_MS = 60_000;

interface QuotaResponse {
  ok: boolean;
  quota?: QuotaPayload;
  error?: string;
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
        // commandcode 的“余”窗（剩余月度额度）行内显示 $ 金额而非百分比
        const isRemainder = w.label === "余";
        const amount = isRemainder ? Number(w.percent) : null;
        return {
          label: w.label,
          // 金额窗不参与健康色圆点（pct 无意义），置 0 使圆点呈绿色
          pct: isRemainder ? 0 : Math.max(0, Math.min(1, w.percent / 100)),
          // 行内仅百分比/金额，倒计时放悬停明细（多窗平铺时行内放不下）
          text: isRemainder ? `$${Number.isFinite(amount) ? amount!.toFixed(2) : "0.00"}` : `${w.percent}%`,
          detail: isRemainder
            ? `剩余月度额度 $${Number.isFinite(amount) ? amount!.toFixed(2) : "0.00"}`
            : [`${w.label}窗 ${w.percent}%`, resetIn && `剩 ${resetIn}`, `重置 ${resetLocal}`].filter(Boolean).join("，"),
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
 * 请求失败保留上一次结果（后端已有 30s 缓存与过期兜底，这里不再重试风暴）。
 */
export function useProviderQuota(provider: string | null | undefined): QuotaInfo | null {
  const supported = Boolean(provider && SUPPORTED_PROVIDERS.has(provider));
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const providerRef = useRef(provider);
  providerRef.current = provider;

  useEffect(() => {
    if (!supported || !provider) {
      setQuota(null);
      return;
    }

    let alive = true;

    const refresh = async () => {
      // 响应回来时若已切换提供商则丢弃，防止旧数据串台
      try {
        const res = await fetch(`/api/quota?provider=${encodeURIComponent(provider)}`);
        const data = (await res.json()) as QuotaResponse;
        if (!alive || providerRef.current !== provider) return;
        setQuota(data.ok && data.quota ? toQuotaInfo(data.quota) : null);
      } catch {
        // 网络失败保留现有展示，等下一轮询
      }
    };

    void refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [provider, supported]);

  return quota;
}
