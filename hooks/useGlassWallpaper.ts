"use client";

import { useEffect, useState } from "react";
import { useGlassScope } from "@/components/canvas/GlassScopeContext";

/**
 * 消息列表预模糊壁纸切片（只针对图片壁纸）。
 *
 * 生成「视口对齐的模糊壁纸」图，挂到 <html> 的 CSS 变量：
 * - --glass-bg-image        气泡档（bubbleBlur）：消息气泡背景
 * - --glass-bg-image-heavy  chrome 档（固定 12px）：侧栏/顶栏等 chrome
 * - --glass-bg-image-scrim  画布 scrim 档（scrimBlur）：CanvasStage 的 scrim 层
 * - --glass-bg-image-card   卡片叠加档（bubbleBlur+scrimBlur）：画布卡片局部贴图
 *
 * 滚动/拖拽时图是静态的 → 浏览器只 blit，零实时 blur 计算；玻璃保持完整
 * 模糊，不降级显示效果。
 *
 * 画布 scrim 混合渲染（任务卡 #17）：磨砂滑块变化时，applyWallpaperCss 先写
 * --board-scrim-filter（实时 backdrop-filter）→ 即时反馈；本 hook 防抖异步生成
 * scrim/card 两张图，成功后摘掉 --board-scrim-filter → 稳态零实时 blur。
 * 滑块再动 → applyWallpaperCss 重新挂上 blur → 循环。视觉从 blur 切换到
 * canvas 预模糊图（×0.75 校准），同一帧完成，几乎无跳变。
 *
 * 触发重新生成：换壁纸 / offsetX 拖拽 / repeat / fill / bubbleBlur / scrimBlur
 * 滑块 / resize。无图片壁纸时不生成，气泡/卡片/chrome/scrim 各自回退
 * （纯色跟随主题 / 保留 backdrop-filter）。
 */

type GlassSettings = {
  offsetX: number;
  repeat: boolean;
  fill: boolean;
  bubbleBlur: number;
  /** 画布 scrim 磨砂强度（px）：scrim 层档 + 卡片叠加档（任务卡 #17） */
  scrimBlur: number;
};

/** chrome 档模糊半径，与 globals.css 的 --glass-blur-heavy 保持一致（12px）。 */
const HEAVY_BLUR = 12;
const BLUR_ATTENUATION = 0.75;
const PREVIEW_RENDER_SCALE = 0.25;

/** 生成降采样比例：模糊图对清晰度不敏感，输出降采样后成本大幅下降（显示时
 *  100% 拉伸，模糊视觉几乎无差异）。 */
const RENDER_SCALE = 0.5;

/** 重新生成防抖间隔（ms）：拖动滑块/拖 offsetX 期间不生成，停顿后才生成一次。
 *  与 PREVIEW_DEBOUNCE_MS 同档：松手后快速生效（任务卡 #17 体验优化）。 */
const REGEN_DEBOUNCE_MS = 120;

/** 拖动中实时预览的防抖间隔（ms）：停顿稍久就重算，实现"边拖边预览"。 */
const PREVIEW_DEBOUNCE_MS = 120;

// 拖动中实时预览所需的模块级上下文（由 useGlassWallpaper 维护）
let lastBgUrl: string | null = null;
let lastSettings: GlassSettings | null = null;
let previewTimer: number | undefined;
let previewUrl: string | null = null;
let previewCardUrl: string | null = null;
let previewGen = 0; // 递增版本号：旧的预览生成完成后丢弃，防止覆盖新图

/**
 * 拖动气泡滑块时的实时预览：并行重算气泡档（bubble）与卡片叠加档（card）
 * 模糊图，同时更新 --glass-bg-image / --glass-bg-image-card——气泡滑块同时
 * 影响全局气泡和卡片背景，拖拽中两张图都要跟手。
 * 不碰 chrome（heavy 档）与画布 scrim 层图（--glass-bg-image-scrim 不依赖
 * 气泡，scrim 滑块变化时才重算），也不触发 AppShell 重渲染。
 * 防抖：连续拖动只重算最后一次；松手后的 updateWallSettings 才是最终提交。
 */
