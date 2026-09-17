#!/usr/bin/env node
/**
 * docs-audit.mjs —— 文档 ↔ 代码 双向核对（随时可复跑，不依赖任何 agent 的记性）
 *
 *   node scripts/docs-audit.mjs           # 全量报告
 *   node scripts/docs-audit.mjs --gaps    # 只列缺口（可接 CI）
 *   退出码：0 = 无缺口；1 = 有缺口
 *
 * 三个方向：
 *   A. 文档 → 代码：文档里出现的每个 `x.ts / x.tsx / x.mjs` 是否真实存在
 *   B. 代码 → 文档：每个代码模块是否在 docs/reference/ 有归属说明文档
 *   C. 汇总 + 退出码
 *
 * 判定规则（都可争议、可改，改文档结构后同步改表）：
 *   - A 段豁免（EXEMPT_DOCS）：历史设计稿/移植记录允许提到"当时规划过或已删除"的文件名
 *   - B 段模块：lib 按目录或文件名首段、components 按目录、hooks 一组、app/api 按一级路径
 *   - B 段归属：① MODULE_DOC 显式映射 → ok；② 退一步"该模块下文件被某 reference 文档
 *     提及的比例 ≥ 30%" → weak；③ 都没有 → 缺口（仅当模块 ≥ THRESHOLD 行）
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const REF_DIR = "docs/reference";
const THRESHOLD = 300;          // 少于这么多行的模块不要求专题归属
const COVER_RATIO = 0.3;        // 模块内文件被某篇文档提及的比例达到多少算弱归属

/** 这些文档允许出现"不存在的文件名"（历史设计稿 / 移植记录 / 明确标注的历史快照）。 */
const EXEMPT_DOCS = [
  ".agent/plan/",        // 当时的执行计划：写的是计划要建的文件，落地后可能改名/没建
  ".agent/spec/",        // 当时的设计稿：同上
  "docs/upstream-ports.md",   // 移植记录：正文含"移除 lib/xxx.ts"这类对被删文件的正确描述
];

