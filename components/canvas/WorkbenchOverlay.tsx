"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, type Editor } from "tldraw";
import { SessionWorkbench } from "./SessionWorkbench";
import type { SessionCardShape } from "./SessionCardShape";
import { useI18n } from "@/hooks/useI18n";

/**
 * 展开工作台浮层：portal 到 document.body（不受画布 transform/overflow 影响）。
 * - 位置由 editor.pageToScreen 换算（返回视口坐标），用 position:fixed 直接定位
 * - 内容按 1/zoom 反补偿保持恒常 UI 尺寸
 * - zoom < 60% 自动降级骨架态
 *
 * 实现要点：tldraw store 记录是稳定引用（getCurrentPageShapes 每次返回同一对象），
 * 不能用 shape 对象本身当 effect 依赖。相机/形状都住在 store 里，store 变更事件
 * 已覆盖拖动/缩放/展开收合 —— 单一 store 监听重算展开集合 + 视口位置即可，
 * 不需要 rAF（避免 effect 依赖循环）。
 */
export function WorkbenchOverlay() {
  const editor = useEditor();
  const [expandedShapes, setExpandedShapes] = useState<TLShapeLike[]>([]);
  const [zoom, setZoom] = useState(1);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number; w: number; h: number }>>({});
  const { t } = useI18n();

  useEffect(() => {
    const recompute = () => {
      const cam = editor.getCamera();
      const expanded = editor.getCurrentPageShapes().filter((s) =>
        s.type === "session-card" && (s.props as { expanded?: boolean }).expanded,
      ) as unknown as TLShapeLike[];
      setExpandedShapes(expanded);
      setZoom(cam.z);
      const next: Record<string, { x: number; y: number; w: number; h: number }> = {};
      for (const shape of expanded) {
        const screen = editor.pageToScreen({ x: shape.x, y: shape.y });
        next[shape.id] = {
          x: screen.x,
          y: screen.y,
          w: shape.props.w * cam.z,
          h: shape.props.h * cam.z,
        };
      }
      setPositions(next);
    };
    recompute();
    const unlisten = editor.store.listen(recompute);
    return () => { unlisten?.(); };
  }, [editor]);

  // 单例：当前只支持 1 张展开卡（spec：同会话只允许一张）
  const active = expandedShapes[0];
  const restCount = expandedShapes.length - 1;
  const pos = active ? positions[active.id] : undefined;

  if (!active || !pos) return null;

  const sessionId = active.props.sessionId;
  const isSkeleton = zoom < 0.6;
  const scale = 1 / zoom;

  return createPortal(
    <div
      data-testid={`workbench-overlay-${sessionId}`}
      data-zoom-skeleton={isSkeleton ? "1" : "0"}
      style={{
        // pageToScreen 返回视口坐标 → fixed 定位直接命中（画布容器即视口）
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: pos.w,
        height: pos.h,
        transform: `scale(${scale})`,
        transformOrigin: "top left",
        pointerEvents: "auto",
        zIndex: 2147483000,
      }}
    >
      {isSkeleton ? (
        <SkeletonWorkbench width={pos.w * zoom} height={pos.h * zoom} />
      ) : (
        <SessionWorkbench
          sessionId={sessionId}
          sessionTitle={active.props.title ?? ""}
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
}

function toggleExpand(editor: Editor, shapeId: string) {
  // shapeId 已是完整 tldraw id（如 shape:xxx），不要再加前缀
  const shape = editor.getShape(shapeId as never);
  if (!shape || shape.type !== "session-card") return;
  const willCollapse = (shape.props as { expanded?: boolean }).expanded;
  editor.updateShapes([{
    id: shape.id,
    type: "session-card",
    props: {
      expanded: !willCollapse,
      // 收合时尺寸回到默认收合卡，与 SessionCardUtil.onDoubleClick 保持一致
      w: willCollapse ? 280 : 760,
      h: willCollapse ? 120 : 600,
    },
  }]);
}

/** 本地最小 shape 形状（只读渲染需要），避免依赖 tldraw 内部类型不稳定 */
interface TLShapeLike {
  id: string;
  type: string;
  x: number;
  y: number;
  props: {
    expanded?: boolean;
    w: number;
    h: number;
    sessionId: string;
    title?: string;
  };
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
