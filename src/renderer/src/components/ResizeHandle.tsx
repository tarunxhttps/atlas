import { useCallback, useEffect, useState } from "react";

interface Props {
  /** Which edge of the panel the handle sits on; dragging away from the panel grows it. */
  edge: "left" | "right";
  width: number;
  onResize: (width: number) => void;
  onReset: () => void;
  /** Dragging below this closes the panel instead (VS Code-style), restoring the width it had before the drag. */
  collapseBelow?: number;
  onCollapse?: () => void;
}

/** A VS Code-style sash: drag to resize the neighbouring panel, double-click to reset it. */
export function ResizeHandle({ edge, width, onResize, onReset, collapseBelow, onCollapse }: Props) {
  const [drag, setDrag] = useState<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    if (!drag) return;
    const onMove = (event: PointerEvent) => {
      const delta = event.clientX - drag.startX;
      const next = drag.startWidth + (edge === "right" ? delta : -delta);
      if (collapseBelow !== undefined && onCollapse && next < collapseBelow) {
        onResize(drag.startWidth);
        setDrag(null);
        onCollapse();
        return;
      }
      onResize(next);
    };
    const onUp = () => setDrag(null);
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      document.body.classList.remove("resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, edge, onResize, collapseBelow, onCollapse]);

  const start = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      setDrag({ startX: event.clientX, startWidth: width });
    },
    [width],
  );

  return (
    <div
      className={`resize-handle ${edge} ${drag ? "dragging" : ""}`}
      onPointerDown={start}
      onDoubleClick={onReset}
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize · double-click to reset"
    />
  );
}

/** A panel width kept between launches; clamped so the canvas never gets squeezed out. */
export function usePanelWidth(storageKey: string, fallback: number, min: number, max: () => number) {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      return saved > 0 ? saved : fallback;
    } catch {
      return fallback;
    }
  });
  const clamp = useCallback((value: number) => Math.round(Math.min(Math.max(value, min), Math.max(min, max()))), [min, max]);

  const update = useCallback(
    (value: number) => {
      const next = clamp(value);
      setWidth(next);
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {
        // Storage can be unavailable; the width still applies for this session.
      }
    },
    [clamp, storageKey],
  );

  return { width: clamp(width), setWidth: update, reset: () => update(fallback) };
}
