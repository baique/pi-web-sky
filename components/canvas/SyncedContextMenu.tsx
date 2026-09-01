"use client";

import {
  ContextMenu as _ContextMenu,
} from "radix-ui";
import {
  DefaultContextMenuContent,
  TldrawUiMenuContextProvider,
  TldrawUiMenuGroup,
  TldrawUiMenuItem,
  preventDefault,
  useContainer,
  useDirection,
  useEditor,
  useEditorComponents,
  useMenuIsOpen,
  useTranslation,
  useValue,
} from "tldraw";
import { memo, useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useBoardId } from "./TaskCardShape";
import { confirm } from "./ConfirmDialog";
import { dispatchBoardBaseUpdated, dispatchBoardSessionDeleted } from "@/lib/board-events";

/**
 * 受控化的 ContextMenu（替代 tldraw 默认 DefaultContextMenu）。
 *
 * 背景：tldraw 5.3.2 依赖 `radix-ui ^1.4.2`，项目解析到 1.6.x 后触发
 * tldraw#10566 —— Radix ContextMenu 的 internal open state 与 tldraw 的
 * `editor.menus` 失同步：
 *   1. 右键打开菜单 → Radix open=true，tlmenus 记 'context menu'
 *   2. 左键点击画布关闭 → MenuClickCapture 只 `clearOpenMenus()`（清 tlmenus，
 *      不通知 Radix），且 tlmenus 变化导致 `{isOpen && <Content>}` 卸载、
 *      DismissableLayer 消失，Radix 失去 outside-click 关闭通道
 *   3. Radix internal open 卡在 true → 此后任何右键的 handleOpen 都不再生效
 *      （菜单永远打不开，直到切 tab/焦点变化）
 * 用 Escape 关闭走 Radix 正常路径，不触发。
 *
 * 修复（与官方 #10567 同思路）：把 Radix Root 改为**受控** `open={isOpen}`，
 * isOpen 派生自 tlmenus。菜单被 clearOpenMenus 清掉时 isOpen→false，
 * 受控 prop 直接驱动 Radix setOpen(false)，internal state 复位，后续右键正常。
 *
 * 其余逻辑完整复刻 tldraw 默认实现（menuCanOpen / Escape 防失焦 / 粗指针长按 / portal）。
 */
const TASK_LINK_LABELS = new Set(["prerequisite", "related"]);

/**
 * 右键菜单内容：选中对象含派生连线（依赖线 meta.taskLinkLabel / 执行会话线 meta.execLinkLabel）
 * 时只显示只读提示，不提供删除等操作（派生边禁删，由真相源 reconcile）；否则默认菜单。
 */
