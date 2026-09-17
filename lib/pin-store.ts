"use client";

import { useSyncExternalStore } from "react";

export interface PinnedMessageItem {
  id: string;
  /** 快照内容（markdown 文本）——钉卡只渲染内容，与消息气泡/会话解耦 */
  content: string;
  x: number;
  y: number;
  w: number;
  /** 高度：undefined = 初始随内容自适应；缩放/resize 后变为固定值 */
  h?: number;
}

type Listener = () => void;

/**
 * 全局钉 store：pins 存活在模块级（与任何会话组件无关）。
 * 跨会话/看板切换保留；刷新页面不持久化（内存态，符合设计）。
 */
let pins: PinnedMessageItem[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return pins;
}

let pinCount = 0;

/** 钉住内容：卡片出现在鼠标下方，多张级联偏移，clamp 视口内 */
export function pin(content: string, clientX: number, clientY: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(340, Math.max(240, vw - 40));
  const offset = (pinCount % 8) * 22;
  pinCount += 1;
  const item: PinnedMessageItem = {
    id: `pin-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    content,
    x: Math.min(Math.max(0, clientX + offset), Math.max(0, vw - w - 4)),
    y: Math.min(Math.max(0, clientY + 14 + offset), Math.max(0, vh - 48)),
    w,
  };
  pins = [...pins, item];
  emit();
}

export function closePin(id: string) {
  pins = pins.filter((p) => p.id !== id);
  emit();
}

export function movePin(id: string, patch: Partial<Pick<PinnedMessageItem, "x" | "y" | "w" | "h">>) {
  pins = pins.map((p) => (p.id === id ? { ...p, ...patch } : p));
  emit();
}

/** 激活置顶：把卡片移到数组末尾（zIndex 最高） */
export function activatePin(id: string) {
  if (pins.length <= 1) return;
  const idx = pins.findIndex((p) => p.id === id);
  if (idx === -1 || idx === pins.length - 1) return;
  const next = [...pins];
  const [item] = next.splice(idx, 1);
  next.push(item);
  pins = next;
  emit();
}

/** 订阅 pins 快照（组件用） */
export function usePins(): PinnedMessageItem[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