export function previewBubbleBlur(blur: number) {
  if (!lastBgUrl || !lastSettings) return;
  const gen = ++previewGen;
  if (previewTimer) window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(async () => {
    const st = lastSettings!;
    const [b, c] = await Promise.all([
      generateGlassImage(lastBgUrl!, Math.round(blur * BLUR_ATTENUATION), st, PREVIEW_RENDER_SCALE),
      // 卡片叠加档：拖动中的气泡值 + 当前 scrim 值
      generateGlassImage(lastBgUrl!, Math.round((blur + st.scrimBlur) * BLUR_ATTENUATION), st, PREVIEW_RENDER_SCALE),
    ]);
    if (gen !== previewGen) {
      // 已有更新的预览/正式生成，丢弃这次结果
      if (b) URL.revokeObjectURL(b);
      if (c) URL.revokeObjectURL(c);
      return;
    }
    const el = document.documentElement.style;
    if (b) {
      if (previewUrl && previewUrl !== b) URL.revokeObjectURL(previewUrl);
      previewUrl = b;
      el.setProperty("--glass-bg-image", `url("${b}")`);
    }
    if (c) {
      if (previewCardUrl && previewCardUrl !== c) URL.revokeObjectURL(previewCardUrl);
      previewCardUrl = c;
      el.setProperty("--glass-bg-image-card", `url("${c}")`);
    }
  }, PREVIEW_DEBOUNCE_MS);
}

function clearPreviewState() {
  previewGen++; // 使进行中的预览生成失效
  if (previewTimer) window.clearTimeout(previewTimer);
  previewTimer = undefined;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  if (previewCardUrl) URL.revokeObjectURL(previewCardUrl);
  previewCardUrl = null;
}

/** 当前是否有玻璃壁纸图（供 MessageView 切换 backdrop-filter 用）。 */
let glassActive = false;
const subs = new Set<(v: boolean) => void>();

function setGlassActive(v: boolean) {
  glassActive = v;
  for (const s of subs) s(v);
}

export function useGlassActive(): boolean {
  const [v, setV] = useState(glassActive);
  const scope = useGlassScope();
  useEffect(() => {
    subs.add(setV);
    return () => {
      subs.delete(setV);
    };
  }, []);
  // 画布内（tldraw transform 容器）气泡自铺壁纸会变「每气泡独立壁纸”
  // （fixed 失效）；由卡片局部贴图提供模糊，气泡只留色层透出。
  return scope === "board" ? false : v;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth ? img : null);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * 生成视口对齐的模糊壁纸图。
 * - 画布比视口大 2×pad（pad=blur）并平铺壁纸，保证模糊时边缘能采样到壁纸
 *   像素，不会出现暗边/透明带。
 * - cover 尺寸相对视口、水平偏移 offsetX，与 body 壁纸绘制一致。
 * - 输出按 devicePixelRatio 高清。
 */
