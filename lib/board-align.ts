import type { Node } from "@xyflow/react";

export interface AlignLine {
  x1: number; y1: number; x2: number; y2: number;
}

export interface SnapResult {
  lines: AlignLine[];
  snapX: number | null;
  snapY: number | null;
}

/** 吸附阈值（flow 坐标 px） */
export const SNAP_THRESHOLD = 8;
/** 仅当两节点包围盒间距 ≤ 此值时才参与对齐，避免远距离节点误触发 */
const MAX_ALIGN_DISTANCE = 200;

function bounds(n: Node) {
  const w = Number(n.style?.width) || 0;
  const h = Number(n.style?.height) || 0;
  return {
    left: n.position.x, right: n.position.x + w, cx: n.position.x + w / 2,
    top: n.position.y, bottom: n.position.y + h, cy: n.position.y + h / 2, w, h,
  };
}

/** 两节点包围盒的近似间距（flow 坐标） */
function boxDistance(a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>) {
  const dx = Math.max(0, Math.max(a.left - b.right, b.left - a.right));
  const dy = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom));
  return Math.hypot(dx, dy);
}

/**
 * 计算拖动节点的对齐参考线 + 吸附位置。
 * 仅比对主轴（左/中/右 × 上/中/下），命中阈值内按轴独立返回。
 * 参考线范围覆盖两节点并集，延伸 6px 端点标记。
 */
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

    // 距离过滤：包围盒间距过远的节点不参与对齐
    if (boxDistance(d, ob) > MAX_ALIGN_DISTANCE) continue;

    const oMinX = Math.min(ob.left, ob.right);
    const oMaxX = Math.max(ob.left, ob.right);
    const oMinY = Math.min(ob.top, ob.bottom);
    const oMaxY = Math.max(ob.top, ob.bottom);

    // 水平对齐（x 轴）→ 竖向参考线
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

    // 竖直对齐（y 轴）→ 横向参考线
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

    // 两条轴都已命中可提前退出
    if (bestDistX < threshold && bestDistY < threshold) break;
  }

  const lines: AlignLine[] = [];
  if (lineX !== null && lineXOther) {
    lines.push({
      x1: lineX,
      y1: Math.min(dMinY, lineXOther.minY) - 6,
      x2: lineX,
      y2: Math.max(dMaxY, lineXOther.maxY) + 6,
    });
  }
  if (lineY !== null && lineYOther) {
    lines.push({
      x1: Math.min(dMinX, lineYOther.minX) - 6,
      y1: lineY,
      x2: Math.max(dMaxX, lineYOther.maxX) + 6,
      y2: lineY,
    });
  }

  return { lines, snapX, snapY };
}

/**
 * 计算 resize 时的对齐参考线 + 吸附尺寸。
 * 输入 position + 候选 width/height，输出吸附后的尺寸。
 */
export function computeResizeSnap(
  nodeId: string,
  position: { x: number; y: number },
  width: number,
  height: number,
  nodes: Node[],
  threshold: number = SNAP_THRESHOLD,
): { lines: AlignLine[]; snapW: number | null; snapH: number | null } {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return { lines: [], snapW: null, snapH: null };

  const d = {
    left: position.x, right: position.x + width, cx: position.x + width / 2,
    top: position.y, bottom: position.y + height, cy: position.y + height / 2,
    w: width, h: height,
  };
  const dMinX = Math.min(d.left, d.right);
  const dMaxX = Math.max(d.left, d.right);
  const dMinY = Math.min(d.top, d.bottom);
  const dMaxY = Math.max(d.top, d.bottom);

  let snapW: number | null = null;
  let snapH: number | null = null;
  let bestDistX = threshold;
  let bestDistY = threshold;
  let lineX: number | null = null;
  let lineXOther: { minY: number; maxY: number } | null = null;
  let lineY: number | null = null;
  let lineYOther: { minX: number; maxX: number } | null = null;

  for (const o of nodes) {
    if (o.id === nodeId) continue;
    const ob = bounds(o);
    if (boxDistance(d, ob) > MAX_ALIGN_DISTANCE) continue;

    const oMinX = Math.min(ob.left, ob.right);
    const oMaxX = Math.max(ob.left, ob.right);
    const oMinY = Math.min(ob.top, ob.bottom);
    const oMaxY = Math.max(ob.top, ob.bottom);

    // 水平：右边缘对齐其他节点的左/中/右
    const hEdges: Array<[number, number]> = [
      [d.right, ob.left], [d.right, ob.cx], [d.right, ob.right],
    ];
    for (const [de, oe] of hEdges) {
      const dist = Math.abs(de - oe);
      if (dist < bestDistX) {
        bestDistX = dist;
        snapW = oe - position.x;
        lineX = oe;
        lineXOther = { minY: oMinY, maxY: oMaxY };
      }
    }

    // 竖直：底边缘对齐其他节点的上/中/下
    const vEdges: Array<[number, number]> = [
      [d.bottom, ob.top], [d.bottom, ob.cy], [d.bottom, ob.bottom],
    ];
    for (const [de, oe] of vEdges) {
      const dist = Math.abs(de - oe);
      if (dist < bestDistY) {
        bestDistY = dist;
        snapH = oe - position.y;
        lineY = oe;
        lineYOther = { minX: oMinX, maxX: oMaxX };
      }
    }

    if (bestDistX < threshold && bestDistY < threshold) break;
  }

  const lines: AlignLine[] = [];
  if (lineX !== null && lineXOther) {
    lines.push({
      x1: lineX, y1: Math.min(dMinY, lineXOther.minY) - 6,
      x2: lineX, y2: Math.max(dMaxY, lineXOther.maxY) + 6,
    });
  }
  if (lineY !== null && lineYOther) {
    lines.push({
      x1: Math.min(dMinX, lineYOther.minX) - 6, y1: lineY,
      x2: Math.max(dMaxX, lineYOther.maxX) + 6, y2: lineY,
    });
  }

  return { lines, snapW, snapH };
}
