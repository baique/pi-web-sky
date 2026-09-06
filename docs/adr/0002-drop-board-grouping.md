# Drop board grouping (GroupNode) after implementation

2026-09-05 — 看板「分组 / 思维导图连线」功能在 e3be825 引入、0eaec5b 移除（同批开发内反复）。

## 决策

移除看板分组功能（GroupNode + 分组容器语义 + 多选建组）。保留手写体文字、图片贴图、复制粘贴、思维导图样式的自由连线；「分组」容器型节点不保留。

## 原因

- **使用频率不高**：非高频核心操作，投入产出比低。
- **实现引入了大量样式与操作问题**：分组容器影响拖拽/缩放/层级/选中语义，产生一整套样式、事件、多端同步的边界问题，维护成本远超收益。

## 备选

未深入评估「子节点容器」替代方案（如 RF 的 parent 节点语义）——在 yjs 多端 CRDT 下容器-子节点关系需额外的相对定位/层级协调，属另一轮工作量。若未来真有高频分组诉求，应从 RF parent-node + 服务端权威 reconcile 的成熟模式重新评估，勿复用本次已删的 GroupNode 实现。

## 影响

画布节点类型收敛为 session-card / task-card / sticky-note / text-node / image-node；代码已无 group 残留（0eaec5b 清理干净）。