/** 模块 → 归属文档（docs/reference/<file>）。改文档结构时同步改这里。 */
const MODULE_DOC = {
  "lib/board": "boards.md", "lib/card": "boards.md", "lib/yjs-room-server": "boards.md",
  "lib/session": "sessions.md", "lib/rpc": "sessions.md", "lib/agent": "sessions.md",
  "lib/message": "sessions.md", "lib/turn": "sessions.md", "lib/patch": "sessions.md",
  "lib/streaming": "sessions.md", "lib/compaction": "sessions.md", "lib/normalize": "sessions.md",
  "lib/slash": "sessions.md", "lib/ansi": "sessions.md", "lib/markdown": "sessions.md",
  "lib/frontmatter": "sessions.md", "lib/clipboard": "sessions.md", "lib/quoted": "sessions.md",
  "lib/chat": "sessions.md",
  "lib/task": "task-cards.md", "lib/scheduler": "task-cards.md", "lib/search": "task-cards.md",
  "lib/audit": "task-cards.md",
  "lib/todo": "todo.md",
  "lib/subagent": "subagents.md", "lib/subagents": "subagents.md",
  "lib/model": "auth-models.md", "lib/provider": "auth-models.md", "lib/deepseek": "auth-models.md",
  "lib/startup": "auth-models.md", "lib/tool": "auth-models.md",
  "lib/skill": "plugins-skills.md", "lib/npx": "plugins-skills.md",
  "lib/file": "worktrees-files.md", "lib/path": "worktrees-files.md", "lib/allowed": "worktrees-files.md",
  "lib/project": "worktrees-files.md", "lib/worktree": "worktrees-files.md", "lib/git": "worktrees-files.md",
  "lib/directory": "worktrees-files.md", "lib/request": "worktrees-files.md", "lib/web": "worktrees-files.md",
  "lib/http": "worktrees-files.md",
  "lib/terminal": "ui-popovers.md", "lib/custom": "ui-popovers.md", "lib/panel": "ui-popovers.md",
  "lib/dropdown": "ui-popovers.md", "lib/settings": "ui-popovers.md",
  "lib/wallpaper": "css-tokens.md", "lib/bg": "css-tokens.md", "lib/i18n": "file-map.md",
  "lib/atomic": "file-map.md", "lib/bounded": "file-map.md", "lib/id": "file-map.md",
  "lib/types": "file-map.md", "lib/api-types": "file-map.md", "lib/pi": "file-map.md",
  "lib/sqlite": "file-map.md", "lib/bash": "file-map.md", "lib/pin": "file-map.md",
  "lib/note": "file-map.md", "lib/draft": "file-map.md", "lib/app-update": "file-map.md",
  "lib/workspace": "file-map.md", "lib/skill-frontmatter": "plugins-skills.md",
  "lib/image": "sessions.md", "lib/browser": "sessions.md", "lib/file-viewer": "worktrees-files.md",
  "lib/file-upload": "worktrees-files.md", "lib/file-fuzzy": "worktrees-files.md",
  "lib/file-links": "worktrees-files.md", "lib/file-dirent": "worktrees-files.md",
  "lib/models": "auth-models.md", "lib/session-index": "sessions.md", "lib/session-scanner": "sessions.md",
  "lib/session-family": "subagents.md", "lib/turn-merge": "sessions.md",
  "lib/board-reconcile": "boards.md", "lib/board-reconcile-scheduler": "boards.md",
  "lib/board-assets": "boards.md", "lib/board-assets-dir": "boards.md", "lib/board-align": "boards.md",
  "lib/board-events": "board-events.md", "lib/board-store": "boards.md", "lib/board-types": "boards.md",
  "lib/task-card-store": "task-cards.md", "lib/task-scheduler": "task-cards.md", "lib/task-store": "task-cards.md",
  "app/api/sessions": "sessions.md", "app/api/agent": "sessions.md", "app/api/files": "worktrees-files.md",
  "app/api/cwd": "worktrees-files.md", "app/api/default-cwd": "worktrees-files.md",
  "app/api/worktrees": "worktrees-files.md", "app/api/git": "worktrees-files.md",
  "app/api/auth": "auth-models.md", "app/api/models": "auth-models.md", "app/api/models-config": "auth-models.md",
  "app/api/quota": "auth-models.md", "app/api/plugins": "plugins-skills.md", "app/api/skills": "plugins-skills.md",
  "app/api/mcp": "ui-popovers.md", "app/api/terminal": "ui-popovers.md", "app/api/project-trust": "worktrees-files.md",
  "app/api/boards": "boards.md", "app/api/board-assets": "boards.md", "app/api/yjs-version": "boards.md",
  "app/api/task-cards": "task-cards.md", "app/api/task-card-questions": "task-cards.md",
  "app/api/tasks": "task-cards.md", "app/api/task-scheduler": "task-cards.md",
  "app/api/subagents": "subagents.md", "app/api/plugins/skills": "plugins-skills.md",
  "app/api/home": "file-map.md", "app/api/app-update": "file-map.md", "app/api/file-index": "worktrees-files.md",
  "app/api/search": "task-cards.md", "app/api/skills/install": "plugins-skills.md",
  "components/board": "board-events.md", "components/canvas": "boards.md",
  "components": "file-map.md",
  "lib/api": "file-map.md", "lib/powershell": "auth-models.md",
  "lib/paths": "worktrees-files.md", "lib/prompt": "sessions.md", "lib/app": "file-map.md",
  "lib/skills": "plugins-skills.md", "lib/initial": "sessions.md",
  "hooks": "sessions.md",
};

const args = new Set(process.argv.slice(2));
const gapsOnly = args.has("--gaps");

const exists = (p) => fs.existsSync(path.join(ROOT, p));
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), "utf8"); } catch { return ""; } };
const lineCount = (p) => (exists(p) ? read(p).split("\n").length : 0);

function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

// ---------- A. 文档 → 代码 ----------
const docFiles = [
  ...walk("docs").filter((f) => f.endsWith(".md") && !f.includes("/img/")),
  ...walk(".agent").filter((f) => f.endsWith(".md")),
  "AGENTS.md",
];
const codeRoots = ["", "lib/", "lib/i18n/", "lib/i18n/messages/", "components/", "components/board/", "components/canvas/", "hooks/", "app/", "app/api/", "scripts/", "bin/", "scripts/"];

