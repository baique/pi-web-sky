"use client";

/**
 * 图片节点（贴图）：上传/粘贴/拖入的图片在画布上展示。
 * - data.src：图片 URL（/api/board-assets/...，服务端持久化）
 * - NodeResizer 缩放；双击预览大图（可选）
 * - 玻璃质感边框 + 圆角，适配黑白主题
 */

import { useCallback, useState } from "react";
import { NodeResizer, Handle, Position, type NodeProps } from "@xyflow/react";
import { useBoardCanvasOps } from "./BoardCanvasContext";
import { memoBoardNode } from "./memoNode";
import { useCardGlass } from "@/hooks/useCardGlass";

export interface ImageNodeData extends Record<string, unknown> {
  /** 图片 URL（服务端资产，/api/board-assets/<uuid>.<ext>） */
  src: string;
  /** 图片原始宽高（用于等比） */
  naturalW?: number;
  naturalH?: number;
  /** 显示尺寸由 style.width/height 控制；此处可存 lastW/lastH 供重建 */
  name?: string;
}

function ImageNodeImpl({ id, data, selected }: NodeProps & { data: ImageNodeData }) {
  const { updateNode } = useBoardCanvasOps();
  const { setContainer } = useCardGlass("var(--board-card-glass)");
  const setCardRoot = useCallback(
    (node: HTMLDivElement | null) => setContainer(node),
    [setContainer],
  );
  const src = data.src ?? "";
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);

  // 图片加载成功：记录原始尺寸（供新图替换时等比缩放）
  const onLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      setLoaded(true);
      setBroken(false);
      const naturalW = img.naturalWidth;
      const naturalH = img.naturalHeight;
      if (naturalW && naturalH && (data.naturalW !== naturalW || data.naturalH !== naturalH)) {
        updateNode(id, { data: { ...data, naturalW, naturalH } });
      }
    },
    [id, data, updateNode],
  );

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={48}
        minHeight={48}
        keepAspectRatio={false}
        color="var(--accent)"
        lineStyle={{ borderColor: "color-mix(in srgb, var(--accent) 60%, transparent)" }}
        handleStyle={{ width: 8, height: 8, borderRadius: 2, border: "1px solid var(--bg-panel)", background: "var(--accent)" }}
      />
      <Handle type="target" position={Position.Left} className="board-handle" style={{ background: "var(--text-dim)", width: 8, height: 8, border: "1px solid var(--bg-panel)", opacity: 0.85 }} />
      <Handle type="source" position={Position.Right} className="board-handle" style={{ background: "var(--text-dim)", width: 8, height: 8, border: "1px solid var(--bg-panel)", opacity: 0.85 }} />
      <div
        ref={setCardRoot}
        data-board-node
        data-testid={`image-node-${id}`}
        className="nowheel"
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          borderRadius: 10,
          overflow: "hidden",
          // 玻璃底：useCardGlass 注入贴图层（z-index:-1），卡根不再挂实时 blur
          backgroundColor: "var(--board-card-glass)",
          border: selected
            ? "1px solid color-mix(in srgb, var(--accent) 70%, transparent)"
            : "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
          boxShadow: selected
            ? "0 2px 12px -6px rgba(0,0,0,0.25), 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent)"
            : "0 2px 10px -6px rgba(0,0,0,0.2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {src && !broken ? (
          <img
            src={src}
            alt={data.name ?? "board image"}
            draggable={false}
            className="nodrag"
            onLoad={onLoad}
            onError={() => setBroken(true)}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              opacity: loaded ? 1 : 0.1,
              transition: "opacity 0.15s",
              userSelect: "none",
              pointerEvents: "none", // 不拦截画布交互；resize 走 NodeResizer
            }}
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, color: "var(--text-dim)", fontSize: 11 }}>
            {broken ? (
              <>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>
                <span>图片加载失败</span>
              </>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>
            )}
          </div>
        )}
        {/* 底部文件名角标（有名字才显示） */}
        {data.name && (
          <div
            className="nodrag"
            style={{
              position: "absolute",
              left: 6,
              bottom: 6,
              maxWidth: "calc(100% - 12px)",
              padding: "1px 6px",
              borderRadius: 4,
              background: "color-mix(in srgb, var(--bg-panel) 82%, transparent)",
              fontSize: 10,
              color: "var(--text-muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              pointerEvents: "none",
            }}
          >
            {data.name}
          </div>
        )}
      </div>
    </>
  );
}

/** memo 化导出 */
export const ImageNode = memoBoardNode(ImageNodeImpl);
