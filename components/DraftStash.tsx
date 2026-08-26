"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  addDraft,
  formatRelativeTime,
  loadDrafts,
  removeDraft,
  updateDraft,
  type DraftItem,
} from "@/lib/draft-stash";
import styles from "./DraftStash.module.css";

/**
 * 用户级草稿暂存面板（自包含组件）。
 *
 * 通过 DOM 协议与聊天输入框交互（读取焦点 textarea 的值、用原生 setter
 * 写回并派发 input 事件让 React 同步），因此不修改 ChatInput 内部实现，
 * 接入仅需在输入框上方渲染 <DraftStash />。
 *
 * 快捷键（输入框聚焦时，window capture 阶段拦截）：
 *   Ctrl/Cmd+S      新增或更新草稿 + 清空输入框
 *   Ctrl/Cmd+Delete 有关联：清空 + 删除关联记录；无关联：仅清空
 *
 * 常态收起为一条计数条（点击展开/收起列表）；有草稿才显示。
 * 关联（回填后记住草稿 id，决定 Ctrl+S 是更新还是新增）在输入框内容
 * 被清空时自动解除：原生 input 事件 + Enter 发送后的延迟校验兜底
 * （React 受控组件自身清空不派发原生事件）。
 */

/** 当前聊天输入框：优先焦点所在 textarea，否则页面第一个 textarea */
function getChatTextarea(): HTMLTextAreaElement | null {
  if (document.activeElement instanceof HTMLTextAreaElement) {
    return document.activeElement;
  }
  return document.querySelector("textarea");
}

