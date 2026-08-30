import { BaseBoxShapeTool } from "tldraw";

/**
 * markdown 便笺工具。独立 id "sticky-note"（不占内置 note 的 id），
 * 由自定义工具栏提供入口（见 CanvasStage BoardToolbarContent），点击/拖拽创建自研 sticky-note。
 */
export class StickyNoteTool extends BaseBoxShapeTool {
  static override id = "sticky-note" as const;
  static override initial = "idle" as const;
  override shapeType = "sticky-note" as const;
}
