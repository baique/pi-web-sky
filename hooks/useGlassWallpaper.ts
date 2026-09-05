"use client";

import { useEffect, useState } from "react";
import { useGlassScope } from "@/components/canvas/GlassScopeContext";

/**
 * 消息列表预模糊壁纸切片（只针对图片壁纸）。
 *
 * 生成一张「视口对齐的模糊壁纸」图，挂到 <html> 的 --glass-bg-image：
 * 气泡用 background-attachment: fixed 引用它，显示自己视口位置那一块。
 * 滚动时图是静态的 → 浏览器只 blit，零实时 blur 计算；气泡保持完整模糊，
 * 不降级显示效果。
 *
 * 触发重新生成：换壁纸 / offsetX 拖拽 / repeat / fill / bubbleBlur 滑块 / resize。
 * 无图片壁纸（含视频）时不生成，气泡/卡片纯色跟随主题（不写 backdrop-filter）。
 */

type GlassSettings = {
  offsetX: number;
  repeat: boolean;
  fill: boolean;
  bubbleBlur: number;
  /** 画布 scrim 磨砂强度（px）：卡片局部贴图跟随 scrim 档（任务卡 #17） */
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
 *  统一 120ms（与 PREVIEW_DEBOUNCE_MS 同档）：松手后快速生效，卡片图与
 *  scrim 实时 blur 的跟随延迟从 400ms 降到 120ms（任务卡 #17 体验优化）。 */
const REGEN_DEBOUNCE_MS = 120;

/** 拖动中气泡档实时预览的防抖间隔（ms）：停顿稍久就重算气泡模糊图，
 *  比全局提交的 400ms 更跟手，实现"边拖边预览"。 */
const PREVIEW_DEBOUNCE_MS = 120;

// 拖动中实时预览所需的模块级上下文（由 useGlassWallpaper 维护）
let lastBgUrl: string | null = null;
let lastSettings: GlassSettings | null = null;
let previewTimer: number | undefined;
let previewUrl: string | null = null;
let previewScrimUrl: string | null = null;
let previewGen = 0; // 递增版本号：旧的预览生成完成后丢弃，防止覆盖新图

/**
 * 拖动气泡滑块时的实时预览：并行重算气泡档（bubble）与卡片叠加档（scrim）
 * 模糊图，同时更新 --glass-bg-image / --glass-bg-image-scrim——气泡滑块同时
 * 影响全局气泡和卡片背景，拖拽中两张图都要跟手（任务卡 #17）。
 * 不碰 chrome（heavy 档），也不触发 AppShell 重渲染。
 * 防抖：连续拖动只重算最后一次；松手后的 updateWallSettings 才是最终提交。
 */
export function previewBubbleBlur(blur: number) {
  if (!lastBgUrl || !lastSettings) return;
  const gen = ++previewGen;
  if (previewTimer) window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(async () => {
    const st = lastSettings!;
    const [b, s] = await Promise.all([
      generateGlassImage(lastBgUrl!, Math.round(blur * BLUR_ATTENUATION), st, PREVIEW_RENDER_SCALE),
      // 卡片叠加档：拖动中的气泡值 + 当前 scrim 值
      generateGlassImage(lastBgUrl!, Math.round((blur + st.scrimBlur) * BLUR_ATTENUATION), st, PREVIEW_RENDER_SCALE),
    ]);
    if (gen !== previewGen) {
      // 已有更新的预览/正式生成，丢弃这次结果
      if (b) URL.revokeObjectURL(b);
      if (s) URL.revokeObjectURL(s);
      return;
    }
    const el = document.documentElement.style;
    if (b) {
      if (previewUrl && previewUrl !== b) URL.revokeObjectURL(previewUrl);
      previewUrl = b;
      el.setProperty("--glass-bg-image", `url("${b}")`);
    }
    if (s) {
      if (previewScrimUrl && previewScrimUrl !== s) URL.revokeObjectURL(previewScrimUrl);
      previewScrimUrl = s;
      el.setProperty("--glass-bg-image-scrim", `url("${s}")`);
    }
  }, PREVIEW_DEBOUNCE_MS);
}

function clearPreviewState() {
  previewGen++; // 使进行中的预览生成失效
  if (previewTimer) window.clearTimeout(previewTimer);
  previewTimer = undefined;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  if (previewScrimUrl) URL.revokeObjectURL(previewScrimUrl);
  previewScrimUrl = null;
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

/**
 * 生成器 hook：图片壁纸时生成模糊图并设置 --glass-bg-image，否则清除。
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
  // 无图时统一清理三类变量并回退 chrome 的 backdrop-filter。
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

  // 卡片局部贴图 = 背景气泡档真实值 + 画布 scrim 值，二者叠加（任务卡 #17）：
  // 气泡滑块（背景设置）与磨砂滑块（画布）都会影响卡片模糊；scrim=0 时
  // 退化为原气泡档观感。独立 effect 只随两滑块/壁纸几何变化重算，不牵连
  // 气泡/chrome 图——磨砂滑块拖动不会白白重算两张全视口图。
  useEffect(() => {
    const html = document.documentElement;
    if (!bgUrl || !isImage) {
      html.style.removeProperty("--glass-bg-image-scrim");
      return;
    }
    let cancelled = false;
    let scrimUrl: string | null = null;
    const run = async () => {
      // 0.75 为 canvas blur 相对 css blur 的视觉校准（与气泡档同一套）：
      // (bubbleBlur + scrimBlur)×0.75 ≈ 气泡视觉 + scrim 真实值叠加。
      const blur = Math.round((settings.bubbleBlur + settings.scrimBlur) * BLUR_ATTENUATION);
      const s = await generateGlassImage(bgUrl, blur, settings);
      if (cancelled) {
        if (s) URL.revokeObjectURL(s);
        return;
      }
      if (scrimUrl && scrimUrl !== s) URL.revokeObjectURL(scrimUrl);
      scrimUrl = s;
      if (s) html.style.setProperty("--glass-bg-image-scrim", `url("${s}")`);
      else html.style.removeProperty("--glass-bg-image-scrim");
    };
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
