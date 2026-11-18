// ─── MODAL SHELL ────────────────────────────────────────────────────────────
// The one dialog frame every overlay uses: backdrop, card, accent-bar header,
// body, optional footer — plus the dismissal behaviour, which is the real reason
// this exists. The frame used to be hand-copied into each modal, and the copies
// had drifted apart in exactly the part a driver feels: one closed on Escape and
// on Android's back button, one on Escape only, one on neither — and on a phone,
// back on the one that ignored it fell through to the hub's "walk to the
// Dashboard" layer and threw the dialog's pending action away with it.
//
// So every way out goes through one place and obeys one switch:
//   • backdrop click, Escape and Android back all call `onClose`;
//   • `dismissable={false}` (e.g. mid-upload) makes all three inert — and back
//     still CONSUMES the press while inert, since the alternative is the
//     activity being destroyed halfway through whatever the dialog is doing.
//
// Escape only reaches the TOP-most open shell, so a confirm opened over another
// dialog closes alone rather than taking its parent down with it.
//
// Focus moves into the dialog on open and returns to whatever had it on close,
// and Tab is held inside the card while it is up — without that, a keyboard
// user tabs straight back into the screen behind the backdrop.

import { useEffect, useId, useRef } from "react";
import { C, FONT } from "../lib/ui/tokens.js";
import { useAndroidBack } from "../hooks/useAndroidBack.js";

const openShells = [];

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const modalBtn = (kind = "secondary") => {
  const [border, bg, color] =
    kind === "primary" ? [C.blue, C.blue, C.onAccent]
    : kind === "danger" ? [C.red, C.red, "#fff"]
    : [C.borderStrong, C.surface, C.textMid];
  return {
    padding: "11px 22px", borderRadius: 9, border: `1px solid ${border}`, background: bg,
    color, fontSize: 12, fontWeight: 800, letterSpacing: 0.5, cursor: "pointer", fontFamily: FONT.ui,
  };
};

export const closeBtnStyle = {
  width: 34, height: 34, borderRadius: 8, border: `1px solid ${C.borderModal}`,
  background: C.surface, color: "#9aa3b5", fontSize: 16, cursor: "pointer", lineHeight: 1, flex: "none",
};

export default function ModalShell({
  title, subtitle, accent = C.accent, barHeight = 34,
  aside = null,            // extra header content, right-aligned before the close button
  showClose = false,       // render the ✕ in the header
  onClose, dismissable = true,
  width = 420, maxHeight = null, zIndex = 150,
  children, footer = null, footerStyle = null,
}) {
  const titleId = useId();
  const cardRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissRef = useRef(dismissable);
  dismissRef.current = dismissable;

  const tryClose = () => { if (dismissRef.current) closeRef.current?.(); };

  // Back always consumes the press while this is open — see the header.
  useAndroidBack(() => { tryClose(); return true; });

  useEffect(() => {
    const me = {};
    openShells.push(me);
    const prevFocus = document.activeElement;
    cardRef.current?.focus({ preventScroll: true });

    const onKey = (e) => {
      if (openShells[openShells.length - 1] !== me) return;
      if (e.key === "Escape") { e.stopPropagation(); tryClose(); return; }
      if (e.key !== "Tab" || !cardRef.current) return;
      const items = [...cardRef.current.querySelectorAll(FOCUSABLE)];
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === cardRef.current)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = openShells.indexOf(me);
      if (i >= 0) openShells.splice(i, 1);
      if (prevFocus && typeof prevFocus.focus === "function" && document.contains(prevFocus)) {
        prevFocus.focus({ preventScroll: true });
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div onClick={tryClose} style={{
      position: "fixed", inset: 0, zIndex, background: "rgba(5,7,11,.74)",
      backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: FONT.ui, padding: 24,
    }}>
      <div ref={cardRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        onClick={(e) => e.stopPropagation()} style={{
          width, maxWidth: "100%", ...(maxHeight && { maxHeight }), background: C.modal,
          border: `1px solid ${C.borderModal}`, borderRadius: 16, boxShadow: "0 30px 80px rgba(0,0,0,.6)",
          display: "flex", flexDirection: "column", overflow: "hidden", outline: "none",
        }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
          padding: "20px 24px", borderBottom: `1px solid ${C.line}`, flex: "none" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            <div style={{ width: 5, height: barHeight, borderRadius: 3, background: accent, flex: "none" }} />
            <div style={{ minWidth: 0 }}>
              <div id={titleId} style={{ fontSize: 17, fontWeight: 800, letterSpacing: 0.5, color: C.textHi }}>{title}</div>
              {subtitle && (
                <div style={{ fontSize: 10, letterSpacing: 1.6, color: C.textDim, textTransform: "uppercase", marginTop: 3 }}>{subtitle}</div>
              )}
            </div>
          </div>
          {(aside || showClose) && (
            <div style={{ display: "flex", alignItems: "center", gap: 16, flex: "none" }}>
              {aside}
              {showClose && (
                <button onClick={tryClose} aria-label="Close" disabled={!dismissable} style={closeBtnStyle}>✕</button>
              )}
            </div>
          )}
        </div>

        {children}

        {footer && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 12,
            padding: "16px 24px", borderTop: `1px solid ${C.line}`, background: C.bg, flex: "none", ...footerStyle }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// A yes/no question over the current screen. `danger` styles the confirm as
// destructive. Used for the irreversible actions (deleting a lap), which used to
// mix `window.confirm` on one screen with no confirmation at all on another.
export function ConfirmDialog({ title, children, confirmLabel = "Confirm", cancelLabel = "Cancel",
  danger = false, onConfirm, onCancel, zIndex = 160 }) {
  return (
    <ModalShell title={title} onClose={onCancel} accent={danger ? C.red : C.accent} zIndex={zIndex}
      footer={<>
        <button onClick={onCancel} style={modalBtn("secondary")}>{cancelLabel}</button>
        <button onClick={onConfirm} style={modalBtn(danger ? "danger" : "primary")}>{confirmLabel}</button>
      </>}>
      <div style={{ padding: "20px 24px", fontSize: 13, lineHeight: 1.65, color: C.textMid }}>{children}</div>
    </ModalShell>
  );
}
