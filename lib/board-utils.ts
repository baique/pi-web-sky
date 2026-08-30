/** 看板纯函数工具（SDK-free，浏览器 + node 测试均可用）。 */

/**
 * 刚结束卡片 30s 保留判定：phase=just-ended 且 endedAt 超过窗口则移除。
 * @param phase 卡片当前阶段
 * @param endedAt 结束时刻（ms epoch）；0 = 未知，不判定
 * @param nowTs 当前时刻（ms epoch）
 * @param windowMs 保留窗口（默认 30s）
 */
export function shouldRemoveEndedCard(
  phase: string,
  endedAt: number,
  nowTs: number,
  windowMs = 30_000,
): boolean {
  return phase === "just-ended" && endedAt > 0 && nowTs - endedAt > windowMs;
}
