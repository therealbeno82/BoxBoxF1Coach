// ─── HINT ─────────────────────────────────────────────────────────────────────
// A `title=` that a finger can also read.
//
// The app carries ~70 `title` attributes. Most sit on buttons whose icon and
// context already say what they do ("Zoom in", "Play"), and turning those into
// tappable badges would add chrome to the screens with the least room for it. The
// ones worth converting are the INFORMATIONAL ones on non-interactive elements —
// why a lap is struck through, what a tyre chip's age and wear are, what the
// call-lead slider actually does. On a mouse those are one hover away; on a phone
// they were unreachable.
//
// So: fine pointer keeps the native tooltip, unchanged. Coarse pointer taps to
// open a bubble. Only wrap elements that DON'T already handle taps — a wrapper
// around a button would eat its click, and a disabled button swallows the event
// before it reaches this wrapper at all (those few reasons need visible text
// instead, not a hint).
//
// The bubble is portalled to <body> and positioned in viewport coordinates: these
// live inside lap rows and overlay cards, several of which clip their overflow,
// and a bubble that gets cut in half is worse than no bubble.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useViewport } from "../hooks/useViewport.jsx";
import { C, FONT } from "../lib/ui/tokens.js";

const MAX_W = 260;
const GAP = 8;

export default function Hint({ text, children, style, as: Tag = "span", ...rest }) {
  const { coarse } = useViewport();
  const [at, setAt] = useState(null);   // { x, y, above } in viewport px, null = closed
  const ref = useRef(null);

  useEffect(() => {
    if (!at) return;
    // Any next touch anywhere dismisses — including one on another hint, which
    // then opens its own. `capture` so it fires before the new hint's onClick.
    const close = () => setAt(null);
    document.addEventListener("pointerdown", close, { capture: true });
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", close, { capture: true });
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [at]);

  if (!text) return <Tag ref={ref} style={style} {...rest}>{children}</Tag>;
  if (!coarse) return <Tag ref={ref} title={text} style={style} {...rest}>{children}</Tag>;

  const open = (e) => {
    e.stopPropagation();
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    // Prefer above; flip below when there isn't room, which is most of the time
    // for a chip in the top card of a screen.
    const above = r.top > 120;
    setAt({
      x: Math.min(Math.max(GAP, r.left), Math.max(GAP, window.innerWidth - MAX_W - GAP)),
      y: above ? r.top - GAP : r.bottom + GAP,
      above,
    });
  };

  return (
    <>
      <Tag ref={ref} onClick={open} style={{ cursor: "pointer", ...style }} {...rest}>
        {children}
      </Tag>
      {at && createPortal(
        <div role="tooltip" style={{
          position: "fixed", left: at.x, top: at.y, zIndex: 400,
          ...(at.above ? { transform: "translateY(-100%)" } : null),
          maxWidth: MAX_W, background: "#0f1420f2", border: `1px solid ${C.borderStrong}`,
          borderRadius: 8, padding: "8px 10px", boxShadow: "0 8px 24px rgba(0,0,0,.55)",
          fontFamily: FONT.ui, fontSize: 11, lineHeight: 1.5, color: C.textBody2,
          // The bubble is a read-out, never a target: a tap meant for whatever is
          // under it must not be stolen by the thing explaining it.
          pointerEvents: "none",
        }}>{text}</div>,
        document.body
      )}
    </>
  );
}
