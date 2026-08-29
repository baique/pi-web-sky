// 下拉/气泡方向探测：距最近滚动容器下缘空间不足时向上展开（返回 true）。
// 解决 absolute 定位弹层在滚动容器边缘被 overflow 裁剪的问题。

export function dropdownDirection(
  trigger: HTMLElement,
  estimatedHeight: number,
  offset = 4,
): boolean {
  let node = trigger.parentElement;
  let container: Element | null = null;
  while (node) {
    const st = getComputedStyle(node);
    if (st.overflowY === "auto" || st.overflowY === "scroll" || st.overflowY === "overlay") {
      container = node;
      break;
    }
    node = node.parentElement;
  }
  const t = trigger.getBoundingClientRect();
  const c = container
    ? container.getBoundingClientRect()
    : { top: 0, bottom: window.innerHeight };
  const spaceBelow = c.bottom - t.bottom;
  const spaceAbove = t.top - c.top;
  // 下方放不下且上方放得下 → 向上
  return spaceBelow < estimatedHeight + offset && spaceAbove >= estimatedHeight + offset;
}
