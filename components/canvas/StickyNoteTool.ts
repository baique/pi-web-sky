import { BaseBoxShapeTool } from "tldraw";

/**
 * markdown 便笺工具。id = "note" 占用内置便笺工具的 id（经 tldraw merge 替换 NoteShapeTool）；
 * 工具栏 note 按钮点击 → setCurrentTool("note") → 本工具创建 sticky-note。
 * 注意：工具栏「拖拽」路径由 useTools 的 onDragStart 直接创建 shape，需用 UI overrides 覆盖（见 CanvasStage）。
 */
export class StickyNoteTool extends BaseBoxShapeTool {
  static override id = "note" as const;
  static override initial = "idle" as const;
  override shapeType = "sticky-note" as const;
}
