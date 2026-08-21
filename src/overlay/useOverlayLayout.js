// ─── OVERLAY LAYOUT ──────────────────────────────────────────────────────────
// Where each widget sits, how big it is, and whether it is shown — persisted so a
// driver arranges their HUD once and it comes back that way.
//
// Stored in localStorage rather than through the Rust side because the overlay is
// same-origin with the main app: the layout survives a restart, and the main
// window could read it later (for a layout editor on the Settings screen) with no
// new plumbing.
//
// SIZE IS A SCALE, NOT A WIDTH+HEIGHT. Each widget declares a design size and is
// drawn at `transform: scale(k)`. Dragging the corner changes k. That is what a
// HUD actually wants — "make the delta bigger" means bigger DIGITS, and a
// free-form width/height box gives you a wider panel with the same small text in
// it, plus a reflow to get wrong at every intermediate size.

import { useCallback, useEffect, useRef, useState } from "react";

const LS_KEY = "f1coach.overlay.layout";
const MIN_SCALE = 0.6;
const MAX_SCALE = 3;

/** Defaults merged UNDER whatever is stored, so a widget added in a later build
 *  appears at its default spot instead of being missing from an old saved layout. */
function initialLayout(widgets) {
  const base = {};
  for (const w of widgets) base[w.id] = { ...w.defaults };
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch {}
  if (stored && typeof stored === "object") {
    for (const id of Object.keys(base)) {
      const s = stored[id];
      if (s && typeof s === "object") base[id] = { ...base[id], ...s };
    }
  }
  return base;
}

export function useOverlayLayout(widgets) {
  const [layout, setLayout] = useState(() => initialLayout(widgets));

  // Persist on every settled change. Writes are small and rare (only while the
  // driver is actually dragging), so there is nothing here worth debouncing.
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(layout)); } catch {}
  }, [layout]);

  const update = useCallback((id, patch) => {
    setLayout(l => ({ ...l, [id]: { ...l[id], ...patch } }));
  }, []);

  const toggle = useCallback((id) => {
    setLayout(l => ({ ...l, [id]: { ...l[id], on: !l[id].on } }));
  }, []);

  const reset = useCallback(() => {
    const base = {};
    for (const w of widgets) base[w.id] = { ...w.defaults };
    setLayout(base);
  }, [widgets]);

  return { layout, update, toggle, reset };
}

/**
 * Pointer drag for one widget: body drags, corner scales.
 *
 * Uses pointer capture so a fast drag that outruns the cursor still tracks — the
 * overlay is a full-screen window, so losing the pointer mid-drag would otherwise
 * strand a widget under the mouse with no button held.
 */
export function useDragScale({ id, box, update, designW, enabled }) {
  const dragRef = useRef(null);

  const onPointerDown = useCallback((e, mode) => {
    if (!enabled) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      mode, pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      origX: box.x, origY: box.y, origScale: box.scale,
    };
  }, [enabled, box.x, box.y, box.scale]);

  const onPointerMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.mode === "move") {
      // Clamped so a widget can never be dragged fully off-screen and become
      // unreachable — there is no window chrome here to scroll it back.
      const maxX = Math.max(0, window.innerWidth - 40);
      const maxY = Math.max(0, window.innerHeight - 40);
      update(id, {
        x: Math.min(maxX, Math.max(0, d.origX + dx)),
        y: Math.min(maxY, Math.max(0, d.origY + dy)),
      });
    } else {
      const w = designW * d.origScale + dx;
      update(id, { scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, w / designW)) });
    }
  }, [id, update, designW]);

  const onPointerUp = useCallback((e) => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp };
}
