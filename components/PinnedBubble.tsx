"use client";

import { useEffect, useRef } from "react";
import { MessageView } from "./MessageView";
import type { AgentMessage, ToolResultMessage } from "@/lib/types";
import type { WrittenFile } from "@/lib/turn-written-files";

export interface PinnedMessageItem {
  id: string;
  message: AgentMessage;
  entryId?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Props needed to render a pinned message faithfully through MessageView.
 * ChatWindow has all of these already; snapshot semantics mean `message`
 * is the (already-committed) message object — never the live stream.
 */
export interface PinnedRenderProps {
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  cwd?: string;
  sessionId?: string;
  entryId?: string;
  writtenFiles?: WrittenFile[];
  onOpenFile?: (filePath: string) => void;
}

interface Props {
  item: PinnedMessageItem;
  render: PinnedRenderProps;
  zIndex: number;
  active: boolean;
  onClose: (id: string) => void;
  onActivate: (id: string) => void;
  onMove: (id: string, patch: { x?: number; y?: number; w?: number; h?: number }) => void;
}

const MIN_W = 220;
const MIN_H = 140;

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

export function PinnedBubble({ item, render, zIndex, active, onClose, onActivate, onMove }: Props) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    return () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  const startDrag = (mode: Mode, event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onActivate(item.id);

    // mode 由触发元素决定：header 拖拽移动，resize handle 缩放
    const drag = dragRef.current;
    if (drag) endDrag(event.pointerId);

    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    dragRef.current = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origX: item.x,
      origY: item.y,
      origW: item.w,
      origH: item.h,
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
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.pointerType === "mouse" && event.buttons === 0) {
      endDrag(event.pointerId);
      return;
    }
    event.preventDefault();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (drag.mode === "move") {
      const w = item.w;
      const h = item.h;
      const maxX = Math.max(0, vw - w);
      const maxY = Math.max(0, vh - h);
      onMove(item.id, {
        x: Math.min(maxX, Math.max(0, drag.origX + dx)),
        y: Math.min(maxY, Math.max(0, drag.origY + dy)),
      });
    } else {
      const maxW = Math.max(MIN_W, vw - drag.origX);
      const maxH = Math.max(MIN_H, vh - drag.origY);
      onMove(item.id, {
        w: Math.min(maxW, Math.max(MIN_W, drag.origW + dx)),
        h: Math.min(maxH, Math.max(MIN_H, drag.origH + dy)),
      });
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    endDrag(event.pointerId);
    const target = event.currentTarget;
    try {
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
  };

  const roleLabel = item.message.role === "user" ? "用户" : "助手";

  return (
    <div
      ref={bubbleRef}
      data-pin-bubble
      tabIndex={0}
      style={{
        position: "fixed",
        left: item.x,
        top: item.y,
        width: item.w,
        height: item.h,
        zIndex,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-panel)",
        border: active
          ? "1px solid color-mix(in srgb, var(--border) 90%, transparent)"
          : "1px solid var(--border)",
        borderRadius: 10,
        boxShadow: active
          ? "0 0 14px 1px color-mix(in srgb, var(--border) 50%, transparent), 0 1px 2px rgba(15,23,42,0.05), 0 8px 30px rgba(0,0,0,0.35)"
          : "0 8px 30px rgba(0,0,0,0.35)",
        overflow: "hidden",
        colorScheme: "dark",
      }}
      onPointerDown={(e) => {
        // Clicking anywhere inside brings the window to front
        if (e.target === e.currentTarget) onActivate(item.id);
      }}
    >
      {/* Drag handle / header */}
      <div
        data-pin-handle
        onPointerDown={(e) => startDrag("move", e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          cursor: "grab",
          flexShrink: 0,
          touchAction: "none",
          background: "color-mix(in srgb, var(--bg-hover) 60%, transparent)",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-muted)",
          userSelect: "none",
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 17v5" />
          <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0-2-2 3 3 0 0 0-3 3V9a4 4 0 0 1-1 2.65" />
        </svg>
        <span style={{ fontWeight: 600 }}>{roleLabel}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.7 }}>
          {messagePreview(item.message)}
        </span>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onClose(item.id); }}
          title="关闭"
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 24, height: 24, padding: 0,
            background: "none", border: "none", borderRadius: 6,
            color: "var(--text-muted)", cursor: "pointer", flexShrink: 0,
            transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Scrollable body renders the snapshot through MessageView */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "6px 8px" }}>
        <MessageView
          message={item.message}
          isStreaming={false}
          bare
          toolResults={render.toolResults}
          modelNames={render.modelNames}
          cwd={render.cwd}
          onOpenFile={render.onOpenFile}
          sessionId={render.sessionId}
          entryId={render.entryId}
          writtenFiles={render.writtenFiles}
        />
      </div>

      {/* Resize handle (bottom-right) */}
      <div
        data-pin-resize
        onPointerDown={(e) => startDrag("resize", e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: 18,
          height: 18,
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
          style={{ position: "absolute", right: 2, bottom: 2, pointerEvents: "none" }}
        >
          <path d="M14 20 20 14" />
          <path d="M14 14 20 20" />
          <path d="M8 20 20 8" />
        </svg>
      </div>
    </div>
  );
}

function messagePreview(message: AgentMessage): string {
  const m = message as unknown as { content?: unknown; summary?: string };
  const extract = (c: unknown): string | null => {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b && typeof b === "object") {
          const t = b as { type?: string; text?: string; thinking?: string; name?: string };
          if (typeof t.text === "string") return t.text;
          if (t.type === "toolCall") return `${t.name ?? "tool"} ${truncate(t.text ?? "")}`;
          if (typeof t.thinking === "string") return t.thinking;
        }
      }
    }
    return null;
  };
  const s = extract(m.content) ?? m.summary ?? "";
  return truncate(s.replace(/\s+/g, " "));
}

function truncate(s: string, max = 40): string {
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + "…";
}
