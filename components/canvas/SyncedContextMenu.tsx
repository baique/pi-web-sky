"use client";

import {
  ContextMenu as _ContextMenu,
} from "radix-ui";
import {
  DefaultContextMenuContent,
  TldrawUiMenuContextProvider,
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

  const content = children ?? <DefaultContextMenuContent />;

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