const ghostRefs = [];
for (const file of docFiles) {
  if (EXEMPT_DOCS.some((d) => file.startsWith(d))) continue;
  const src = read(file);
  const tokens = new Set(src.match(/(?<![\w./-])([A-Za-z0-9_][\w.-]*\.(?:tsx|ts|mjs))/g) ?? []);
  for (const token of tokens) {
    if (token.endsWith(".test.mjs")) continue;
    // 形如 `[s]erver.mjs` 的正则字符类写法不是文件名
    if (new RegExp("\\[[^\\]]\\]" + token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(src)) continue;
    if (codeRoots.some((root) => exists(root + token))) continue;
    ghostRefs.push(`${file} → ${token}`);
  }
}

// ---------- B. 代码 → 文档 ----------
const referenceDocs = walk(REF_DIR).filter((f) => f.endsWith(".md"));
const referenceText = Object.fromEntries(referenceDocs.map((f) => [f, read(f)]));

const modules = new Map();
function addModule(name, file) {
  const cur = modules.get(name) ?? { files: [], lines: 0 };
  cur.files.push(file);
  cur.lines += lineCount(file);
  modules.set(name, cur);
}
for (const f of walk("lib").filter((f) => f.endsWith(".ts"))) {
  const rel = path.relative("lib", f);
  const seg = rel.includes(path.sep) ? rel.split(path.sep)[0] : path.basename(rel).split("-")[0].replace(/\.ts$/, "");
  addModule(`lib/${seg}`, f);
}
for (const f of walk("components").filter((f) => /\.tsx?$/.test(f))) {
  const dir = path.dirname(f) === "components" ? "components" : path.dirname(f);
  addModule(dir, f);
}
for (const f of walk("hooks").filter((f) => /\.tsx?$/.test(f))) addModule("hooks", f);
for (const f of walk("app/api").filter((f) => f.endsWith("route.ts"))) {
  const seg = path.relative(path.join("app", "api"), f).split(path.sep)[0];
  addModule(`app/api/${seg}`, f);
}

const rows = [];
for (const [name, info] of modules) {
  let doc = MODULE_DOC[name] ?? null;
  let status = doc ? "ok" : "none";
  if (!doc) {
    const scored = Object.entries(referenceText)
      .map(([f, text]) => {
        const mentioned = info.files.filter((file) => {
          const base = path.basename(file).replace(/\.tsx?$/, "");
          return text.includes(base);
        }).length;
        return { doc: f, ratio: mentioned / info.files.length };
      })
      .sort((a, b) => b.ratio - a.ratio);
    if (scored[0] && scored[0].ratio >= COVER_RATIO) {
      doc = scored[0].doc;
      status = "weak";
    }
  }
  rows.push({ name, lines: info.lines, files: info.files.length, doc, status, gap: !doc && info.lines >= THRESHOLD });
}
rows.sort((a, b) => b.lines - a.lines);

const moduleGaps = rows.filter((r) => r.gap);
const hasGaps = ghostRefs.length > 0 || moduleGaps.length > 0;

if (!gapsOnly) {
  console.log("## A. 文档 → 代码（文档提到的文件是否真实存在）");
  console.log(ghostRefs.length ? ghostRefs.map((g) => "   ✗ " + g).join("\n") : "   0 个幽灵引用");
  console.log("\n## B. 代码 → 文档（模块归属）");
  console.log("     行数 文件  模块                          归属文档              状态");
  for (const r of rows) {
    if (r.lines < 100) continue;
    console.log(`   ${String(r.lines).padStart(6)} ${String(r.files).padStart(4)}  ${r.name.padEnd(28)} ${(r.doc ?? "(无)").padEnd(21)} ${r.status}${r.gap ? "  ← 缺口" : ""}`);
  }
  console.log("\n## C. 汇总");
  console.log(`   幽灵引用 ${ghostRefs.length} ｜ 无归属模块 ${moduleGaps.length} ｜ 弱归属模块 ${rows.filter((r) => r.status === "weak").length}`);
  const weakNames = rows.filter((r) => r.status === "weak").map((r) => `${r.name}→${path.basename(r.doc)}`);
  if (weakNames.length) console.log(`   弱归属清单：${weakNames.join("、")}（未显式映射，靠文档提及率判定，确认后可入 MODULE_DOC）`);
  console.log(`   豁免：${EXEMPT_DOCS.join(" ")}`);
} else {
  for (const g of ghostRefs) console.log("幽灵引用 " + g);
  for (const r of moduleGaps) console.log(`无归属模块 ${r.name}（${r.lines} 行 / ${r.files} 文件）`);
}

console.log(hasGaps ? "\n结论：有缺口（退出码 1）" : "\n结论：无缺口（退出码 0）");
process.exit(hasGaps ? 1 : 0);
