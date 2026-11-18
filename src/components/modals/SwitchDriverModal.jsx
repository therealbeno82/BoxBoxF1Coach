// ─── SWITCH DRIVER MODAL ────────────────────────────────────────────────────
// Pick the active cockpit driver. Each roster row shows the driver's livery
// number tile, name/team, and their best lap + lap count (loaded per-driver from
// the lap store on open). Footer jumps to the Settings roster to sign a new one.
// Escape, Android back and the backdrop all close it (ModalShell).

import { useEffect, useState } from "react";
import { C, FONT } from "../../lib/ui/tokens.js";
import { formatLapTime } from "../../lib/format.js";
import * as lapStore from "../../lib/lapStore.js";
import { isDemoLap, isRankable } from "../../lib/driverStats.js";
import ModalShell from "../ModalShell.jsx";

// A driver's roster figures: their best lap and how many they've recorded. The
// best follows the SAME rules as every board in the app — a demo replay or a
// game-invalidated lap never counts (isDemoLap / isRankable) — where it used to
// take the minimum over everything with a time, so a replayed lap could show as
// a driver's best here and nowhere else.
function rosterStats(laps) {
  const driven = laps.filter((l) => !isDemoLap(l));
  const ranked = driven.filter((l) => typeof l.lapTime === "number" && l.lapTime > 0 && isRankable(l));
  return {
    best: ranked.length ? Math.min(...ranked.map((l) => l.lapTime)) : null,
    laps: driven.length,
  };
}

export default function SwitchDriverModal({ drivers = [], activeDriver, activeLaps = null, avatars = {}, onPick, onClose, onSignUp }) {
  // name → { best:number|null, laps:number }
  const [stats, setStats] = useState({});

  useEffect(() => {
    let cancelled = false;
    // The active driver's laps are already in memory (the hub passes them), so
    // only the others are read — in parallel rather than one after another.
    // (Each read still loads full laps, samples and all; a metadata-only store
    // is the real fix and a separate piece of work.)
    Promise.all(drivers.map(async (d) => [
      d.name,
      rosterStats(d.name === activeDriver && activeLaps ? activeLaps : await lapStore.getLaps(d.name)),
    ])).then((rows) => { if (!cancelled) setStats(Object.fromEntries(rows)); });
    return () => { cancelled = true; };
  }, [drivers, activeDriver, activeLaps]);

  return (
    <ModalShell title="Switch Driver" accent={C.blue} showClose onClose={onClose} width={560} maxHeight="84%" zIndex={130}
      subtitle={`Sign In · ${drivers.length} ${drivers.length === 1 ? "Profile" : "Profiles"} On Roster`}
      footerStyle={{ justifyContent: "space-between", gap: 14, padding: "16px 22px" }}
      footer={<>
        <span style={{ fontSize: 11, color: C.textDim }}>Need a new profile?</span>
        <button onClick={() => { onSignUp?.(); onClose(); }} style={{
          display: "flex", alignItems: "center", gap: 8, padding: "11px 18px", borderRadius: 9,
          border: `1px dashed ${C.borderStrong}`, background: "transparent", color: C.textBody2,
          fontSize: 12, fontWeight: 700, letterSpacing: .5, cursor: "pointer", fontFamily: FONT.ui,
        }}>
          <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 20, height: 20, borderRadius: 6, background: C.blue, color: "#fff", fontSize: 15, lineHeight: 1 }}>+</span>
          Sign Up New Driver
        </button>
      </>}>
      {/* Roster. Each row is a real button: a clickable div could not be reached
          by keyboard, and missed the coarse-pointer tap floor in index.html. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px",
        display: "flex", flexDirection: "column", gap: 7 }}>
        {drivers.map((d) => {
          const active = d.name === activeDriver;
          const st = stats[d.name];
          return (
            <button key={d.name} type="button" onClick={() => { onPick(d.name); onClose(); }}
              aria-pressed={active}
              style={{
                display: "flex", alignItems: "center", gap: 13, width: "100%", textAlign: "left",
                background: active ? d.color + "16" : C.inset, color: C.text, fontFamily: FONT.ui,
                border: `1px solid ${active ? d.color : C.line}`, borderRadius: 11,
                padding: "11px 13px", cursor: "pointer",
              }}>
              <div style={{
                width: 42, height: 42, flex: "none", borderRadius: 10, overflow: "hidden",
                background: d.color + "1f", border: `1px solid ${d.color}`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: FONT.cond, fontWeight: 700, fontSize: 21, color: d.color,
              }}>{avatars[d.name]
                ? <img src={avatars[d.name]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                : (d.number || d.name.slice(0, 2).toUpperCase())}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: .3 }}>{d.name}</div>
                <div style={{ fontSize: 11, color: C.textDim, marginTop: 2 }}>{d.team || "Unassigned"}</div>
              </div>
              <div style={{ textAlign: "right", flex: "none" }}>
                <div style={{ fontFamily: FONT.mono, fontSize: 14, fontWeight: 700, color: C.yellow }}>
                  {st && st.best != null ? formatLapTime(st.best, 3) : "—"}
                </div>
                <div style={{ fontSize: 9, letterSpacing: 1, color: C.textFaint, textTransform: "uppercase", marginTop: 2 }}>
                  {st ? st.laps : 0} laps
                </div>
              </div>
              <span style={{
                width: 9, height: 9, borderRadius: "50%", flex: "none",
                background: active ? d.color : "#222a39",
                boxShadow: active ? `0 0 9px ${d.color}` : "none",
              }} />
            </button>
          );
        })}
      </div>
    </ModalShell>
  );
}
