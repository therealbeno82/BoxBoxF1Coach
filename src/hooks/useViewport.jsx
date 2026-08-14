// ─── VIEWPORT / BREAKPOINTS ───────────────────────────────────────────────────
// The app styles with inline React style objects, which cannot carry media
// queries — so anything that must CHANGE STRUCTURE at a breakpoint has to know
// the size in JS. That's the job here: the top nav pill becoming a bottom tab
// bar, modals becoming full-screen sheets, a two-column card stacking to one.
//
// Pure SIZING (a grid's column count, a font size, a tap target) should NOT come
// through this hook — those live as CSS custom properties in index.html's :root
// with real @media blocks, which cost no re-render. Use this only where the
// markup itself differs.
//
// ONE provider, deliberately. Twenty components each running their own
// matchMedia listener would each re-render independently on every resize; this
// way a rotation is a single state change at the root.

import { createContext, useContext, useEffect, useMemo, useState } from "react";

// Phone < 640 ≤ tablet < 1024 ≤ desktop. The desktop floor matches the native
// window's `minWidth: 1024` (src-tauri/tauri.conf.json), so the desktop build
// can never render a narrower branch than it was designed for.
const PHONE_MAX = 639;
const TABLET_MAX = 1023;
// A phone held in landscape reads as "tablet" by width (e.g. 904×407 CSS px) but
// has no vertical room for a header plus a bottom tab bar plus content. Height,
// not width, is the constraint there. The native window's `minHeight: 720` puts
// this out of the desktop build's reach entirely — but a browser can still be
// sized into it, which is how the branch gets verified without a device.
const SHORT_MAX = 500;

const ViewportCtx = createContext(null);

function read() {
  if (typeof window === "undefined") return { w: 1280, h: 800, coarse: false };
  return {
    w: window.innerWidth,
    h: window.innerHeight,
    // `hover: none` is the honest test for "finger, not mouse" — it drives the
    // tooltip and tap-target treatment, and is independent of size (a touch
    // laptop is wide AND coarse).
    coarse: window.matchMedia?.("(hover: none)")?.matches ?? false,
  };
}

export function ViewportProvider({ children }) {
  const [vp, setVp] = useState(read);

  useEffect(() => {
    let raf = 0;
    const onResize = () => {
      // Coalesce to one read per frame: a drag-resize fires resize continuously,
      // and this sits above the whole tree.
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const next = read();
        // Bail when nothing actually moved, so a no-op resize doesn't re-render
        // every screen.
        setVp((prev) =>
          prev.w === next.w && prev.h === next.h && prev.coarse === next.coarse ? prev : next
        );
      });
    };
    window.addEventListener("resize", onResize);
    // Some Android browsers report stale innerWidth during the rotation itself.
    window.addEventListener("orientationchange", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  const value = useMemo(() => {
    const phone = vp.w <= PHONE_MAX;
    const tablet = vp.w > PHONE_MAX && vp.w <= TABLET_MAX;
    const landscape = vp.w > vp.h;
    const shortViewport = vp.h <= SHORT_MAX;
    return {
      w: vp.w,
      h: vp.h,
      phone,
      tablet,
      desktop: vp.w > TABLET_MAX,
      /** Phone OR tablet — i.e. "not the layout this app was designed for". */
      compact: vp.w <= TABLET_MAX,
      coarse: vp.coarse,
      landscape,
      shortViewport,
      /** Nav belongs down the SIDE, not across the top or bottom. Named as a
       *  layout mode rather than left to each caller to re-derive, because the
       *  Shell draws it and the screens have to agree there is no header above
       *  them. Both halves are load-bearing: `shortViewport` alone would put a
       *  rail down a 375×400 window, where 72px of a 375px width is far dearer
       *  than the row of tabs it replaced. */
      rail: shortViewport && landscape,
    };
  }, [vp]);

  return <ViewportCtx.Provider value={value}>{children}</ViewportCtx.Provider>;
}

/** Falls back to desktop values when no provider is mounted, so a component
 *  rendered outside the tree (or in a test) behaves as it always did. */
export function useViewport() {
  return (
    useContext(ViewportCtx) ?? {
      w: 1280,
      h: 800,
      phone: false,
      tablet: false,
      desktop: true,
      compact: false,
      coarse: false,
      landscape: true,
      shortViewport: false,
      rail: false,
    }
  );
}
