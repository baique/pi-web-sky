import { BaseBoxShapeTool } from "tldraw";

/**
 * 任务卡工具。id = "task-card"。
 * 工具栏「任务卡」按钮点击 → setCurrentTool("task-card") → 本工具在画布落点
 * 创建空 task-card shape（cardId 为空占位，双击由 Task 6 建卡向导接管）。
 */
export class TaskCardTool extends BaseBoxShapeTool {
  static override id = "task-card" as const;
  static override initial = "idle" as const;
  override shapeType = "task-card" as const;
}
