/**
 * 前端 id 生成（会话 id / 画布节点 id / 草稿 id / 通知 id 等）。
 *
 * **一律用它，别裸调 `crypto.randomUUID()`**：该方法只在**安全上下文**存在
 * （https / localhost）。局域网访问（`npm run dev:lan` → `http://192.168.x.x:30143`）
 * 或老浏览器里它是 undefined，裸调直接抛 “crypto.randomUUID is not a function”
 * —— 任务行「新建会话」2026-09-14 就栽在这里（同一批调用里有的做了兜底、有的漏了）。
 *
 * 退化实现产出的 id 仍是 `[A-Za-z0-9-]`，满足服务端会话 id 校验
 * （`SESSION_ID_RE`，见 `app/api/agent/new/route.ts`），可直接当会话 id 用。
 */
export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
