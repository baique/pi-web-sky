import { NoteShapeUtil, type Editor, type TLNoteShape } from "tldraw";

/**
 * 便笺（可缩放版）。
 *
 * 纯继承 tldraw 内置 `NoteShapeUtil`——渲染、tiptap 所见即所得编辑（markdown 语法实时转富文本）、
 * 阴影、持久化全部复用，仅做两处小改：
 *
 * 1. `resizeMode: "scale"`：打开四角缩放手柄，便笺可等比缩放（tldraw 内置缩放逻辑，
 *    无需自定义 onResize）。默认 "none" 是固定 200px 宽、只能往下长（growY），记录长文档不便。
 *    > 注：tldraw 便笺几何中 `scale` 同时作用于宽高、`growY` 非负，宽高比被锁死——
 *    > 无法做到"横向自由拉伸"，等比缩放是其原生、可靠的形态。
 * 2. 新建空便笺默认黄色（经典便签）：tldraw 默认 `color: "black"` 浅色主题渲染纯白底、
 *    深色主题近黑底，用户以为被强改黑白；这里把新建的空便笺统一成黄色，
 *    已有内容（含用户特意存成黑色的）不干预。颜色仍可通过 StylePanel 随时改。
 *
 * 注册时 `static type = "note"` 与默认 util 同 id，由 tldraw 的 merge 逻辑整体替换，
 * Note 工具 / 持久化 / 序列化路径完全不变。
 */
export class StickyNoteUtil extends NoteShapeUtil {
  static override type = "note" as const;

  /**
   * `options` 是基类实例字段（每实例独立对象），在 super 之后仅改 resizeMode，
   * getDefaultDisplayValues / getCustomDisplayValues 原样保留（不能被 `{...proto.options}` 覆盖——
   * 它不在原型上，spread 会是空对象）。
   */
  constructor(editor: Editor) {
    super(editor);
    this.options.resizeMode = "scale";
  }

  /**
   * 新建空便笺默认黄色。走基类的尺寸归一（fontSizeAdjustment 等）后再改色，
   * 只对「空内容 + 默认黑色」的便笺生效。
   */
  override onBeforeCreate(
    shape: TLNoteShape,
  ): NonNullable<ReturnType<NoteShapeUtil["onBeforeCreate"]>> {
    const next = (super.onBeforeCreate(shape) ?? shape) as NonNullable<
      ReturnType<NoteShapeUtil["onBeforeCreate"]>
    >;
    if (next.props.color === "black" && isNoteEmpty(next.props.richText)) {
      return { ...next, props: { ...next.props, color: "yellow" as TLNoteShape["props"]["color"] } };
    }
    return next;
  }
}

/** 与 tldraw 的 isEmptyRichText 等价：空 doc，或单个无内容的段落（无正文文字的空白便笺） */
function isNoteEmpty(richText: { content?: unknown[] } | null | undefined): boolean {
  if (!richText?.content?.length) return true;
  if (richText.content.length === 1) {
    const node = richText.content[0] as { content?: unknown[] } | null | undefined;
    if (!node?.content?.length) return true;
  }
  return false;
}
