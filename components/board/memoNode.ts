"use client";

/**
 * 看板节点组件 memo 化。
 *
 * 为什么需要自定义比较：RF 拖拽节点时每帧更新 store → NodeWrapper 重渲染，
 * 传给节点组件的 props 里 positionAbsoluteX/Y 每帧变化 → 默认浅比较 memo 失效
 * → 整张卡组件（展开会话卡含整个工作台）每帧重渲染，拖拽卡顿。
 *
 * 但卡片**内容渲染不依赖位置**（位置由 RF wrapper 的 transform 控制），
 * 所以比较时忽略位置/拖拽态字段，只看内容相关 props：
 * data（引用变化=内容/展示数据变化，如轮询更新）、selected、width/height。
 */
import { memo } from "react";
import type { ComponentType } from "react";

type NodeLikeProps = {
  data?: unknown;
  selected?: boolean;
  width?: number;
  height?: number;
  type?: string;
  id?: string;
};

function nodePropsEqual(prev: NodeLikeProps, next: NodeLikeProps): boolean {
  return (
    prev.id === next.id &&
    prev.type === next.type &&
    prev.data === next.data &&
    prev.selected === next.selected &&
    prev.width === next.width &&
    prev.height === next.height
  );
}

/** 包一层 memo：忽略拖拽/位置类 props 的每帧变化 */
export function memoBoardNode<P extends NodeLikeProps>(Comp: ComponentType<P>) {
  const Memoized = memo(Comp, nodePropsEqual as (a: P, b: P) => boolean);
  Memoized.displayName = `MemoBoardNode(${Comp.displayName ?? Comp.name ?? "Node"})`;
  return Memoized;
}
