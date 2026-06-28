// ─── ANALYTICS SCREEN (Performance Center) ──────────────────────────────────
// Post-session lap analysis. Reference/driven lap selectors feed four sub-tabs:
//   • Consistency — per-lap sector-delta matrix + the AI Race Engineer chat
//   • Telemetry   — the MoTeC trace stack + live-vs-reference readouts
//   • ERS & Lico  — side-by-side reference/driven track maps
//   • Driving Lines — the 3D racing-line view + a corner-by-corner apex table
// The heavy reusable views (traces / maps / 3D / chat) are passed in as slots so
// they keep their existing engine; this screen owns the chrome + the new matrix
// and corner table.

import { useMemo, useRef, useState, useEffect } from "react";
import { C, FONT, SECTOR_COLORS, fmtDelta } from "../../lib/ui/tokens.js";
import { formatLapTime, toSpeed, speedUnitLabel } from "../../lib/format.js";
import { computeDriverStats } from "../../lib/driverStats.js";

const SUBTABS = [
  ["consistency", "Consistency"],
  ["telemetry", "Telemetry"],
  ["ers", "ERS & Lico Maps"],
  ["lines", "Driving Lines"],
];

const subTabStyle = (active) => ({
  position: "relative", padding: "12px 2px", background: "transparent", border: "none",
  borderBottom: `2px solid ${active ? C.blue : "transparent"}`, color: active ? "#fff" : "#7b8499",
  fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer",
  fontFamily: FONT.ui, whiteSpace: "nowrap",
});

const selectStyle = (color) => ({
  width: "100%", appearance: "none", WebkitAppearance: "none", background: C.surface,
  border: `1px solid ${C.borderStrong}`, borderRadius: 9, color, fontFamily: FONT.mono,
  fontSize: 14, fontWeight: 700, padding: "11px 36px 11px 14px", cursor: "pointer", outline: "none",
});

const actionBtn = (border, color) => ({
  flex: "none", display: "inline-flex", alignItems: "center", gap: 6, padding: "0 14px",
  borderRadius: 9, border: `1px solid ${border}`, background: C.surface, color,
  fontFamily: FONT.ui, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", fontWeight: 700,
  cursor: "pointer", whiteSpace: "nowrap", height: 42,
});

const WrenchBtn = ({ onClick, has }) => (
  <button onClick={onClick} title="View car setup" disabled={!has} style={{
    justifySelf: "end", flex: "none", display: "flex", alignItems: "center", justifyContent: "center",
    width: 28, height: 28, borderRadius: 7, border: `1px solid ${C.line}`, background: C.surface,
    color: has ? "#7ea6e6" : C.textFaintest, cursor: has ? "pointer" : "default", opacity: has ? 1 : 0.5 }}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
    </svg>
  </button>
);

const card = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12 };

const fmtSec = (s) => (typeof s === "number" && s > 0 ? s.toFixed(3) : "—");

