"use client";

import { useEffect, useRef } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { basicSetup } from "codemirror";
import { getEditorLanguageLoader } from "@/lib/editor-languages";
import { fileEditorTheme } from "@/lib/editor-theme";

export interface FileEditorHandle {
  getValue: () => string;
}

export interface FileEditorProps {
  /**
   * Seed content. Later changes are ignored: the editor owns its document, so
   * reload from disk by remounting with a new `key`. Treating CodeMirror as a
   * controlled input (`value` + `setState` on every keystroke) is what freezes
   * cursors and eats the undo stack.
   */
  initialDoc: string;
  /** Language name from the files API. Unknown names simply edit as plain text. */
  language: string;
  editable: boolean;
  wrapLines: boolean;
  autoFocus?: boolean;
  onDirty?: () => void;
  onSave?: () => void;
  /**
   * Called with a handle once the view exists, and with `null` on teardown.
   * A callback rather than a ref so callers can render this through a lazy
   * `import()` without ref forwarding getting in the way.
   */
  onReady?: (handle: FileEditorHandle | null) => void;
  ariaLabel?: string;
}

interface Compartments {
  editable: Compartment;
  wrap: Compartment;
  language: Compartment;
}

export function FileEditor({
  initialDoc,
  language,
  editable,
  wrapLines,
  autoFocus,
  onDirty,
  onSave,
  onReady,
  ariaLabel,
}: FileEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const compartmentsRef = useRef<Compartments | null>(null);
  if (!compartmentsRef.current) {
    compartmentsRef.current = {
      editable: new Compartment(),
      wrap: new Compartment(),
      language: new Compartment(),
    };
  }

  const onDirtyRef = useRef(onDirty);
  const onSaveRef = useRef(onSave);
  const onReadyRef = useRef(onReady);
  onDirtyRef.current = onDirty;
  onSaveRef.current = onSave;
  onReadyRef.current = onReady;

  useEffect(() => {
    const host = hostRef.current;
    const compartments = compartmentsRef.current;
    if (!host || !compartments) return;

    let disposed = false;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          basicSetup,
          fileEditorTheme,
          compartments.editable.of(EditorView.editable.of(editable)),
          compartments.wrap.of(wrapLines ? EditorView.lineWrapping : []),
          // Filled in once the (lazily imported) language package arrives. The
          // editor is usable immediately; highlighting upgrades a beat later.
          compartments.language.of([]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onDirtyRef.current?.();
          }),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
            indentWithTab,
          ]),
          EditorView.contentAttributes.of(ariaLabel ? { "aria-label": ariaLabel } : {}),
        ],
      }),
    });
    viewRef.current = view;
    onReadyRef.current?.({ getValue: () => view.state.doc.toString() });
    if (autoFocus) view.focus();

    const loadLanguage = getEditorLanguageLoader(language);
    if (loadLanguage) {
      loadLanguage()
        .then((extension: Extension | null) => {
          if (disposed || !extension) return;
          view.dispatch({ effects: compartments.language.reconfigure(extension) });
        })
        .catch(() => {
          // Highlighting is a nicety — a failed language chunk keeps plain text.
        });
    }

    return () => {
      disposed = true;
      view.destroy();
      viewRef.current = null;
      onReadyRef.current?.(null);
    };
    // Single mount by design: `initialDoc` / `language` are the seed, and every
    // other prop flows through its Compartment without rebuilding the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartmentsRef.current!.editable.reconfigure(EditorView.editable.of(editable)),
    });
  }, [editable]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartmentsRef.current!.wrap.reconfigure(wrapLines ? EditorView.lineWrapping : []),
    });
  }, [wrapLines]);

  return <div ref={hostRef} className="file-editor" style={{ height: "100%", overflow: "hidden" }} />;
}
