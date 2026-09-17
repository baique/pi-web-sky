"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { PinnedMessageItem } from "@/lib/pin-store";

interface Props {
  item: PinnedMessageItem;
  zIndex: number;
  active: boolean;
  onClose: (id: string) => void;
  onActivate: (id: string) => void;
  onMove: (id: string, patch: { x?: number; y?: number; w?: number; h?: number }) => void;
}

const MIN_W = 180;
const MIN_H = 80;

type Mode = "move" | "resize";
interface DragState {
  mode: Mode;
  pointerId: number;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
}

/**
 * 钉卡：一张小玻璃卡（便笺内容区样式 + 边缘光晕），只渲染 markdown 内容。
 * - 四周留 padding：拖拽移动（grab 光标）+ 滚轮缩放（等比 w/h，光标锚点）
 * - 内容区：markdown 渲染 + 文字可选中复制（text 光标）；滚轮正常滚动内容
 * - 右下角 resize 手柄：自由调整 w/h
 * - 初始高度随内容自适应，缩放/resize 后固定、内容超出滚动
 * - 拖拽/resize 期间直写 DOM（不 setState），松手才提交 —— 零 React 重渲染，
 *   backdrop-filter 由合成器实时渲染卡片下方内容，背景即时跟随。
 */
export function PinnedBubble({ item, zIndex, active, onClose, onActivate, onMove }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [hovered, setHovered] = useState(false);

  // 滚轮缩放：四周 padding 区等比缩放；内容区滚轮原生滚动内容（不拦截）
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      // 内容区滚轮：原生滚动内容，不缩放
      if ((e.target as HTMLElement).closest("[data-pin-content]")) return;
      e.preventDefault();
      // 归一化 delta（line/page 模式换算成像素），再用指数映射成平滑缩放因子：
      // scale' = scale * e^(delta*k) —— 慢滚精细、快滚大幅、连续无跳变（d3-zoom 同款）
      // 负号：上滚（deltaY<0）放大、下滚缩小
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
      const factor = Math.exp(-d * 0.0015);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // 当前高度：已固定则用之；初始自适应态直接测量 DOM
      const curH = item.h ?? root.offsetHeight;
      const w = Math.min(Math.max(MIN_W, item.w * factor), vw * 0.92);
      const h = Math.min(Math.max(MIN_H, curH * factor), vh * 0.9);
      if (w === item.w && h === curH) return;
      // 光标锚点：缩放后光标下内容保持不动
      const px = (e.clientX - item.x) / item.w;
      const py = (e.clientY - item.y) / curH;
      const x = Math.min(Math.max(0, Math.round(e.clientX - px * w)), Math.max(0, vw - w));
      const y = Math.min(Math.max(0, Math.round(e.clientY - py * h)), Math.max(0, vh - h));
      onMove(item.id, { w: Math.round(w), h: Math.round(h), x, y });
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [item.w, item.x, item.y, item.h, item.id, onMove]);

  useEffect(
    () => () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    },
    [],
  );

  const startDrag = (mode: Mode, event: React.PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onActivate(item.id);
    const root = rootRef.current;
    if (!root) return;
    root.setPointerCapture(event.pointerId);
    dragRef.current = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origX: item.x,
      origY: item.y,
      origW: item.w,
      origH: item.h ?? root.offsetHeight,
    };
    document.body.style.cursor = mode === "move" ? "grabbing" : "nwse-resize";
    document.body.style.userSelect = "none";
  };

  const endDrag = (pointerId: number) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    dragRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    const root = rootRef.current;
    if (!root) return;
    const x = Number.parseFloat(root.style.left);
    const y = Number.parseFloat(root.style.top);
    // 仅移动模式直写 DOM、松手提交位置；resize 已逐帧 setState，无需重复提交
    if (drag.mode === "move" && !Number.isNaN(x) && !Number.isNaN(y)) {
      onMove(item.id, { x, y });
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    const root = rootRef.current;
    if (!drag || !root || drag.pointerId !== event.pointerId) return;
    if (event.pointerType === "mouse" && event.buttons === 0) {
      endDrag(event.pointerId);
      return;
    }
    event.preventDefault();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (drag.mode === "move") {
      const maxX = Math.max(0, vw - item.w);
      const maxY = Math.max(0, vh - root.offsetHeight);
      const x = Math.min(maxX, Math.max(0, drag.origX + event.clientX - drag.startX));
      const y = Math.min(maxY, Math.max(0, drag.origY + event.clientY - drag.startY));
      // 直写 DOM，松手才提交：拖拽零 React 重渲染
      root.style.left = `${x}px`;
      root.style.top = `${y}px`;
    } else {
      // resize：右下角手柄，w/h 自由调整
      const maxW = Math.max(MIN_W, vw - drag.origX);
      const maxH = Math.max(MIN_H, vh - drag.origY);
      const w = Math.min(maxW, Math.max(MIN_W, drag.origW + event.clientX - drag.startX));
      const h = Math.min(maxH, Math.max(MIN_H, drag.origH + event.clientY - drag.startY));
      onMove(item.id, { w: Math.round(w), h: Math.round(h) });
    }
  };

  const onPointerUp = (event: React.PointerEvent) => {
    endDrag(event.pointerId);
    try {
      rootRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
  };

  const onRootPointerDown = (event: React.PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const target = event.target as HTMLElement;
    const contentEl = rootRef.current?.querySelector<HTMLElement>("[data-pin-content]");
    const md = contentEl?.querySelector<HTMLElement>(".markdown-body");
    // markdown 文字元素上 → 放行选中；四周 padding / 内容空白 → 拖拽移动
    if (target.closest(".markdown-body") && target !== contentEl && target !== md) {
      onActivate(item.id);
      return;
    }
    startDrag("move", event);
  };

  return (
    <div
      ref={rootRef}
      data-pin-bubble
      tabIndex={0}
      onPointerDown={onRootPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "fixed",
        left: item.x,
        top: item.y,
        width: item.w,
        height: item.h ?? "auto",
        zIndex,
        display: "flex",
        flexDirection: "column",
        background: "var(--assistant-card-glass)",
        backdropFilter: "blur(var(--glass-blur-bubble)) saturate(var(--glass-saturate))",
        WebkitBackdropFilter: "blur(var(--glass-blur-bubble)) saturate(var(--glass-saturate))",
        border: "1px solid var(--bubble-border)",
        borderRadius: "var(--bubble-radius)",
        boxShadow: active
          ? "0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent), 0 0 18px 2px color-mix(in srgb, var(--accent) 22%, transparent), 0 8px 30px rgba(0,0,0,0.35)"
          : "0 0 0 1px color-mix(in srgb, var(--border) 30%, transparent), 0 0 14px 1px color-mix(in srgb, var(--text-muted) 14%, transparent), 0 8px 30px rgba(0,0,0,0.3)",
        color: "var(--text)",
        fontSize: 13,
        lineHeight: 1.5,
        overflow: "hidden",
        colorScheme: "dark",
        // 四周 padding 统一 14px：拖拽区和滚轮缩放区，视觉均匀
        padding: 14,
        cursor: "grab",
        touchAction: "none",
      }}
    >
      <div
        data-pin-content
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: item.h ? "auto" : "visible",
          userSelect: "text",
          cursor: "text",
          wordBreak: "break-word",
        }}
      >
        {item.content.trim() ? (
          <div className="markdown-body">
            <ReactMarkdown>{item.content}</ReactMarkdown>
          </div>
        ) : (
          <div style={{ color: "var(--text-muted)", fontSize: 12 }}>（空内容）</div>
        )}
      </div>

      {/* 关闭按钮：hover 卡片时显现 */}
      <button
        data-pin-close
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose(item.id);
        }}
        title="关闭"
        style={{
          position: "absolute",
          top: 4,
          right: 4,
          width: 22,
          height: 22,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          border: "none",
          borderRadius: 6,
          background: "color-mix(in srgb, var(--bg-panel) 70%, transparent)",
          color: "var(--text-muted)",
          cursor: "pointer",
          opacity: hovered ? 1 : 0,
          transition: "opacity 0.12s",
          boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      {/* Resize 手柄（右下角） */}
      <div
        data-pin-resize
        onPointerDown={(e) => startDrag("resize", e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: 20,
          height: 20,
          cursor: "nwse-resize",
          touchAction: "none",
        }}
        aria-label="调整大小"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--text-muted)"
          strokeWidth="2"
          strokeLinecap="round"
          style={{ position: "absolute", right: 3, bottom: 3, pointerEvents: "none", opacity: 0.8 }}
        >
          <path d="M14 20 20 14" />
          <path d="M14 14 20 20" />
          <path d="M8 20 20 8" />
        </svg>
      </div>
    </div>
  );
}