export default function AnalyticsScreen({
  trackName, sessionLabel, laps = [], units = "km/h", zones = [],
  activeTrace, comparisonLap,
  referenceSources = [], referenceId, onSelectReference, onLoadTrace, onRemoveTrace,
  comparisonSources = [], comparisonId, onSelectComparison, onDeleteLap, onExportLap,
  labelFor = (s) => s?.id, onOpenSetup, onResetSessionLaps,
  tracesSlot, ersSlot, linesSlot, chatSlot,
}) {
  const [subTab, setSubTab] = useState("consistency");
  const fileRef = useRef(null);

  // Two-step inline confirm for the manual reset (mirrors the Live screen): first
  // click arms it, second resets; auto-reverts after a few seconds if unconfirmed.
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    if (!confirmReset) return;
    const t = setTimeout(() => setConfirmReset(false), 3500);
    return () => clearTimeout(t);
  }, [confirmReset]);
  const stats = useMemo(() => computeDriverStats(laps), [laps]);
  const uLabel = speedUnitLabel(units);

  const selectedRef = referenceSources.find((s) => s.id === referenceId) || null;
  const refIsLoaded = !!selectedRef && selectedRef.lapNumber == null;
  const selectedComparisonIsLap = comparisonLap?.lapNumber != null;

  // ── Consistency matrix: laps with sector splits, vs the best of each sector ──
  const matrix = useMemo(() => {
    const withSectors = laps.filter((l) => Array.isArray(l.sectorTimes) && l.sectorTimes.some((s) => s > 0));
    const best = [0, 1, 2].map((i) => {
      const vals = withSectors.map((l) => l.sectorTimes[i]).filter((s) => typeof s === "number" && s > 0);
      return vals.length ? Math.min(...vals) : null;
    });
    const rows = [...withSectors].sort((a, b) => (b.recordedAt || 0) - (a.recordedAt || 0)).slice(0, 8).map((l) => ({
      lap: l,
      cells: [0, 1, 2].map((i) => {
        const t = l.sectorTimes[i];
        const b = best[i];
        if (typeof t !== "number" || t <= 0 || b == null) return { time: "—", color: C.textFaint, delta: null };
        const d = t - b;
        const isBest = d < 1e-6;
        return { time: fmtSec(t), color: isBest ? C.green : C.yellow, delta: isBest ? null : fmtDelta(d) };
      }),
    }));
    return { rows, best };
  }, [laps]);

  // ── Corner table (Driving Lines): apex speed per brake zone, driven vs reference ──
  const cornerRows = useMemo(() => {
    const comp = comparisonLap?.samples || [];
    const ref = activeTrace?.samples || [];
    const lapLen = Math.max(
      comp.reduce((m, s) => Math.max(m, s.dist || 0), 0),
      ref.reduce((m, s) => Math.max(m, s.dist || 0), 0)
    );
    if (!lapLen) return [];
    const apexOf = (samples, lo, hi) => {
      const inZone = samples.filter((s) => s.dist >= lo && s.dist <= hi && typeof s.speed === "number");
      if (!inZone.length) return null;
      return inZone.reduce((b, s) => (s.speed < b.speed ? s : b), inZone[0]);
    };
    return zones.filter((z) => z.type === "brake").slice(0, 9).map((z) => {
      const lo = z.start * lapLen, hi = z.end * lapLen;
      const a = apexOf(comp, lo, hi);
      const r = apexOf(ref, lo, hi);
      const av = a ? toSpeed(a.speed, units) : null;
      const rv = r ? toSpeed(r.speed, units) : null;
      const dv = av != null && rv != null ? av - rv : null;
      return {
        name: z.name, gear: a?.gear ?? "—", apex: av != null ? av : "—", ref: rv != null ? rv : "—",
        delta: dv == null ? "" : (dv > 0 ? "+" : "") + dv,
        deltaColor: dv == null ? C.textFaint : dv < 0 ? C.red : dv > 0 ? C.green : C.textMid,
      };
    });
  }, [zones, comparisonLap, activeTrace, units]);

  return (
    <div style={{ flex: 1, minHeight: 0, background: C.bg, padding: "16px 28px 22px",
      display: "flex", flexDirection: "column", gap: 14, fontFamily: FONT.ui }}>

      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap", flex: "none" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
          <div style={{ width: 5, height: 42, borderRadius: 3, background: C.purple }} />
          <div>
            <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 1, lineHeight: 1 }}>{trackName || "Performance Center"}</div>
            <div style={{ fontSize: 11, letterSpacing: 2, color: C.textDim, textTransform: "uppercase", marginTop: 5 }}>Performance Center · {sessionLabel || "Analysis"}</div>
          </div>
        </div>
        <div style={{ width: 1, height: 38, background: C.line }} />
        <div>
          <div style={{ fontSize: 9, letterSpacing: 2, color: C.textDim, textTransform: "uppercase" }}>Best Lap</div>
          <div style={{ fontFamily: FONT.mono, fontSize: 30, fontWeight: 800, lineHeight: 1, marginTop: 3, color: C.purple }}>
            {stats.fastestOverall ? formatLapTime(stats.fastestOverall.lapTime, 3) : "—"}
          </div>
        </div>
        <button
          onClick={() => {
            if (confirmReset) { onResetSessionLaps?.(); setConfirmReset(false); }
            else setConfirmReset(true);
          }}
          disabled={laps.length === 0}
          title="Start a fresh session — clears the analytics lap panels; your lap history and PBs are kept"
          style={{
            ...actionBtn(confirmReset ? C.red : C.borderStrong, confirmReset ? C.red : "#9aa3b8"),
            marginLeft: "auto",
            background: confirmReset ? "#2a0d12" : C.surface,
            opacity: laps.length === 0 ? 0.45 : 1,
            cursor: laps.length === 0 ? "default" : "pointer",
          }}
        >
          {confirmReset ? "Confirm reset?" : "↺ Reset Laps"}
        </button>
      </div>

      {/* Sub-tabs */}
      <div style={{ display: "flex", alignItems: "center", gap: 26, borderBottom: `1px solid ${C.line}`, padding: "0 2px", flex: "none", flexWrap: "wrap" }}>
        {SUBTABS.map(([id, label]) => (
          <button key={id} onClick={() => setSubTab(id)} style={subTabStyle(subTab === id)}>{label}</button>
        ))}
      </div>

      {/* Lap selectors */}
      <div style={{ display: "flex", gap: 18, padding: "2px", flex: "none", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 280px", display: "flex", flexDirection: "column", gap: 5 }}>
          <label style={{ fontSize: 9, letterSpacing: 2, color: C.textDim, textTransform: "uppercase", fontWeight: 600 }}>Reference Lap</label>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
              <select value={referenceId || ""} onChange={(e) => onSelectReference(e.target.value || null)} style={selectStyle(C.purple)}>
                <option value="">None — no reference</option>
                {referenceSources.map((s) => <option key={s.id} value={s.id}>{labelFor(s)}</option>)}
              </select>
              <span style={caret}>▾</span>
            </div>
            <input ref={fileRef} type="file" accept=".json" multiple style={{ display: "none" }}
              onChange={(e) => { Array.from(e.target.files).forEach(onLoadTrace); e.target.value = ""; }} />
            <button onClick={() => fileRef.current.click()} title="Load a trace JSON from the Calibrator" style={actionBtn(C.borderStrong, "#9aa3b8")}>↧ Load</button>
            {selectedRef?.setup && <button onClick={() => onOpenSetup(selectedRef)} style={actionBtn(C.borderStrong, "#7ea6e6")}>Setup</button>}
            {selectedRef && (
              <button onClick={() => (refIsLoaded ? onRemoveTrace(selectedRef.id) : onDeleteLap(selectedRef.id))}
                title={refIsLoaded ? "Remove trace" : "Delete lap"} style={actionBtn("#3a2400", "#ff9100")}>✕</button>
            )}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", paddingBottom: 11, color: C.textFaint, fontSize: 11, letterSpacing: 1 }}>VS</div>
        <div style={{ flex: "1 1 280px", display: "flex", flexDirection: "column", gap: 5 }}>
          <label style={{ fontSize: 9, letterSpacing: 2, color: C.textDim, textTransform: "uppercase", fontWeight: 600 }}>Driven Lap</label>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
              <select value={comparisonId} onChange={(e) => onSelectComparison(e.target.value)} style={selectStyle(C.cyan)}>
                <option value="live">Live lap</option>
                {comparisonSources.map((s) => <option key={s.id} value={s.id}>{labelFor(s)}</option>)}
              </select>
              <span style={caret}>▾</span>
            </div>
            {selectedComparisonIsLap && (
              <>
                {comparisonLap.setup && <button onClick={() => onOpenSetup(comparisonLap)} style={actionBtn(C.borderStrong, "#7ea6e6")}>Setup</button>}
                <button onClick={() => onExportLap(comparisonLap)} title="Save lap to a .json file" style={actionBtn("#0c3a1c", "#00e676")}>⬇ Save</button>
                <button onClick={() => onDeleteLap(comparisonLap.id)} style={actionBtn("#3a2400", "#ff9100")}>Delete</button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Tab content ── */}
      {subTab === "consistency" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div style={{ flex: "1.5 1 420px", minWidth: 320, ...card, padding: "16px 18px", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
              <span style={{ fontSize: 10, letterSpacing: 2, color: C.textMuted, textTransform: "uppercase", fontWeight: 600 }}>Consistency Matrix · Sector Times vs Best</span>
              <div style={{ display: "flex", gap: 14 }}>
                {[["Best sector", C.green], ["Slower", C.yellow], ["Gap to best", C.red]].map(([l, c]) => (
                  <span key={l} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 9, color: C.textMuted }}>
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: c }} />{l}
                  </span>
                ))}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "60px repeat(3,1fr) 1.15fr 34px", gap: 8, marginBottom: 9, padding: "0 10px" }}>
              {["Lap", "S1", "S2", "S3", "Lap Time", ""].map((h, i) => (
                <div key={i} style={{ fontSize: 9, letterSpacing: 1, color: C.textDim, textTransform: "uppercase",
                  textAlign: i === 0 ? "left" : i === 4 ? "right" : "center" }}>{h}</div>
              ))}
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 7 }}>
              {matrix.rows.length === 0 && (
                <div style={{ margin: "auto", textAlign: "center", color: C.textFaint, fontSize: 12, lineHeight: 1.6, padding: 20 }}>
                  No laps with sector splits yet.<br />Drive laps with sector timing to build the matrix.
                </div>
              )}
              {matrix.rows.map(({ lap, cells }) => {
                const cur = lap.id === comparisonId;
                return (
                  <div key={lap.id} style={{ display: "grid", gridTemplateColumns: "60px repeat(3,1fr) 1.15fr 34px", gap: 8, alignItems: "center",
                    background: cur ? C.elevated : C.inset, border: `1px solid ${cur ? C.blue : C.line}`, borderRadius: 8, padding: "11px 10px" }}>
                    <div style={{ fontFamily: FONT.mono, fontSize: 15, fontWeight: 700, color: cur ? "#fff" : C.textMuted }}>{lap.lapNumber ?? "?"}</div>
                    {cells.map((c, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "baseline", justifyContent: "center", gap: 4 }}>
                        <span style={{ fontFamily: FONT.mono, fontSize: 14, fontWeight: 700, color: c.color }}>{c.time}</span>
                        {c.delta && (
                          <span style={{ fontFamily: FONT.mono, fontSize: 10, fontWeight: 600, color: C.red }}>{c.delta}</span>
                        )}
                      </div>
                    ))}
                    <div style={{ fontFamily: FONT.mono, fontSize: 15, fontWeight: 700, textAlign: "right", color: C.textBody2 }}>{formatLapTime(lap.lapTime, 3)}</div>
                    <WrenchBtn onClick={() => onOpenSetup(lap)} has={!!lap.setup} />
                  </div>
                );
              })}
            </div>
            {/* Theoretical best — the best possible lap from the fastest sectors set this session */}
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.line}`, display: "flex",
              alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 9, letterSpacing: 2, color: C.textDim, textTransform: "uppercase", fontWeight: 600 }}>Theoretical Best</div>
                <div style={{ fontFamily: FONT.mono, fontSize: 24, fontWeight: 800, color: C.purple, marginTop: 4, lineHeight: 1 }}>
                  {matrix.best.every((s) => typeof s === "number" && s > 0)
                    ? formatLapTime(matrix.best.reduce((a, b) => a + b, 0), 3) : "—"}
                </div>
                <div style={{ fontSize: 9, color: C.textFaint, marginTop: 4 }}>Fastest sectors set this session</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {[0, 1, 2].map((i) => (
                  <div key={i} style={{ minWidth: 58, textAlign: "center", background: C.inset, border: `1px solid ${C.line}`,
                    borderTop: `2px solid ${SECTOR_COLORS[i]}`, borderRadius: 8, padding: "7px 9px" }}>
                    <div style={{ fontSize: 8, letterSpacing: 1, color: C.textDim, textTransform: "uppercase" }}>S{i + 1}</div>
                    <div style={{ fontFamily: FONT.mono, fontSize: 14, fontWeight: 700, marginTop: 3 }}>{fmtSec(matrix.best[i])}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div style={{ flex: "1 1 360px", minWidth: 300, ...card, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
            {chatSlot}
          </div>
        </div>
      )}

      {subTab === "telemetry" && tracesSlot}

      {subTab === "ers" && (
        <div style={{ flex: 1, minHeight: 0, ...card, padding: "16px 18px", display: "flex", flexDirection: "column" }}>
          {ersSlot}
        </div>
      )}

      {subTab === "lines" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div style={{ flex: "1.6 1 460px", minWidth: 320, ...card, padding: "16px 18px", display: "flex", flexDirection: "column" }}>
            {linesSlot}
          </div>
          <div style={{ flex: "1 1 360px", minWidth: 300, ...card, padding: "16px 18px", display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 10, letterSpacing: 2, color: C.textMuted, textTransform: "uppercase", fontWeight: 600, marginBottom: 12 }}>Corner Analysis · Apex Speed vs Reference</span>
            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 60px 64px 56px 60px", gap: 8, padding: "0 12px 9px" }}>
              {["Corner", "Gear", "Apex", "Ref", "Δ"].map((h, i) => (
                <div key={i} style={{ fontSize: 9, letterSpacing: 1, color: C.textDim, textTransform: "uppercase",
                  textAlign: i === 0 ? "left" : i === 4 ? "right" : "center" }}>{h}</div>
              ))}
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 7 }}>
              {cornerRows.length === 0 && (
                <div style={{ margin: "auto", textAlign: "center", color: C.textFaint, fontSize: 12, lineHeight: 1.6, padding: 20 }}>
                  Pick a driven + reference lap with braking zones to compare apex speeds.
                </div>
              )}
              {cornerRows.map((c, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "1.2fr 60px 64px 56px 60px", gap: 8, alignItems: "center",
                  background: C.inset, border: `1px solid ${C.line}`, borderRadius: 8, padding: "11px 12px" }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: C.textBody2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                  <span style={{ fontFamily: FONT.mono, fontSize: 14, textAlign: "center", color: C.textMuted }}>{c.gear}</span>
                  <span style={{ fontFamily: FONT.mono, fontSize: 15, fontWeight: 700, textAlign: "center" }}>{c.apex}</span>
                  <span style={{ fontFamily: FONT.mono, fontSize: 14, textAlign: "center", color: C.textDim }}>{c.ref}</span>
                  <span style={{ fontFamily: FONT.mono, fontSize: 15, fontWeight: 800, textAlign: "right", color: c.deltaColor }}>{c.delta}</span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 13, paddingTop: 13, borderTop: `1px solid ${C.line}`, fontSize: 11, color: C.textDim }}>
              Apex speeds in {uLabel} · Δ vs reference line
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const caret = { position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: C.textFaint, fontSize: 11 };
