"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, type Editor, type TLShape } from "tldraw";
import { SessionWorkbench } from "./SessionWorkbench";
import type { SessionCardShape } from "./SessionCardShape";
import { useI18n } from "@/hooks/useI18n";

/**
 * 展开工作台浮层：portal 到画布容器内（不受画布 transform 影响），
 * 位置由 editor.pageToScreen 换算 + rAF 跟手，内容按 1/zoom 反补偿保持恒常 UI 尺寸。
 * zoom < 60% 自动降级骨架态。
 */
export function WorkbenchOverlay({ container }: { container: HTMLElement | null }) {
  const editor = useEditor();
  const [expandedShapes, setExpandedShapes] = useState<TLShape[]>([]);
  const [mounted, setMounted] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [rects, setRects] = useState<Record<string, DOMRect>>({});
  const [containerRect, setContainerRect] = useState<DOMRect | null>(null);
  const rafRef = useRef<number | null>(null);
  const { t } = useI18n();

  useEffect(() => { setMounted(true); }, []);

  // 监听 container 尺寸/位置（滚动、resize 时 rect 变化）
  useEffect(() => {
    if (!container) return;
    const update = () => setContainerRect(container.getBoundingClientRect());
    update();
    const ro = new ResizeObserver(update);
    ro.observe(container);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => { ro.disconnect(); window.removeEventListener("scroll", update, true); window.removeEventListener("resize", update); };
  }, [container]);

  // 监听 store 变化，收集当前展开的 session-card shape
  useEffect(() => {
    const update = () => {
      const expanded = editor.getCurrentPageShapes().filter((s) =>
        s.type === "session-card" && (s.props as { expanded?: boolean }).expanded,
      );
      console.log("[board] workbench expanded:", expanded.length, expanded.map(s => s.id));
      setExpandedShapes(expanded);
    };
    update();
    const unlisten = editor.store.listen(update);
    return () => { unlisten?.(); };
  }, [editor]);

  // rAF 跟手：相机/形状变化时刷新位置和 zoom
  useEffect(() => {
    const schedule = () => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const cam = editor.getCamera();
        setZoom(cam.z);
        const next: Record<string, DOMRect> = {};
        for (const shape of expandedShapes) {
          const screen = editor.pageToScreen({ x: shape.x, y: shape.y });
          const sx = screen.x;
          const sy = screen.y;
          const props = shape.props as { w: number; h: number };
          next[shape.id] = new DOMRect(sx, sy, props.w * cam.z, props.h * cam.z);
        }
        setRects(next);
      });
    };
    const unlisten = editor.store.listen(schedule);
    schedule();
    return () => {
      unlisten?.();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [editor, expandedShapes]);

  // 单例：当前只支持 1 张展开卡（spec：同会话只允许一张）
  const active = expandedShapes[0] as SessionCardShape | undefined;
  const restCount = expandedShapes.length - 1;

  // 渲到 document.body：用 viewport 坐标（左上 + pageToScreen），
  // 不挂在任何可能被 transform/overflow 影响的容器内。
  const overlay = useMemo(() => {
    if (!mounted || !active) { console.log("[board] overlay skip: mounted=", mounted, "active=", !!active); return null; }
    const rect = rects[active.id];
    console.log("[board] overlay check: rect=", rect ? `${rect.width}x${rect.height}@(${rect.left},${rect.top})` : "null", "containerRect=", !!containerRect);
    if (!rect || !containerRect) return null;
    const sessionId = active.props.sessionId;
    const isSkeleton = zoom < 0.6;
    const scale = 1 / zoom;
    // rect 已是 pageToScreen 结果（视口坐标）；offset by containerRect
    // 因为 tldraw 相机可能受容器定位影响；保留减法保留位置精确。
    const left = rect.left - containerRect.left;
    const top = rect.top - containerRect.top;
    return createPortal(
      <div
        data-testid={`workbench-overlay-${sessionId}`}
        data-zoom-skeleton={isSkeleton ? "1" : "0"}
        style={{
          position: "absolute",
          left,
          top,
          width: rect.width,
          height: rect.height,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          pointerEvents: "auto",
          zIndex: 50,
        }}
      >
        {isSkeleton ? (
          <SkeletonWorkbench width={rect.width * zoom} height={rect.height * zoom} />
        ) : (
          <SessionWorkbench
            sessionId={sessionId}
            sessionTitle={active.props.title}
            onCollapse={() => toggleExpand(editor, active.id)}
          />
        )}
        {restCount > 0 && (
          <div
            style={{
              position: "absolute", top: 8, right: 8,
              padding: "4px 10px", borderRadius: 999,
              background: "var(--accent)", color: "#fff",
              fontSize: 11, fontWeight: 600,
              pointerEvents: "none",
            }}
            title={t("boards.workbenchLimit")}
          >
            +{restCount}
          </div>
        )}
      </div>,
      document.body,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, active, rects, zoom, containerRect]);

  return overlay;
}

function toggleExpand(editor: Editor, shapeId: string) {
  // shapeId 是去前缀的 board node id；tldraw 期望带 shape: 前缀
  const shape = editor.getShape(`shape:${shapeId}` as never);
  if (!shape || shape.type !== "session-card") return;
  editor.updateShapes([{
    id: shape.id,
    type: "session-card",
    props: { expanded: !shape.props.expanded },
  }]);
}

function SkeletonWorkbench({ width, height }: { width: number; height: number }) {
  return (
    <div
      style={{
        width, height,
        background: "var(--panel-glass)",
        backdropFilter: "blur(var(--glass-blur-panel)) saturate(var(--glass-saturate))",
        border: "1px solid var(--border)",
        borderRadius: 14,
        display: "flex", alignItems: "center", justifyContent: "center",
        flexDirection: "column", gap: 12,
        color: "var(--text-muted)",
        fontSize: 13,
      }}
    >
      <div>{Math.round(width)} × {Math.round(height)}</div>
      <div style={{ fontSize: 11, opacity: 0.7 }}>Zoom in to interact</div>
    </div>
  );
}
