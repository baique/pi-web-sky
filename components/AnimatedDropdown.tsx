"use client";

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

export const DROPDOWN_ANIMATION_MS = 140;

/**
 * Animated dropdown shell: mounts on open with a fade + slide-in, unmounts
 * after the close animation. `up` flips the slide direction and transform
 * origin for menus that grow above their trigger. Positioning is fully
 * controlled by the caller through `style` (absolute/fixed + top/bottom).
 */
export function AnimatedDropdown({ open, children, style, up = false }: { open: boolean; children: ReactNode; style: CSSProperties; up?: boolean }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    let frame: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (open) {
      setMounted(true);
      setVisible(false);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      timeout = setTimeout(() => setMounted(false), DROPDOWN_ANIMATION_MS);
    }

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (timeout) clearTimeout(timeout);
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      style={{
        ...style,
        opacity: visible ? 1 : 0,
        transform: visible
          ? "translateY(0) scale(1)"
          : up ? "translateY(8px) scale(0.96)" : "translateY(-8px) scale(0.96)",
        transformOrigin: up ? "bottom center" : "top center",
        transition: `opacity ${DROPDOWN_ANIMATION_MS}ms ease, transform ${DROPDOWN_ANIMATION_MS}ms ease`,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}