async function generateGlassImage(
  bgUrl: string,
  blur: number,
  s: GlassSettings,
  renderScale: number = RENDER_SCALE,
): Promise<string | null> {
  // dpr 含降采样：分辨率 = 视口 × devicePixelRatio × renderScale
  const dpr = (window.devicePixelRatio || 1) * renderScale;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pad = Math.max(1, Math.ceil(blur));

  const img = await loadImage(bgUrl);
  if (!img) return null;

  const scale = Math.max(vw / img.naturalWidth, vh / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  const bw = vw + pad * 2;
  const bh = vh + pad * 2;

  // 离屏：平铺壁纸铺满 buffer（cover 不足的边缘用相邻副本填充，近似无缝）
  const src = document.createElement("canvas");
  src.width = Math.round(bw * dpr);
  src.height = Math.round(bh * dpr);
  const sctx = src.getContext("2d");
  if (!sctx) return null;
  sctx.scale(dpr, dpr);
  const baseDx = (bw - dw) / 2 + s.offsetX;
  const baseDy = (bh - dh) / 2;
  for (let y = Math.floor(-baseDy / dh) - 1; baseDy + y * dh < bh + 1; y++) {
    for (let x = Math.floor(-baseDx / dw) - 1; baseDx + x * dw < bw + 1; x++) {
      sctx.drawImage(img, baseDx + x * dw, baseDy + y * dh, dw, dh);
    }
  }

  // 输出：从 buffer 裁剪视口区域，应用模糊
  const out = document.createElement("canvas");
  out.width = Math.round(vw * dpr);
  out.height = Math.round(vh * dpr);
  const octx = out.getContext("2d");
  if (!octx) return null;
  if (blur > 0) octx.filter = `blur(${blur}px)`;
  octx.drawImage(
    src,
    pad * dpr,
    pad * dpr,
    vw * dpr,
    vh * dpr,
    0,
    0,
    out.width,
    out.height,
  );

  const blob = await new Promise<Blob | null>((res) => out.toBlob(res, "image/png"));
  return blob ? URL.createObjectURL(blob) : null;
}

/** 摘掉画布 scrim 的实时 backdrop-filter（混合渲染：贴图就绪后切稳态）。 */
function clearScrimFilter() {
  const el = document.documentElement.style;
  el.setProperty("--board-scrim-filter", "none");
}

/**
 * 生成器 hook：图片壁纸时生成模糊图并设置各 CSS 变量，否则清除。
 * 同时把「有无玻璃图」同步给 useGlassActive 订阅者（气泡/卡片据此决定
 * 是否叠壁纸图；画布内由 useGlassScope 强制不叠，见 GlassScopeContext）。
 */
export function useGlassWallpaper(
  bgUrl: string | null,
  isImage: boolean,
  settings: GlassSettings,
  resizeTick: number = 0,
) {
  // bubble 档（--glass-bg-image）：消息气泡预模糊壁纸 + 记录预览上下文。
  // 无图时统一清理四类变量并回退 chrome 的 backdrop-filter。
  useEffect(() => {
    const html = document.documentElement;
    // 记录模块级上下文，供拖动中 previewBubbleBlur 使用
    lastBgUrl = bgUrl;
    lastSettings = settings;
    if (!bgUrl || !isImage) {
      clearPreviewState();
      html.style.removeProperty("--glass-bg-image");
      html.style.removeProperty("--glass-bg-image-heavy");
      html.style.removeProperty("--glass-bg-image-scrim");
      html.style.removeProperty("--glass-bg-image-card");
      // 无图时 chrome 回退原 backdrop-filter（组件内联 blur 配方）
      setGlassActive(false);
      return;
    }
    let cancelled = false;
    let bubbleUrl: string | null = null;
    const run = async () => {
      const blur = Math.round(settings.bubbleBlur * BLUR_ATTENUATION);
      const b = await generateGlassImage(bgUrl, blur, settings);
      if (cancelled) {
        if (b) URL.revokeObjectURL(b);
        return;
      }
      if (bubbleUrl && bubbleUrl !== b) URL.revokeObjectURL(bubbleUrl);
      bubbleUrl = b;
      if (b) html.style.setProperty("--glass-bg-image", `url("${b}")`);
      else html.style.removeProperty("--glass-bg-image");
      setGlassActive(!!b);
    };
    // 防抖：连续变化（滑块拖动/拖 offsetX）期间不生成，停顿后才生成一次
    const timer = window.setTimeout(run, REGEN_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      clearPreviewState();
    };
  }, [bgUrl, isImage, settings.offsetX, settings.repeat, settings.fill, settings.bubbleBlur, resizeTick]);

  // chrome 档（--glass-bg-image-heavy，固定 12px）：侧栏/顶栏等 chrome 预模糊壁纸。
  // 独立 effect 且不依赖 bubbleBlur——气泡滑块变化不重算它（fixed 档与气泡无关）。
  useEffect(() => {
    const html = document.documentElement;
    if (!bgUrl || !isImage) {
      html.style.removeProperty("--glass-bg-image-heavy");
      return;
    }
    let cancelled = false;
    let heavyUrl: string | null = null;
    const run = async () => {
      const blur = Math.round(HEAVY_BLUR * BLUR_ATTENUATION);
      const h = await generateGlassImage(bgUrl, blur, settings);
      if (cancelled) {
        if (h) URL.revokeObjectURL(h);
        return;
      }
      if (heavyUrl && heavyUrl !== h) URL.revokeObjectURL(heavyUrl);
      heavyUrl = h;
      if (h) html.style.setProperty("--glass-bg-image-heavy", `url("${h}")`);
      else html.style.removeProperty("--glass-bg-image-heavy");
    };
    const timer = window.setTimeout(run, REGEN_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [bgUrl, isImage, settings.offsetX, settings.repeat, settings.fill, resizeTick]);

  // 画布 scrim 层图（--glass-bg-image-scrim，blur = scrimBlur）+ 卡片叠加图
  // （--glass-bg-image-card，blur = bubbleBlur + scrimBlur）双图生成（任务卡 #17）。
  // 磨砂滑块变化时两张图都重算；卡片叠加图在气泡滑块变化时也重算。
  // 两张图都生成成功后摘掉 --board-scrim-filter（实时 blur → 稳态贴图）；
  // 失败（无图/取消）不清 filter，保留实时 blur 兜底。
  //
  // 磨砂为 0（默认）：scrim 层不挂切片图——0.5× 降采样切片被拉伸放大后比
  // 原始壁纸糊（RENDER_SCALE 半分辨率）；此时层只留透明底色
  // （--board-scrim-alpha=0），壁纸原样透出。卡片叠加图仍按气泡值生成。
  useEffect(() => {
    const html = document.documentElement;
    if (!bgUrl || !isImage) {
      html.style.removeProperty("--glass-bg-image-scrim");
      html.style.removeProperty("--glass-bg-image-card");
      return;
    }
    let cancelled = false;
    let scrimUrl: string | null = null;
    let cardUrl: string | null = null;
    const run = async () => {
      // 0.75 为 canvas blur 相对 css blur 的视觉校准：canvas 预模糊与 css
      // backdrop-filter 观感对齐，切换瞬间不跳变。
      const scrimBlur = Math.round(settings.scrimBlur * BLUR_ATTENUATION);
      const cardBlur = Math.round((settings.bubbleBlur + settings.scrimBlur) * BLUR_ATTENUATION);
      // 磨砂为 0：只生成卡片叠加图，scrim 层图保持摘除（壁纸原样透出）
      if (settings.scrimBlur <= 0) {
        const c = await generateGlassImage(bgUrl, cardBlur, settings);
        if (cancelled) {
          if (c) URL.revokeObjectURL(c);
          return;
        }
        if (cardUrl && cardUrl !== c) URL.revokeObjectURL(cardUrl);
        cardUrl = c;
        if (c) html.style.setProperty("--glass-bg-image-card", `url("${c}")`);
        else html.style.removeProperty("--glass-bg-image-card");
        return;
      }
      const [s, c] = await Promise.all([
        generateGlassImage(bgUrl, scrimBlur, settings),
        generateGlassImage(bgUrl, cardBlur, settings),
      ]);
      if (cancelled) {
        if (s) URL.revokeObjectURL(s);
        if (c) URL.revokeObjectURL(c);
        return;
      }
      if (scrimUrl && scrimUrl !== s) URL.revokeObjectURL(scrimUrl);
      if (cardUrl && cardUrl !== c) URL.revokeObjectURL(cardUrl);
      scrimUrl = s;
      cardUrl = c;
      if (s) html.style.setProperty("--glass-bg-image-scrim", `url("${s}")`);
      else html.style.removeProperty("--glass-bg-image-scrim");
      if (c) html.style.setProperty("--glass-bg-image-card", `url("${c}")`);
      else html.style.removeProperty("--glass-bg-image-card");
      // 稳态切换：两张图都就绪才摘实时 blur；任一失败保留 blur 兜底
      if (s && c) clearScrimFilter();
    };
    // 磨砂为 0：立即摘 scrim 层图（不等防抖），避免残留切片拉伸发糊
    if (settings.scrimBlur <= 0) {
      html.style.removeProperty("--glass-bg-image-scrim");
    }
    const timer = window.setTimeout(run, REGEN_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [bgUrl, isImage, settings.offsetX, settings.repeat, settings.fill, settings.bubbleBlur, settings.scrimBlur, resizeTick]);
}

/** 视口尺寸变化（resize）时触发重新生成。由 AppShell 组合进 useGlassWallpaper。 */
export function useGlassResizeTrigger(active: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    let t: number | undefined;
    const onResize = () => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => setTick((x) => x + 1), 250);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (t) window.clearTimeout(t);
    };
  }, [active]);
  return tick;
}
