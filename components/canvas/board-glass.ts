"use client";

import type { CSSProperties } from "react";

/**
 * 看板浮层玻璃（P0：MiniMap / 底部工具栏 / BoardTopbar 胶囊与面板等）。
 *
 * 浮层盖在动态画布上，若用实时 backdrop-filter，画布 pan/zoom/拖卡时每帧重算
 * blur，成本不可控。这里改用「卡片档预模糊贴图 + 色层」：色层
 * （--board-card-glass）保证文字可读，贴图（--glass-bg-image-card，由
 * useGlassWallpaper 生成）提供模糊壁纸观感——background-attachment: fixed
 * 视口对齐（浮层都在 RF viewport transform 容器外，与 scrim div 同条件）。
 *
 * 观感与画布卡片（useCardGlass 局部贴图）一致，画布交互期零实时 blur。
 * 无贴图（未生成/无壁纸）时回退纯色层——与无壁纸时卡片/原 blur 纯色观感一致。
 *
 * 用法：style={{ ...boardFloatGlass, border: ..., boxShadow: ..., color: ... }}
 * （不要用 background 简写覆盖 backgroundImage/backgroundAttachment。）
 */
export const boardFloatGlass: CSSProperties = {
  backgroundImage:
    "linear-gradient(var(--board-card-glass), var(--board-card-glass)), var(--glass-bg-image-card, var(--glass-bg-image, none))",
  backgroundAttachment: "fixed",
  backgroundSize: "100% 100%, 100% 100%",
  backgroundRepeat: "no-repeat, no-repeat",
  backgroundPosition: "0 0, 0 0",
};
