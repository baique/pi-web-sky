import type { StreamParser } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

/**
 * Lazily loads the CodeMirror language support for a file. Resolving to `null`
 * means "edit as plain text" — every editor still works, it just has no
 * syntax highlighting.
 *
 * Keep this mapping keyed by the language names produced by `getLanguage()`
 * in `app/api/files/[...path]/route.ts` so the two never drift apart.
 */
export type EditorLanguageLoader = () => Promise<Extension | null>;

export function legacyStreamMode(
  load: () => Promise<Record<string, unknown>>,
  modeName: string,
): EditorLanguageLoader {
  return async () => {
    const [{ StreamLanguage }, mode] = await Promise.all([
      import("@codemirror/language"),
      load(),
    ]);
    const parser = mode[modeName] as StreamParser<unknown> | undefined;
    return parser ? StreamLanguage.define(parser) : null;
  };
}

const LANGUAGE_LOADERS: Record<string, EditorLanguageLoader> = {
  javascript: async () => (await import("@codemirror/lang-javascript")).javascript(),
  typescript: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
  html: async () => (await import("@codemirror/lang-html")).html(),
  css: async () => (await import("@codemirror/lang-css")).css(),
  json: async () => (await import("@codemirror/lang-json")).json(),
  markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
  xml: async () => (await import("@codemirror/lang-xml")).xml(),
  yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
  sql: async () => (await import("@codemirror/lang-sql")).sql(),
  python: async () => (await import("@codemirror/lang-python")).python(),
  java: async () => (await import("@codemirror/lang-java")).java(),
  go: async () => (await import("@codemirror/lang-go")).go(),
  rust: async () => (await import("@codemirror/lang-rust")).rust(),
  php: async () => (await import("@codemirror/lang-php")).php(),
  c: async () => (await import("@codemirror/lang-cpp")).cpp(),
  cpp: async () => (await import("@codemirror/lang-cpp")).cpp(),

  // No dedicated CodeMirror 6 package exists for these; the C-like legacy
  // parser covers them well enough for reading and light edits.
  kotlin: legacyStreamMode(() => import("@codemirror/legacy-modes/mode/clike"), "kotlin"),
  csharp: legacyStreamMode(() => import("@codemirror/legacy-modes/mode/clike"), "csharp"),
  swift: legacyStreamMode(() => import("@codemirror/legacy-modes/mode/swift"), "swift"),

  ruby: legacyStreamMode(() => import("@codemirror/legacy-modes/mode/ruby"), "ruby"),
  bash: legacyStreamMode(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
  toml: legacyStreamMode(() => import("@codemirror/legacy-modes/mode/toml"), "toml"),
  dockerfile: legacyStreamMode(() => import("@codemirror/legacy-modes/mode/dockerfile"), "dockerFile"),
};

export function getEditorLanguageLoader(language: string): EditorLanguageLoader | null {
  return LANGUAGE_LOADERS[language] ?? null;
}
