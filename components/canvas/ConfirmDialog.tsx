"use client";

import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * 通用确认弹窗（命令式，Promise 化）：替换 window.confirm，项目统一样式。
 * const ok = await confirm({ message, ... }); // true=确认
 * 渲染 portal 到 body（避开 tldraw backdrop-filter 容器劫持，见 board-events.md）。
 */
export interface ConfirmOptions {
  title?: string;
  message: string;
  /** 确认按钮文案（默认「删除」） */
  confirmText?: string;
  /** 取消按钮文案（默认「取消」） */
  cancelText?: string;
  /** 危险操作（确认按钮红色）；默认 true */
  danger?: boolean;
}

type Resolver = (v: boolean) => void;

let resolver: Resolver | null = null;
let host: HTMLElement | null = null;
let root: Root | null = null;

function closeDialog(value: boolean) {
  resolver?.(value);
  resolver = null;
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
}

/** 全局命令式确认：await 返回是否确认。 */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // 若已有打开中的弹窗（连续触发），先关闭旧的
    if (resolver) closeDialog(false);
    resolver = resolve;
    let el = host;
    if (!el) {
      el = document.createElement("div");
      document.body.appendChild(el);
      host = el;
    }
    let r = root;
    if (!r) {
      r = createRoot(el);
      root = r;
    }
    // root 已挂在 body 的容器元素上，直接 render（无需再嵌套 portal）
    r.render(<DialogView opts={opts} onClose={closeDialog} />);
  });
}

function DialogView({
  opts,
  onClose,
}: {
  opts: ConfirmOptions;
  onClose: (v: boolean) => void;
}) {
  const [busy] = useState(false);
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      onPointerDown={() => onClose(false)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.35)",
      }}
    >
      <div
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          width: 360,
          maxWidth: "calc(100vw - 48px)",
          borderRadius: "var(--bubble-radius, 14px)",
          background: "var(--board-card-glass)",
          backdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
          WebkitBackdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
          border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
          boxShadow: "0 10px 40px -12px rgba(0,0,0,0.4)",
          color: "var(--text)",
          padding: "16px 18px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {opts.title && <div style={{ fontSize: 14, fontWeight: 600 }}>{opts.title}</div>}
        <div
          style={{
            fontSize: 12.5,
            lineHeight: 1.6,
            color: "var(--text-muted)",
            whiteSpace: "pre-wrap",
          }}
        >
          {opts.message}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
          <button
            type="button"
            onClick={() => onClose(false)}
            style={{
              border: "none",
              background: "color-mix(in srgb, var(--border) 30%, transparent)",
              color: "var(--text-muted)",
              borderRadius: 6,
              padding: "5px 14px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {opts.cancelText ?? "取消"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onClose(true)}
            style={{
              border: "none",
              background:
                opts.danger === false
                  ? "var(--accent)"
                  : "color-mix(in srgb, #ef4444 85%, transparent)",
              color: "#fff",
              borderRadius: 6,
              padding: "5px 14px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {opts.confirmText ?? "删除"}
          </button>
        </div>
      </div>
    </div>
  );
}
