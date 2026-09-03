import type { Node } from "@xyflow/react";

export interface AlignLine {
  x1: number; y1: number; x2: number; y2: number;
}

export interface SnapResult {
  lines: AlignLine[];
  snapX: number | null;
  snapY: number | null;
}

export const SNAP_THRESHOLD = 8;

function bounds(n: Node) {
  const w = Number(n.style?.width) || 0;
  const h = Number(n.style?.height) || 0;
  return {
    left: n.position.x, right: n.position.x + w, cx: n.position.x + w / 2,
    top: n.position.y, bottom: n.position.y + h, cy: n.position.y + h / 2,
  };
}

export function computeSnap(
  draggedId: string,
  draggedPos: { x: number; y: number },
  nodes: Node[],
  threshold: number = SNAP_THRESHOLD,
): SnapResult {
  const dragged = nodes.find((n) => n.id === draggedId);
  if (!dragged) return { lines: [], snapX: null, snapY: null };

  const d = bounds({ ...dragged, position: { ...dragged.position, ...draggedPos } });
  const dMinX = Math.min(d.left, d.right);
  const dMaxX = Math.max(d.left, d.right);
  const dMinY = Math.min(d.top, d.bottom);
  const dMaxY = Math.max(d.top, d.bottom);

  let snapX: number | null = null;
  let snapY: number | null = null;
  let bestDistX = threshold;
  let bestDistY = threshold;
  let lineX: number | null = null;
  let lineXOther: { minY: number; maxY: number } | null = null;
  let lineY: number | null = null;
  let lineYOther: { minX: number; maxX: number } | null = null;

  for (const o of nodes) {
    if (o.id === draggedId) continue;
    const ob = bounds(o);
    const oMinX = Math.min(ob.left, ob.right);
    const oMaxX = Math.max(ob.left, ob.right);
    const oMinY = Math.min(ob.top, ob.bottom);
    const oMaxY = Math.max(ob.top, ob.bottom);

    const hEdges: Array<[number, number]> = [
      [d.left, ob.left], [d.left, ob.cx], [d.left, ob.right],
      [d.cx, ob.left], [d.cx, ob.cx], [d.cx, ob.right],
      [d.right, ob.left], [d.right, ob.cx], [d.right, ob.right],
    ];
    for (const [de, oe] of hEdges) {
      const dist = Math.abs(de - oe);
      if (dist < bestDistX) {
        bestDistX = dist;
        snapX = draggedPos.x + (oe - de);
        lineX = oe;
        lineXOther = { minY: oMinY, maxY: oMaxY };
      }
    }

    const vEdges: Array<[number, number]> = [
      [d.top, ob.top], [d.top, ob.cy], [d.top, ob.bottom],
      [d.cy, ob.top], [d.cy, ob.cy], [d.cy, ob.bottom],
      [d.bottom, ob.top], [d.bottom, ob.cy], [d.bottom, ob.bottom],
    ];
    for (const [de, oe] of vEdges) {
      const dist = Math.abs(de - oe);
      if (dist < bestDistY) {
        bestDistY = dist;
        snapY = draggedPos.y + (oe - de);
        lineY = oe;
        lineYOther = { minX: oMinX, maxX: oMaxX };
      }
    }

    if (bestDistX < threshold && bestDistY < threshold) break;
  }

  const lines: AlignLine[] = [];
  if (lineX !== null && lineXOther) {
    lines.push({ x1: lineX, y1: Math.min(dMinY, lineXOther.minY), x2: lineX, y2: Math.max(dMaxY, lineXOther.maxY) });
  }
  if (lineY !== null && lineYOther) {
    lines.push({ x1: Math.min(dMinX, lineYOther.minX), y1: lineY, x2: Math.max(dMaxX, lineYOther.maxX), y2: lineY });
  }

  return { lines, snapX, snapY };
}
