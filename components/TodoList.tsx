"use client";

import type { TodoItem } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";

/**
 * 会话 TODO 面板的内容本体 —— 表头（标题 + N/M 已完成）、空态、条目列表。
 *
 * 两个浮层共用同一份内容，只有外壳与定位不同：
 * - `AppShell`：顶栏右上角，自己算 `position: fixed` 的 top/right
 * - `canvas/SessionNavBar`：看板卡片顶栏，按 navWidth 锚定
 *
 * 只渲染内容，定位和玻璃外壳留在调用方。改圆点/删除线/空态文案只改这里。
 */
export function TodoList({ todos }: { todos: TodoItem[] }) {
  const { t } = useI18n();
  const completedCount = todos.filter((todo) => todo.status === "completed").length;

  return (
    <>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "9px 12px",
        borderBottom: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
        fontSize: 12, fontWeight: 650, color: "var(--text)",
      }}>
        {t("todo.title")}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-meta)", fontWeight: 500 }}>
          {completedCount}/{todos.length} {t("todo.completed")}
        </span>
      </div>
      {todos.length === 0 ? (
        <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
          {t("todo.empty")}
        </div>
      ) : (
        <div style={{ maxHeight: 330, overflowY: "auto" }}>
          {todos.map((todo) => {
            const done = todo.status === "completed";
            return (
              <div
                key={todo.id ?? todo.content}
                style={{
                  display: "flex", alignItems: "flex-start", gap: 8,
                  padding: "7px 12px",
                  borderBottom: "1px solid color-mix(in srgb, var(--border) 45%, transparent)",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    flexShrink: 0, marginTop: 2,
                    width: 13, height: 13, borderRadius: 4,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 10, fontWeight: 800, lineHeight: 1,
                    color: done ? "#fff" : "transparent",
                    background: done ? "#16a34a" : "color-mix(in srgb, var(--border) 70%, transparent)",
                    border: done ? "none" : "1px solid color-mix(in srgb, var(--border) 80%, transparent)",
                  }}
                >
                  ✓
                </span>
                <span style={{
                  flex: 1, minWidth: 0,
                  fontSize: 12, lineHeight: 1.4,
                  color: done ? "var(--text-meta)" : "var(--text)",
                  textDecoration: done ? "line-through" : "none",
                  wordBreak: "break-word",
                }}>
                  {todo.content}
                </span>
                {/* 状态点：只有 in_progress 才出现（pending 不占位、completed 由左侧绿框表达） */}
                {todo.status === "in_progress" && (
                  <span
                    aria-hidden="true"
                    style={{ flexShrink: 0, marginTop: 5, width: 7, height: 7, borderRadius: "50%", background: "var(--accent)" }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