/** 写回 React 受控 textarea 的值（原生 setter + input 事件） */
function writeTextareaValue(ta: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (setter) setter.call(ta, text);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

function isEditingActive(activeId: string | null, items: DraftItem[]): activeId is string {
  return activeId !== null && items.some((d) => d.id === activeId);
}

/** 纯展示子组件：可独立测试 */
export function DraftStashList({
  items,
  expanded,
  activeItem,
  onToggle,
  onPick,
  onDelete,
  onCancelActive,
  panelRef,
}: {
  items: DraftItem[];
  expanded: boolean;
  activeItem: DraftItem | null;
  onToggle: () => void;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
  onCancelActive: () => void;
  panelRef?: React.RefObject<HTMLDivElement | null>;
}) {
  if (items.length === 0) return null;
  return (
    <div
      ref={panelRef}
      className={styles.panel}
      role="region"
      aria-label="TODO 暂存区"
    >
      <button
        type="button"
        className={`${styles.toggle}${expanded ? ` ${styles.toggleOpen}` : ""}`}
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={expanded ? "收起 TODO 列表" : "展开 TODO 列表"}
      >
        <svg
          width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          strokeLinejoin="round" aria-hidden="true"
          style={{ display: "block", flexShrink: 0 }}
        >
          <rect x="2" y="2" width="12" height="12" rx="3" />
          <path d="M5.5 8.2l1.8 1.8 3.4-3.6" />
        </svg>
        <span className={styles.toggleLabel}>TODO {items.length}</span>
        <span className={styles.toggleArrow} aria-hidden="true">{expanded ? "▴" : "▾"}</span>
      </button>
      {expanded && (
        <div className={styles.expandArea}>
          {activeItem && (
            <div className={styles.activeBar}>
              <span className={styles.activeDot} />
              <span className={styles.activeLabel}>正在编辑 TODO</span>
              <button
                type="button"
                className={styles.cancelBtn}
                onClick={onCancelActive}
                title="取消关联（内容保留在输入框）"
                aria-label="取消 TODO 关联"
              >
                ✕
              </button>
            </div>
          )}
          <div className={styles.list}>
            {items.map((item) => (
              <div key={item.id} className={styles.row}>
                <span className={styles.content} title={item.content}>
                  {item.content}
                </span>
                <span className={styles.time}>{formatRelativeTime(item.updatedAt)}</span>
                {/* 注入 + 删除 归并在一侧，方便点击 */}
                <span className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => onPick(item.id)}
                    title="回填到输入框"
                    aria-label="回填到输入框"
                  >
                    <svg
                      width="11" height="11" viewBox="0 0 10 10" fill="none"
                      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
                    >
                      <path d="M9 5 H1" />
                      <polyline points="4 1.5 1 5 4 8.5" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnDanger}`}
                    onClick={() => onDelete(item.id)}
                    title="删除 TODO"
                    aria-label="删除 TODO"
                  >
                    <svg
                      width="12" height="12" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                    >
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      <line x1="10" y1="11" x2="10" y2="17" />
                      <line x1="14" y1="11" x2="14" y2="17" />
                    </svg>
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function DraftStash() {
  const [items, setItems] = useState<DraftItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // 浮层化后：点击组件外部关闭
  useEffect(() => {
    if (!expanded) return;
    const onMouseDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setExpanded(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [expanded]);

  const itemsRef = useRef(items);
  const activeIdRef = useRef(activeId);
  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  useEffect(() => { setItems(loadDrafts()); }, []);

  const refresh = useCallback(() => setItems(loadDrafts()), []);

  // 输入框内容被清空（用户手动删除 / Ctrl+S 保存后 / 回填保护写入空）→ 解除关联
  useEffect(() => {
    const onInput = (e: Event) => {
      const ta = e.target;
      if (!(ta instanceof HTMLTextAreaElement)) return;
      if (!ta.value.trim() && activeIdRef.current) setActiveId(null);
    };
    document.addEventListener("input", onInput, true);
    return () => document.removeEventListener("input", onInput, true);
  }, []);

  // 全局快捷键（capture 先于 React 合成事件；仅焦点在 textarea 时生效）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey || e.shiftKey) return;
      const ta =
        document.activeElement instanceof HTMLTextAreaElement
          ? document.activeElement
          : null;
      if (!ta) return;

      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!ta.value.trim()) return;
        const active = activeIdRef.current;
        if (isEditingActive(active, itemsRef.current)) {
          updateDraft(active, ta.value);
        } else {
          addDraft(ta.value);
        }
        setActiveId(null);
        refresh();
        writeTextareaValue(ta, "");
        return;
      }

      if (e.key === "Delete") {
        e.preventDefault();
        const active = activeIdRef.current;
        if (isEditingActive(active, itemsRef.current)) {
          removeDraft(active);
          setActiveId(null);
          refresh();
        }
        writeTextareaValue(ta, "");
        return;
      }

      // Enter 发送（React 受控清空不派发原生事件）→ 下一 tick 校验输入框为空则解除关联
      if (e.key === "Enter" && !e.shiftKey && activeIdRef.current) {
        setTimeout(() => {
          if (!ta.value.trim()) setActiveId(null);
        }, 0);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [refresh]);

  const handlePick = useCallback(
    (id: string) => {
      const target = itemsRef.current.find((d) => d.id === id);
      if (!target) return;
      const ta = getChatTextarea();
      if (!ta) return;
      // 回填前保护：输入框当前内容先暂存（有关联则更新原记录，无则新增）
      if (ta.value.trim()) {
        const active = activeIdRef.current;
        if (isEditingActive(active, itemsRef.current)) {
          updateDraft(active, ta.value);
        } else {
          addDraft(ta.value);
        }
      }
      setActiveId(id);
      refresh();
      writeTextareaValue(ta, target.content);
      ta.focus();
    },
    [refresh],
  );

  const handleDelete = useCallback(
    (id: string) => {
      removeDraft(id);
      if (activeIdRef.current === id) setActiveId(null);
      refresh();
    },
    [refresh],
  );

  if (items.length === 0) return null;

  const activeItem =
    activeId !== null
      ? (items.find((d) => d.id === activeId) ?? null)
      : null;

  return (
    <DraftStashList
      items={items}
      expanded={expanded}
      activeItem={activeItem}
      onToggle={() => setExpanded((open) => !open)}
      onPick={handlePick}
      onDelete={handleDelete}
      onCancelActive={() => setActiveId(null)}
      panelRef={panelRef}
    />
  );
}

export default DraftStash;
