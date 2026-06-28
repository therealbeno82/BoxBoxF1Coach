// ─── LIVE SCREEN ────────────────────────────────────────────────────────────
// The real-time driving studio: a top bar (track / session / live lap time + a
// vs-reference delta), a 6-metric KPI instrument strip + 3 sector cards, the live
// circuit track map (rendered by the parent and passed as `mapSlot`, with its
// legend chips + an audio-cue toggle), the session-laps list, and the AI "Next Lap
// Focus" card. All data comes from the live telemetry snapshot + this driver's laps.

import { useMemo, useState, useEffect } from "react";
import { C, FONT, eyebrow } from "../../lib/ui/tokens.js";
import { formatLapTime, toSpeed, speedUnitLabel, MINI_SECTORS, MINI_PER_SECTOR } from "../../lib/format.js";
import { computeDriverStats } from "../../lib/driverStats.js";
import { tyreCondition } from "../../lib/tyres.js";
import { ERS_MODES } from "../../lib/coach/config.js";

const card = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12 };
const SECTOR_GREY = C.textFaint; // F1 "no time set yet" — neutral grey sector bar

function Kpi({ label, value, unit, color }) {
  return (
    <div style={{ ...card, padding: "11px 15px", display: "flex", flexDirection: "column", justifyContent: "space-between", minWidth: 0 }}>
      <div style={{ fontSize: 9, letterSpacing: 2, color: C.textDim, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: FONT.mono, fontWeight: 800, fontSize: 28, lineHeight: 1, color, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {value}{unit ? <span style={{ fontSize: 11, color: C.textFaint, marginLeft: 4 }}>{unit}</span> : null}
      </div>
    </div>
  );
}

export default function LiveScreen({
  tel, units = "km/h", trackName, sessionLabel, liveLapNumber,
  laps = [], sessionId, activeTrace, lastAdvice,
  liveMini = { durations: [], current: -1, tyre: null },
  mapSlot, legendChips = [], audioOn, onToggleAudio,
  focusAudioOn = true, onToggleFocusAudio, onOpenSetup, onResetSessionLaps,
}) {
  const uLabel = speedUnitLabel(units);
  const stats = useMemo(() => computeDriverStats(laps), [laps]);

  // This drive's completed laps (newest first); fall back to all of the driver's
  // laps if the session isn't tagged.
  const sessionLaps = useMemo(() => {
    // `!archived` keeps laps cleared via "Reset Session Laps" out of the panel even
    // after a restart (sessionId is null then, so the fallback would otherwise show
    // every saved lap). Archived laps still live in `laps` for the all-time stats /
    // track records below and the dashboard + coaching that read the full history.
    const inSession = laps.filter(l => !l.archived && (sessionId ? l.meta?.sessionId === sessionId : true));
    return [...inSession].sort((a, b) => (b.recordedAt || 0) - (a.recordedAt || 0));
  }, [laps, sessionId]);
  const lastLap = sessionLaps[0] || null;
  const sessionBest = useMemo(() => {
    const valid = sessionLaps.filter(l => typeof l.lapTime === "number" && l.lapTime > 0);
    return valid.length ? Math.min(...valid.map(l => l.lapTime)) : null;
  }, [sessionLaps]);

  // Two-step inline confirm for the manual "Reset Session Laps" button: first click
  // arms it, second resets. Auto-reverts after a few seconds if left unconfirmed.
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    if (!confirmReset) return;
    const t = setTimeout(() => setConfirmReset(false), 3500);
    return () => clearTimeout(t);
  }, [confirmReset]);

  // ── F1 timing-tower sector colours ────────────────────────────────────────
  // Both the big S1/S2/S3 cards (the last lap's splits) and the session-laps list
  // tint each split the way an F1 timing tower does:
  //   • GREY   — no time set for this split yet.
  //   • PURPLE — the fastest ever for like-for-like conditions: same circuit, same
  //              tyre condition (wet/dry) and same session type (Qualifying / Time
  //              Trial / Race …), counting every session including this one.
  //   • GREEN  — the fastest split of this drive (session), but not an all-time best.
  //   • YELLOW — beaten: slower than this session's best for the split.
  // Purple outranks green (an all-time best is also a session best). Everything
  // recomputes as laps land, so a green split flips to yellow the moment a quicker
  // lap arrives this session, and to purple if it also beats the record.

  // Bucket key for the PURPLE benchmark: a split only competes with others driven on
  // the same track, the same rubber (wet/dry) and in the same session type — so a wet
  // or qualifying split never has to beat a dry race lap. The live in-progress lap
  // (not yet a saved lap) keys off the same fields via the explicit form.
  const recordKeyFor = (track, cond, sessionType) =>
    `${track ?? "∅"}|${cond ?? "?"}|${sessionType ?? "?"}`;
  const recordKey = (l) => recordKeyFor(l.meta?.track, tyreCondition(l.tyre), l.meta?.sessionType);

  // Fastest split per sector within each drive (keyed by sessionId) across the laps
  // shown in the list — the GREEN benchmark. Grouping by sessionId keeps each drive's
  // bests separate even when the list spans several sessions (e.g. idle, no live run).
  const sessionBests = useMemo(() => {
    const m = new Map();
    for (const l of sessionLaps) {
      if (!Array.isArray(l.sectorTimes)) continue;
      const sid = l.meta?.sessionId ?? "∅";
      let acc = m.get(sid);
      if (!acc) { acc = [null, null, null]; m.set(sid, acc); }
      for (let i = 0; i < 3; i++) {
        const s = l.sectorTimes[i];
        if (typeof s === "number" && s > 0 && (acc[i] == null || s < acc[i])) acc[i] = s;
      }
    }
    return m;
  }, [sessionLaps]);

  // All-time best split per sector across every saved lap, bucketed by like-for-like
  // conditions (track + wet/dry + session type) — the PURPLE benchmark. Spans all
  // sessions incl. the live one, so a new best shows purple the moment it lands.
  const recordBests = useMemo(() => {
    const m = new Map();
    for (const l of laps) {
      if (!Array.isArray(l.sectorTimes)) continue;
      const key = recordKey(l);
      let acc = m.get(key);
      if (!acc) { acc = [null, null, null]; m.set(key, acc); }
      for (let i = 0; i < 3; i++) {
        const s = l.sectorTimes[i];
        if (typeof s === "number" && s > 0 && (acc[i] == null || s < acc[i])) acc[i] = s;
      }
    }
    return m;
  }, [laps]);

  const SECTOR_EPS = 1e-4; // seconds — float tolerance for "ties the min"
  const sectorColor = (lap, i) => {
    const v = lap?.sectorTimes?.[i];
    if (typeof v !== "number" || v <= 0) return SECTOR_GREY;
    // PURPLE first: v is folded into recordBests, so the bucket min is ≤ v — within
    // EPS of it means this split is (or ties) the fastest ever for these conditions.
    const record = recordBests.get(recordKey(lap))?.[i];
    if (record != null && v <= record + SECTOR_EPS) return C.purple;
    const best = sessionBests.get(lap.meta?.sessionId ?? "∅")?.[i];
    if (best != null && v <= best + SECTOR_EPS) return C.green; // best of this session
    return C.yellow; // beaten this session
  };

  // ── Live mini-sectors ─────────────────────────────────────────────────────
  // The pips inside each S1/S2/S3 card are MINI_PER_SECTOR slices of that third of
  // the lap. They fill in live as the car drives, coloured by the SAME F1 rule as the
  // main sectors but per mini-sector: each completed slice of the in-progress lap is
  // graded against the per-mini session best (GREEN) and all-time record (PURPLE).
  // Benchmarks come from saved laps' `miniSectors`; the live lap isn't saved yet, so
  // here "fastest ever" means strictly beating (or matching) the stored record.

  // Per-mini-sector best across this session's laps (GREEN benchmark), keyed by sessionId.
  const sessionMini = useMemo(() => {
    const m = new Map();
    for (const l of sessionLaps) {
      if (!Array.isArray(l.miniSectors)) continue;
      const sid = l.meta?.sessionId ?? "∅";
      let acc = m.get(sid);
      if (!acc) { acc = new Array(MINI_SECTORS).fill(null); m.set(sid, acc); }
      for (let i = 0; i < MINI_SECTORS; i++) {
        const s = l.miniSectors[i];
        if (typeof s === "number" && s > 0 && (acc[i] == null || s < acc[i])) acc[i] = s;
      }
    }
    return m;
  }, [sessionLaps]);

  // Per-mini-sector all-time record (PURPLE benchmark), bucketed like recordBests.
  const recordMini = useMemo(() => {
    const m = new Map();
    for (const l of laps) {
      if (!Array.isArray(l.miniSectors)) continue;
      const key = recordKey(l);
      let acc = m.get(key);
      if (!acc) { acc = new Array(MINI_SECTORS).fill(null); m.set(key, acc); }
      for (let i = 0; i < MINI_SECTORS; i++) {
        const s = l.miniSectors[i];
        if (typeof s === "number" && s > 0 && (acc[i] == null || s < acc[i])) acc[i] = s;
      }
    }
    return m;
  }, [laps]);

  // Conditions of the live lap → which record/session buckets its mini-sectors face.
  const liveKey = recordKeyFor(trackName, tyreCondition(liveMini.tyre), sessionLabel);
  const liveRecord = recordMini.get(liveKey);
  const liveSession = sessionMini.get(sessionId ?? "∅");
  // Colour a just-completed mini-sector of the live lap (null → not driven yet → grey).
  const miniColor = (d, m) => {
    if (typeof d !== "number" || d <= 0) return null;
    const rec = liveRecord?.[m];
    if (rec == null || d <= rec + SECTOR_EPS) return C.purple; // beats/ties the record (or first ever)
    const sb = liveSession?.[m];
    if (sb == null || d <= sb + SECTOR_EPS) return C.green;    // best of this session (or first this session)
    return C.yellow;                                           // slower than this session's best
  };

  // vs-reference delta = the most recent completed lap against the reference's lap time.
  const refLapTime = activeTrace ? (activeTrace.lapTime ?? activeTrace.meta?.lapTime ?? null) : null;
  const lapDelta = (lastLap && typeof refLapTime === "number") ? lastLap.lapTime - refLapTime : null;
  const refLabel = activeTrace
    ? `REF · ${activeTrace.meta?.driver || activeTrace.meta?.track || "trace"}${refLapTime ? " " + formatLapTime(refLapTime, 3) : ""}`
    : "No reference loaded";

  // Sector cards: the last completed lap's splits vs this driver's best sectors.
  const sectors = [0, 1, 2].map((i) => {
    const t = lastLap?.sectorTimes?.[i];
    const best = stats.bestSectors[i];
    const delta = (typeof t === "number" && typeof best === "number" && best > 0) ? t - best : null;
    return {
      name: `S${i + 1}`,
      time: (typeof t === "number" && t > 0) ? t.toFixed(3) : "—",
      delta: delta == null ? "" : (delta <= 0 ? "" : "+") + delta.toFixed(3),
      color: delta == null ? C.textFaint : delta <= 0.001 ? C.green : C.yellow,
      bar: sectorColor(lastLap, i), // F1 timing-tower standing → card top-border colour
    };
  });

  const kpis = [
    { label: "Speed", value: toSpeed(tel.speed, units), unit: uLabel, color: C.teal },
    { label: "Gear", value: tel.gear ?? "—", unit: "", color: C.purple },
    { label: "Throttle", value: Math.round(tel.throttle ?? 0), unit: "%", color: "#fff" },
    { label: "Brake", value: Math.round(tel.brake ?? 0), unit: "%", color: C.red },
    { label: "ERS Batt", value: Math.round(tel.ersBattery ?? 0), unit: "%", color: C.ersYellow },
  ];
  const ersModeName = ERS_MODES[tel.ersMode ?? 0] || "None";

  const focus = lastAdvice && !lastAdvice.info ? lastAdvice : null;

  return (
    <div style={{ flex: 1, minHeight: 0, background: C.bg, padding: "16px 28px 22px",
      display: "flex", flexDirection: "column", gap: 14, fontFamily: FONT.ui }}>

      {/* ── Top bar ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap", flex: "none" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
          <div style={{ width: 5, height: 42, borderRadius: 3, background: C.blue }} />
          <div>
            <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 1, lineHeight: 1 }}>{trackName || "Awaiting telemetry"}</div>
            <div style={{ fontSize: 11, letterSpacing: 2, color: C.textDim, textTransform: "uppercase", marginTop: 5 }}>{sessionLabel || "Live Session"}</div>
          </div>
        </div>
        <div style={{ width: 1, height: 38, background: C.line }} />
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <div>
            <div style={{ fontSize: 9, letterSpacing: 2, color: C.textDim, textTransform: "uppercase" }}>Lap {liveLapNumber ?? "—"}</div>
            <div style={{ fontFamily: FONT.mono, fontSize: 36, fontWeight: 800, lineHeight: 1, marginTop: 3 }}>{formatLapTime(tel.lapTime, 3)}</div>
          </div>
          <div style={{ background: "#2a1f08", border: "1px solid #6b5410", borderRadius: 8, padding: "7px 13px" }}>
            <div style={{ fontSize: 9, letterSpacing: 1, color: "#9a8330", textTransform: "uppercase" }}>vs Reference</div>
            <div style={{ fontFamily: FONT.mono, fontSize: 20, fontWeight: 800, marginTop: 2,
              color: lapDelta == null ? C.textFaint : lapDelta <= 0 ? C.green : C.yellow }}>
              {lapDelta == null ? "—" : (lapDelta <= 0 ? "" : "+") + lapDelta.toFixed(3)}
            </div>
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 9, letterSpacing: 1, color: C.textDim, textTransform: "uppercase" }}>Reference</div>
          <div style={{ fontSize: 13, color: C.textMid, marginTop: 3, fontFamily: FONT.mono }}>{refLabel}</div>
        </div>
      </div>

      {/* ── KPI strip ── */}
      <div style={{ display: "flex", gap: 16, flex: "none", flexWrap: "wrap" }}>
        <div style={{ flex: "2 1 480px", minWidth: 0, display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 12 }}>
          {kpis.map((k) => <Kpi key={k.label} {...k} />)}
          <div style={{ ...card, padding: "11px 15px", display: "flex", flexDirection: "column", justifyContent: "space-between", minWidth: 0 }}>
            <div style={{ fontSize: 9, letterSpacing: 2, color: C.textDim, textTransform: "uppercase" }}>ERS Mode</div>
            <div style={{ fontWeight: 800, fontSize: 20, lineHeight: 1, color: C.red, whiteSpace: "nowrap" }}>{ersModeName}</div>
          </div>
        </div>
        <div style={{ flex: "1 1 360px", minWidth: 0, display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
          {sectors.map((s, ci) => (
            <div key={s.name} style={{ ...card, borderTop: `3px solid ${s.bar}`, padding: "10px 14px",
              display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <span style={{ fontSize: 9, letterSpacing: 2, color: C.textDim, textTransform: "uppercase" }}>{s.name}</span>
                <span style={{ fontFamily: FONT.mono, fontSize: 11, fontWeight: 700, color: s.color }}>{s.delta}</span>
              </div>
              <div style={{ fontFamily: FONT.mono, fontSize: 22, fontWeight: 800, lineHeight: 1 }}>{s.time}</div>
              {/* Live mini-sectors: this third of the lap, filling in + colouring as it's driven. */}
              <div style={{ display: "flex", gap: 4 }}>
                {Array.from({ length: MINI_PER_SECTOR }).map((_, j) => {
                  const g = ci * MINI_PER_SECTOR + j;             // global mini-sector index 0..MINI_SECTORS-1
                  const d = liveMini.durations[g];
                  const col = miniColor(d, g);                    // null until the slice is cleared this lap
                  const active = g === liveMini.current;          // the slice being driven right now
                  return (
                    <div key={j}
                      title={col ? `${s.name}.${j + 1} · ${d.toFixed(3)}s` : active ? "On track" : ""}
                      style={{ flex: 1, height: 7, borderRadius: 2,
                        background: col ? col + "cc" : active ? C.blue + "55" : "transparent",
                        border: `1px solid ${col || (active ? C.blue : C.borderStrong)}`,
                        boxShadow: col ? `0 0 6px ${col}99` : active ? `0 0 6px ${C.blue}aa` : "none",
                        animation: active && !col ? "blink 1s infinite" : "none",
                        transition: "background .15s, border-color .15s, box-shadow .15s" }} />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Main: track map + right column ── */}
      <div style={{ flex: 1, minHeight: 320, display: "flex", gap: 16, flexWrap: "wrap" }}>
        {/* Track map */}
        <div style={{ flex: "1.6 1 460px", minWidth: 320, ...card, padding: "16px 18px", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
            <span style={eyebrow}>Live Track Map</span>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
              {legendChips.map((l) => (
                <div key={l.label} onClick={l.onToggle || undefined} style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 8,
                  background: l.on ? C.inset : "transparent", border: `1px solid ${l.on ? l.color + "66" : C.line}`,
                  cursor: l.onToggle ? "pointer" : "default", opacity: l.on ? 1 : 0.45, transition: "opacity .12s" }}>
                  <span style={{ width: 12, height: 12, borderRadius: 3, flex: "none",
                    background: l.on ? l.color : "transparent", border: `1.5px solid ${l.color}`,
                    boxShadow: l.on ? `0 0 7px ${l.color}88` : "none" }} />
                  <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: .3, color: l.on ? C.textBody2 : C.textDim }}>{l.label}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ flex: 1, position: "relative", minHeight: 240 }}>
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>{mapSlot}</div>
            <div onClick={onToggleAudio} title="Toggle track audio cues" style={{
              position: "absolute", right: 8, bottom: 8, zIndex: 5, display: "flex", alignItems: "center", gap: 9,
              background: audioOn ? C.elevated : C.inset, border: `1px solid ${audioOn ? C.blue : C.line}`,
              borderRadius: 10, padding: "9px 13px", cursor: "pointer", boxShadow: "0 4px 16px rgba(0,0,0,.4)" }}>
              <span style={{ fontSize: 14 }}>{audioOn ? "🔊" : "🔇"}</span>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: audioOn ? C.textBody2 : C.textDim }}>
                {audioOn ? "AUDIO CUES ON" : "AUDIO CUES OFF"}
              </span>
            </div>
          </div>
        </div>

        {/* Right: session laps + AI focus */}
        <div style={{ flex: "1 1 380px", minWidth: 330, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ flex: 1, minHeight: 160, ...card, padding: "14px 16px", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 11 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.liveRed, boxShadow: `0 0 8px ${C.liveRed}`, animation: "blink 1.4s infinite" }} />
                <span style={{ ...eyebrow, color: C.textMuted, fontWeight: 700 }}>Session Laps</span>
              </div>
              <span style={{ fontSize: 9, letterSpacing: 1, color: C.textDim, fontFamily: FONT.mono }}>{sessionLaps.length} COMPLETED</span>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, paddingRight: 4 }}>
              {sessionLaps.length === 0 && (
                <div style={{ margin: "auto", textAlign: "center", color: C.textFaint, fontSize: 11, lineHeight: 1.6, padding: 16 }}>
                  No completed laps yet this session.
                </div>
              )}
              {sessionLaps.map((l) => {
                const isPB = sessionBest != null && Math.abs(l.lapTime - sessionBest) < 1e-6;
                const delta = sessionBest != null ? l.lapTime - sessionBest : null;
                const secs = Array.isArray(l.sectorTimes) ? l.sectorTimes : [null, null, null];
                return (
                  <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 12,
                    background: C.inset, border: `1px solid ${C.line}`, borderLeft: `3px solid ${isPB ? C.purple : C.line}`, borderRadius: 8, padding: "8px 12px" }}>
                    <span style={{ flex: "none", fontSize: 10, letterSpacing: 1, color: C.textDim, textTransform: "uppercase" }}>Lap {l.lapNumber ?? "?"}</span>
                    <span style={{ flex: "none", fontFamily: FONT.mono, fontSize: 17, fontWeight: 800, color: isPB ? C.purple : "#fff" }}>{formatLapTime(l.lapTime, 3)}</span>
                    <span style={{ flex: "none", color: C.textFaintest }}>–</span>
                    {/* Sector splits, tinted purple / green / orange vs the all-time and session bests. */}
                    <div style={{ flex: "none", display: "flex", gap: 14 }}>
                      {[0, 1, 2].map((i) => {
                        const v = secs[i];
                        const ok = typeof v === "number" && v > 0;
                        return (
                          <span key={i} style={{ display: "inline-flex", alignItems: "baseline", gap: 4, fontFamily: FONT.mono, fontSize: 11, fontWeight: 700 }}>
                            <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: 0.5, color: C.textDim }}>S{i + 1}</span>
                            <span style={{ color: sectorColor(l, i) }}>{ok ? v.toFixed(3) : "—"}</span>
                          </span>
                        );
                      })}
                    </div>
                    <span style={{ flex: 1 }} />
                    <span style={{ flex: "none", color: C.textFaintest }}>–</span>
                    <span style={{ flex: "none", fontFamily: FONT.mono, fontSize: 11, fontWeight: 700, textAlign: "right", color: isPB ? C.purple : C.yellow }}>
                      {isPB ? "BEST" : delta != null ? "+ " + delta.toFixed(3) : ""}
                    </span>
                    <button onClick={() => onOpenSetup?.(l)} title="View car setup" disabled={!l.setup} style={{
                      justifySelf: "end", flex: "none", display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28,
                      borderRadius: 7, border: `1px solid ${C.line}`, background: C.surface, color: l.setup ? "#7ea6e6" : C.textFaintest,
                      cursor: l.setup ? "pointer" : "default", opacity: l.setup ? 1 : 0.5 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
            <button
              onClick={() => {
                if (confirmReset) { onResetSessionLaps?.(); setConfirmReset(false); }
                else setConfirmReset(true);
              }}
              disabled={sessionLaps.length === 0}
              title="Start a fresh session — clears this panel; your lap history and PBs are kept"
              style={{
                flex: "none", marginTop: 11, width: "100%", height: 34,
                display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                borderRadius: 8,
                border: `1px solid ${confirmReset ? C.red : C.line}`,
                background: confirmReset ? "#2a0d12" : C.surface,
                color: confirmReset ? C.red : C.textDim,
                fontFamily: FONT.ui, fontSize: 10, letterSpacing: 1.4,
                textTransform: "uppercase", fontWeight: 700,
                cursor: sessionLaps.length === 0 ? "default" : "pointer",
                opacity: sessionLaps.length === 0 ? 0.45 : 1,
                transition: "all .15s ease",
              }}
            >
              {confirmReset ? "Confirm reset?" : "Reset Session Laps"}
            </button>
          </div>

          {/* AI next-lap focus */}
          <div style={{ flex: "none", background: "linear-gradient(135deg,#161029,#11151d)", border: "1px solid #2c2150",
            borderRadius: 12, padding: "14px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
              <span style={{ width: 22, height: 22, borderRadius: 6, background: "#b45bff22", border: `1px solid ${C.purple}`,
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>✦</span>
              <span style={{ fontSize: 10, letterSpacing: 2, color: "#c39bff", textTransform: "uppercase", fontWeight: 700 }}>Next Lap Focus</span>
              <div
                onClick={onToggleFocusAudio}
                title={focusAudioOn ? "Audio hints on — read through your headset. Click to mute." : "Audio hints off. Click to read hints aloud."}
                style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, padding: "5px 9px", borderRadius: 8,
                  background: focusAudioOn ? "#b45bff1f" : C.inset, border: `1px solid ${focusAudioOn ? C.purple : C.line}`,
                  cursor: onToggleFocusAudio ? "pointer" : "default" }}>
                <span style={{ fontSize: 12 }}>{focusAudioOn ? "🎧" : "🔇"}</span>
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, color: focusAudioOn ? "#c39bff" : C.textDim }}>
                  {focusAudioOn ? "AUDIO ON" : "AUDIO OFF"}
                </span>
              </div>
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.55, color: focus ? C.textBody : C.textDim }}>
              {focus ? focus.text : "Drive a lap with a reference loaded — the coach's per-lap focus appears here."}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
