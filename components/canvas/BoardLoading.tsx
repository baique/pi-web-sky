"use client";

/**
 * 看板加载中遮罩（统一组件）。
 *
 * 三处加载态共用同一观感，从视觉上合并成「一段连续加载」：
 *   - AppShell 的 SessionCanvas 动态 chunk 加载
 *   - SessionCanvas 的 CanvasStage 动态 chunk 加载
 *   - CanvasStage 的 board.loading（yjs 同步/看板元信息）
 *
 * 样式 token（--board-loading-*）在 globals.css 定义：与 scrim 同源的黑色半透明，
 * 深浅主题都用深色；文字用浅色常量（遮罩是深色，浅色文字在两主题下都清晰）。
 */
export function BoardLoading({ label }: { label: string }) {
  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--board-loading-bg)",
        color: "var(--board-loading-text)",
        fontSize: 13,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            border: "2px solid color-mix(in srgb, var(--board-loading-text) 20%, transparent)",
            borderTopColor: "var(--board-loading-text)",
            animation: "spin 0.8s linear infinite",
          }}
        />
        {label}
      </div>
    </div>
  );
}
