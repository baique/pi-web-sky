import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/**
 * Syntax colours resolve to the `--syntax-*` tokens in `app/globals.css`, so the
 * editor follows the app theme (and the wallpaper-tinted chrome) without a
 * light/dark swap at the component level. Values are picked to sit next to the
 * Prism `vs` / `vscDarkPlus` themes the read-only source view uses.
 */
const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: "var(--syntax-keyword)" },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: "var(--syntax-variable)" },
  { tag: [t.propertyName], color: "var(--syntax-variable)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: "var(--syntax-function)" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "var(--syntax-number)" },
  { tag: [t.definition(t.name), t.separator], color: "var(--text)" },
  {
    tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace],
    color: "var(--syntax-type)",
  },
  {
    tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)],
    color: "var(--syntax-operator)",
  },
  { tag: [t.meta, t.comment], color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--syntax-comment)", textDecoration: "underline" },
  { tag: t.heading, fontWeight: "bold", color: "var(--syntax-keyword)" },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: "var(--syntax-number)" },
  { tag: [t.processingInstruction, t.string, t.inserted], color: "var(--syntax-string)" },
  { tag: t.invalid, color: "var(--syntax-variable)" },
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "bold" },
  { tag: t.quote, color: "var(--text-muted)" },
  { tag: [t.monospace], fontFamily: "var(--font-mono)" },
]);

/**
 * Chrome for the file editor. Line height / gutter width are kept in step with
 * `FILE_LINE_NUMBER_STYLE` in `components/FileViewer.tsx` (13px * 1.6 = 20.8px)
 * so toggling edit mode does not shift the text by a pixel.
 */
const editorChrome = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    backgroundColor: "transparent",
    color: "var(--text)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.6",
    overflow: "auto",
  },
  ".cm-content": {
    padding: "0",
    caretColor: "var(--text)",
  },
  ".cm-line": { padding: "0 10px" },
  ".cm-gutters": {
    backgroundColor: "var(--file-panel-gutter)",
    color: "var(--text-dim)",
    border: "none",
    borderRight: "1px solid var(--border)",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    fontVariantNumeric: "tabular-nums",
  },
  ".cm-gutterElement": { padding: "0 10px 0 0", minWidth: "48px" },
  ".cm-activeLine": { backgroundColor: "var(--side-hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-muted)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--side-selected)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--file-panel-chrome)",
    border: "1px solid var(--border)",
    color: "var(--text-muted)",
  },
  ".cm-panels": {
    backgroundColor: "var(--file-panel-chrome)",
    color: "var(--text)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-searchMatch": { backgroundColor: "var(--side-selected)", outline: "1px solid var(--accent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--accent)", color: "var(--bg)" },
  ".cm-tooltip": {
    backgroundColor: "var(--popover-glass)",
    border: "1px solid var(--border)",
    color: "var(--text)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--side-selected)",
    color: "var(--text)",
  },
  ".cm-matchingBracket, .cm-nonmatchingBracket": {
    backgroundColor: "var(--side-active)",
    outline: "1px solid var(--border)",
  },
});

export const fileEditorTheme: Extension = [editorChrome, syntaxHighlighting(highlightStyle)];