function BoardContextMenuContent() {
  const editor = useEditor();
  const boardId = useBoardId();
  const selected = useValue("ctx-selection", () => editor.getSelectedShapes(), [editor]);
  const derived = selected
    .map((s) => s.meta as { taskLinkLabel?: string; execLinkLabel?: string } | undefined)
    .find((meta) => (meta?.taskLinkLabel !== undefined && TASK_LINK_LABELS.has(meta.taskLinkLabel)) || meta?.execLinkLabel !== undefined);
  // 选中的会话卡（sessionId 非空）：右键菜单提供「删除会话」（确认制，原子-链接：删卡=删会话）
  const sessionTargets = selected
    .filter((s) => s.type === "session-card")
    .map((s) => ({ shapeId: s.id as string, sid: (s.props as { sessionId?: string }).sessionId }))
    .filter((t): t is { shapeId: string; sid: string } => Boolean(t.sid));

  const handleDeleteSessions = async (targets: Array<{ shapeId: string; sid: string }>) => {
    const message = targets.length > 1
      ? `删除 ${targets.length} 个会话？\n将同时删除画布卡片并断开任务卡关联。此操作不可撤销。`
      : "删除该会话？\n将同时删除画布卡片并断开任务卡关联。此操作不可撤销。";
    if (!(await confirm({ message }))) return;
    for (const t of targets) {
      // 乐观删除：直接 store.remove（绕过 deleteShapes 的 run/guard，确认即删）
      editor.store.remove([t.shapeId as never]);
      void fetch(`/api/sessions/${encodeURIComponent(t.sid)}`, { method: "DELETE" })
        .then((r) => r.json().catch(() => null))
        .then((j: { updatedBoards?: Record<string, number> } | null) => {
          // 删除 bump 了受影响看板 updated：派发事件刷新乐观锁基线，防后续防抖保存 409
          const b = j?.updatedBoards;
          if (b) for (const [bid, u] of Object.entries(b)) dispatchBoardBaseUpdated(bid, u);
          dispatchBoardSessionDeleted(t.sid); // 通知侧栏：左侧树移除该会话
        })
        .catch((e) => console.warn(`[board] 删除会话 ${t.sid} 异常`, e));
    }
  };

  // 选中的已建任务卡（cardId 非空）：右键菜单提供「删除任务卡」（确认制）
  const taskCardTargets = selected
    .filter((s) => s.type === "task-card")
    .map((s) => ({ shapeId: s.id as string, cardId: (s.props as { cardId?: string }).cardId }))
    .filter((t): t is { shapeId: string; cardId: string } => Boolean(t.cardId));

  const handleDeleteTaskCards = async (targets: Array<{ shapeId: string; cardId: string }>) => {
    const message = targets.length > 1
      ? `删除 ${targets.length} 张任务卡？\n将删除卡/依赖线/执行会话连线；关联的执行会话保留。`
      : "删除该任务卡？\n将删除任务卡、依赖线与执行会话连线；关联的执行会话保留。此操作不可撤销。";
    if (!(await confirm({ message }))) return;
    for (const t of targets) {
      // 乐观删除：直接 store.remove（绕过 deleteShapes 的 run/guard，确认即删）
      editor.store.remove([t.shapeId as never]);
      void fetch(`/api/task-cards/${encodeURIComponent(t.cardId)}`, { method: "DELETE" })
        .then((r) => r.json().catch(() => null))
        .then((j: { updated?: number | null } | null) => {
          // 删除 bump 了看板 updated：派发事件刷新乐观锁基线，防后续防抖保存 409
          if (typeof j?.updated === "number" && boardId) dispatchBoardBaseUpdated(boardId, j.updated);
        })
        .catch((e) => console.warn(`[board] 删除任务卡 ${t.cardId} 异常`, e));
    }
  };

  if (!derived && taskCardTargets.length === 0 && sessionTargets.length === 0) {
    return <DefaultContextMenuContent />;
  }
  const label = derived?.execLinkLabel ? "执行会话连线（自动生成，不可删除）" : "依赖连线（自动生成，不可删除）";
  return (
    <TldrawUiMenuContextProvider type="menu" sourceId="context-menu">
      {derived && (
        <TldrawUiMenuGroup id="task-link">
          <TldrawUiMenuItem id="task-link-readonly" label={label} disabled noClose onSelect={() => {}} />
        </TldrawUiMenuGroup>
      )}
      {sessionTargets.length > 0 && (
        <TldrawUiMenuGroup id="session-delete">
          <TldrawUiMenuItem
            id="delete-session"
            label={sessionTargets.length > 1 ? `删除 ${sessionTargets.length} 个会话` : "删除会话"}
            onSelect={() => void handleDeleteSessions(sessionTargets)}
          />
        </TldrawUiMenuGroup>
      )}
      {taskCardTargets.length > 0 && (
        <TldrawUiMenuGroup id="task-card-delete">
          <TldrawUiMenuItem
            id="delete-task-card"
            label={taskCardTargets.length > 1 ? `删除 ${taskCardTargets.length} 张任务卡` : "删除任务卡"}
            onSelect={() => void handleDeleteTaskCards(taskCardTargets)}
          />
        </TldrawUiMenuGroup>
      )}
    </TldrawUiMenuContextProvider>
  );
}

export const SyncedContextMenu = memo(function SyncedContextMenu({
  children,
  disabled = false,
}: {
  children?: ReactNode;
  disabled?: boolean;
}) {
  const editor = useEditor();
  const msg = useTranslation();
  const { Canvas } = useEditorComponents();

  // 同 tldraw 默认：右键（fine pointer）任何工具都开；粗指针长按仅 select 工具开。
  const menuCanOpen = useValue(
    "context menu can open",
    () => !editor.getInstanceState().isCoarsePointer || editor.isIn("select"),
    [editor]
  );

  // Escape 打开菜单时防止失去 shape 焦点（无障碍体验）
  const preventEscapeFromLosingShapeFocus = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        editor.getContainer().focus();
      }
    },
    [editor]
  );

  useEffect(() => {
    const body = editor.getContainer().ownerDocument.body;
    return () => {
      body.removeEventListener("keydown", preventEscapeFromLosingShapeFocus, {
        capture: true,
      });
    };
  }, [editor, preventEscapeFromLosingShapeFocus]);

  // 粗指针（touch）长按打开菜单后，同一次触摸释放会被 DismissableLayer 当 outside 关掉；
  // 打开后短暂抑制 dismiss，直到用户真正再交互。
  const suppressDismissUntilRef = useRef(0);

  const cb = useCallback(
    (isOpen: boolean) => {
      const body = editor.getContainer().ownerDocument.body;
      if (!isOpen) {
        const onlySelectedShape = editor.getOnlySelectedShape();
        if (onlySelectedShape && editor.isShapeOrAncestorLocked(onlySelectedShape)) {
          editor.setSelectedShapes([]);
        }
        editor.timers.requestAnimationFrame(() => {
          body.removeEventListener("keydown", preventEscapeFromLosingShapeFocus, {
            capture: true,
          });
        });
      } else {
        body.addEventListener("keydown", preventEscapeFromLosingShapeFocus, {
          capture: true,
        });
        if (editor.getInstanceState().isCoarsePointer) {
          suppressDismissUntilRef.current = Date.now() + 500;
          // 长按选中 locked shape 的特殊路径
          const selectedShapes = editor.getSelectedShapes();
          const currentPagePoint = editor.inputs.getCurrentPagePoint();
          const shapesAtPoint = editor.getShapesAtPoint(currentPagePoint);
          if (
            !editor.getSelectedShapes().length ||
            !shapesAtPoint.some((s) => selectedShapes.includes(s))
          ) {
            const lockedShapes = shapesAtPoint.filter((s) =>
              editor.isShapeOrAncestorLocked(s)
            );
            if (lockedShapes.length) {
              editor.select(...lockedShapes.map((s) => s.id));
            }
          }
        }
      }
    },
    [editor, preventEscapeFromLosingShapeFocus]
  );

  const container = useContainer();
  const dir = useDirection();
  // isOpen 派生自 tlmenus —— 受控 key：clearOpenMenus 清 tlmenus 时 isOpen→false，
  // 驱动 Radix setOpen(false) 复位 internal state（修复 tldraw#10566 失同步）
  const [isOpen, handleOpenChange] = useMenuIsOpen("context menu", cb);

  const content = children ?? <BoardContextMenuContent />;

  return (
    <_ContextMenu.Root
      dir={dir}
      open={isOpen}
      onOpenChange={handleOpenChange}
      modal={false}
    >
      <_ContextMenu.Trigger
        onContextMenu={menuCanOpen ? undefined : preventDefault}
        dir="ltr"
        disabled={disabled || !menuCanOpen}
      >
        {Canvas ? <Canvas /> : null}
      </_ContextMenu.Trigger>
      {isOpen && (
        <_ContextMenu.Portal container={container}>
          <_ContextMenu.Content
            className="tlui-menu tlui-scrollable"
            data-testid="context-menu"
            aria-label={msg("context-menu.title")}
            alignOffset={-4}
            collisionPadding={4}
            onContextMenu={preventDefault}
            onPointerDownOutside={(e) => {
              if (Date.now() < suppressDismissUntilRef.current) e.preventDefault();
            }}
            onInteractOutside={(e) => {
              if (Date.now() < suppressDismissUntilRef.current) e.preventDefault();
            }}
            onFocusOutside={(e) => {
              if (Date.now() < suppressDismissUntilRef.current) e.preventDefault();
            }}
          >
            <TldrawUiMenuContextProvider type="context-menu" sourceId="context-menu">
              {content}
            </TldrawUiMenuContextProvider>
          </_ContextMenu.Content>
        </_ContextMenu.Portal>
      )}
    </_ContextMenu.Root>
  );
});
