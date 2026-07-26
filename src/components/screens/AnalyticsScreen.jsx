// ─── ANALYTICS SCREEN (Performance Center) ──────────────────────────────────
// Post-session lap analysis, one combined view: reference/driven lap selectors
// above the 3D racing lines beside the telemetry trace stack, with the
// lap-consistency sector matrix as a collapsible strip along the bottom (no
// tab-flicking while analysing a lap). The heavy reusable views (traces / 3D)
// are passed in as slots so they keep their existing engine; this screen owns
// the chrome + the matrix.

import { useMemo, useRef, useState } from "react";
import { C, FONT, fmtDelta } from "../../lib/ui/tokens.js";
import { formatLapTime } from "../../lib/format.js";
import { computeDriverStats, isRankable } from "../../lib/driverStats.js";

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

const SetupBtn = ({ onClick }) => (
  <button onClick={onClick} title="View car setup"
    style={{ ...actionBtn(C.borderStrong, "#7ea6e6"), width: 42, padding: 0, justifyContent: "center", gap: 0 }}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
    </svg>
  </button>
);

const card = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12 };

const fmtSec = (s) => (typeof s === "number" && s > 0 ? s.toFixed(3) : "—");

export default function AnalyticsScreen({
  trackName, sessionLabel, laps = [],
  comparisonLap,
  referenceSources = [], referenceId, onSelectReference, onLoadTrace, onRemoveTrace,
  comparisonSources = [], comparisonId, onSelectComparison, onDeleteLap, onExportLap,
  labelFor = (s) => s?.id, onOpenSetup,
  tracesSlot, linesSlot,
}) {
  // Is the consistency strip along the bottom expanded?
  const [stripOpen, setStripOpen] = useState(true);
  const fileRef = useRef(null);

  // Lap awaiting a save; when set, the "hide setup?" dialog is open. We only ask
  // when the lap actually carries a garage loadout — otherwise save straight away.
  const [pendingSave, setPendingSave] = useState(null);
  const requestSave = (lap) => (lap?.setup ? setPendingSave(lap) : onExportLap(lap));
  const finishSave = (hideSetup) => {
    if (pendingSave) onExportLap(pendingSave, { hideSetup });
    setPendingSave(null);
  };

  const stats = useMemo(() => computeDriverStats(laps), [laps]);

  const selectedRef = referenceSources.find((s) => s.id === referenceId) || null;
  const refIsLoaded = !!selectedRef && selectedRef.lapNumber == null;
  const selectedComparisonIsLap = comparisonLap?.lapNumber != null;

  // ── Consistency matrix: laps with sector splits, vs the best of each sector ──
  const matrix = useMemo(() => {
    const withSectors = laps.filter((l) => Array.isArray(l.sectorTimes) && l.sectorTimes.some((s) => s > 0));
    // Invalidated laps still appear in the matrix (tagged), but never set the best
    // sector benchmark — a game-deleted lap doesn't count toward the ideal.
    const best = [0, 1, 2].map((i) => {
      const vals = withSectors.filter(isRankable).map((l) => l.sectorTimes[i]).filter((s) => typeof s === "number" && s > 0);
      return vals.length ? Math.min(...vals) : null;
    });
    const rows = [...withSectors].sort((a, b) => (b.recordedAt || 0) - (a.recordedAt || 0)).slice(0, 8).map((l) => ({
      lap: l,
      cells: [0, 1, 2].map((i) => {
        const t = l.sectorTimes[i];
        const b = best[i];
        if (typeof t !== "number" || t <= 0 || b == null) return { time: "—", color: C.textFaint, delta: null };
        // Invalidated laps show their splits muted and never green/best.
        if (l.invalid) return { time: fmtSec(t), color: C.textDim, delta: null };
        const d = t - b;
        const isBest = d < 1e-6;
        return { time: fmtSec(t), color: isBest ? C.green : C.yellow, delta: isBest ? null : fmtDelta(d) };
      }),
    }));
    return { rows, best };
  }, [laps]);

  return (
    <div style={{ flex: 1, minHeight: 0, background: C.bg, padding: "16px 28px 22px",
      display: "flex", flexDirection: "column", gap: 14, fontFamily: FONT.ui }}>

      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap", flex: "none" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
          <div style={{ width: 5, height: 42, borderRadius: 3, background: C.blue }} />
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
      </div>

      {/* Lap selectors */}
      <div style={{ display: "flex", gap: 18, padding: "2px", flex: "none", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 280px", display: "flex", flexDirection: "column", gap: 5 }}>
          <label style={{ fontSize: 9, letterSpacing: 2, color: C.textDim, textTransform: "uppercase", fontWeight: 600 }}>Reference Lap</label>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
              <select value={referenceId || ""} onChange={(e) => onSelectReference(e.target.value || null)} style={selectStyle("#ffffff")}>
                <option value="">None — no reference</option>
                {referenceSources.map((s) => <option key={s.id} value={s.id}>{labelFor(s)}</option>)}
              </select>
              <span style={caret}>▾</span>
            </div>
            <input ref={fileRef} type="file" accept=".json" multiple style={{ display: "none" }}
              onChange={(e) => { Array.from(e.target.files).forEach(onLoadTrace); e.target.value = ""; }} />
            <button onClick={() => fileRef.current.click()} title="Load a trace JSON from the Calibrator" style={actionBtn(C.borderStrong, "#9aa3b8")}>↧ Load</button>
            {selectedRef?.setup && <SetupBtn onClick={() => onOpenSetup(selectedRef)} />}
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
                {comparisonLap.setup && <SetupBtn onClick={() => onOpenSetup(comparisonLap)} />}
                <button onClick={() => requestSave(comparisonLap)} title="Save lap to a .json file" style={actionBtn("#0c3a1c", "#00e676")}>⬇ Save</button>
                <button onClick={() => onDeleteLap(comparisonLap.id)} title="Delete lap" style={actionBtn("#3a2400", "#ff9100")}>✕</button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Left column: 3D racing lines above the lap strip (both share its width);
          right column: the telemetry trace stack running the full height. Both
          columns are equal width so the split lands under the "VS" above — the
          two lap selectors are equal width too, centring the VS on the same axis. */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 14 }}>
        <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ flex: 1, minHeight: 0, ...card, padding: "14px 16px", display: "flex", flexDirection: "column" }}>
            {linesSlot}
          </div>

        {/* Collapsible lap-consistency strip, under the map */}
        <div style={{ flex: "none", ...card, overflow: "hidden" }}>
          <button onClick={() => setStripOpen((o) => !o)} title={stripOpen ? "Collapse" : "Expand"}
            style={{ width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "11px 16px",
              background: "transparent", border: "none", cursor: "pointer", fontFamily: FONT.ui, textAlign: "left" }}>
            <span style={{ fontSize: 10, letterSpacing: 2, color: C.textMuted, textTransform: "uppercase", fontWeight: 600 }}>
              Lap Consistency · Sector Times vs Best</span>
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "baseline", gap: 7 }}>
              <span style={{ fontSize: 9, letterSpacing: 1.5, color: C.textDim, textTransform: "uppercase" }}>Theoretical Best</span>
              <span style={{ fontFamily: FONT.mono, fontSize: 17, fontWeight: 800, color: C.purple, lineHeight: 1 }}>
                {matrix.best.every((s) => typeof s === "number" && s > 0)
                  ? formatLapTime(matrix.best.reduce((a, b) => a + b, 0), 3) : "—"}
              </span>
              {[0, 1, 2].map((i) => (
                <span key={i} style={{ display: "flex", alignItems: "baseline", gap: 4, marginLeft: i === 0 ? 6 : 0 }}>
                  <span style={{ fontSize: 9, letterSpacing: 1, color: C.textDim, textTransform: "uppercase" }}>S{i + 1}</span>
                  <span style={{ fontFamily: FONT.mono, fontSize: 13, fontWeight: 700, color: C.textBody2 }}>{fmtSec(matrix.best[i])}</span>
                </span>
              ))}
            </span>
            <span style={{ color: C.textDim, fontSize: 11 }}>{stripOpen ? "▾" : "▸"}</span>
          </button>
          {stripOpen && (
            <div style={{ padding: "0 16px 14px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "60px repeat(3,1fr) 1.15fr 34px", gap: 8, marginBottom: 8, padding: "0 10px" }}>
                {["Lap", "S1", "S2", "S3", "Lap Time", ""].map((h, i) => (
                  <div key={i} style={{ fontSize: 9, letterSpacing: 1, color: C.textDim, textTransform: "uppercase",
                    textAlign: i === 0 ? "left" : i === 4 ? "right" : "center" }}>{h}</div>
                ))}
              </div>
              <div style={{ maxHeight: 230, overflowY: "auto", display: "flex", flexDirection: "column", gap: 7 }}>
                {matrix.rows.length === 0 && (
                  <div style={{ margin: "auto", textAlign: "center", color: C.textFaint, fontSize: 12, lineHeight: 1.6, padding: 20 }}>
                    No laps with sector splits yet. Drive laps with sector timing to build the matrix.
                  </div>
                )}
                {matrix.rows.map(({ lap, cells }) => {
                  const cur = lap.id === comparisonId;
                  const invalid = !!lap.invalid;
                  return (
                    <div key={lap.id} style={{ display: "grid", gridTemplateColumns: "60px repeat(3,1fr) 1.15fr 34px", gap: 8, alignItems: "center",
                      background: cur ? C.elevated : C.inset, border: `1px solid ${cur ? C.blue : invalid ? C.red : C.line}`, borderRadius: 8, padding: "9px 10px" }}>
                      <div style={{ fontFamily: FONT.mono, fontSize: 15, fontWeight: 700, color: invalid ? C.textDim : cur ? "#fff" : C.textMuted }}>{lap.lapNumber ?? "?"}</div>
                      {cells.map((c, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "baseline", justifyContent: "center", gap: 4 }}>
                          <span style={{ fontFamily: FONT.mono, fontSize: 14, fontWeight: 700, color: c.color }}>{c.time}</span>
                          {c.delta && (
                            <span style={{ fontFamily: FONT.mono, fontSize: 10, fontWeight: 600, color: C.red }}>{c.delta}</span>
                          )}
                        </div>
                      ))}
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                        <span style={{ fontFamily: FONT.mono, fontSize: 15, fontWeight: 700, textAlign: "right", color: invalid ? C.textDim : C.textBody2, textDecoration: invalid ? "line-through" : "none" }}>{formatLapTime(lap.lapTime, 3)}</span>
                        {invalid && (
                          <span title="Lap time deleted by the game (track limits / corner cut)" style={{ fontSize: 7.5, fontWeight: 800, letterSpacing: 0.4, color: C.red, textTransform: "uppercase", border: `1px solid ${C.red}`, borderRadius: 4, padding: "0 4px", whiteSpace: "nowrap" }}>Invalidated</span>
                        )}
                      </div>
                      <WrenchBtn onClick={() => onOpenSetup(lap)} has={!!lap.setup} />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        </div>

        {/* TelemetryStudio (compact) draws its own card */}
        <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column" }}>
          {tracesSlot}
        </div>
      </div>

      {pendingSave && (
        <div onClick={() => setPendingSave(null)} style={{
          position: "fixed", inset: 0, zIndex: 150, background: "rgba(5,7,11,.74)",
          backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: FONT.ui, padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            width: 420, maxWidth: "100%", background: C.modal, border: `1px solid ${C.borderModal}`,
            borderRadius: 16, boxShadow: "0 30px 80px rgba(0,0,0,.6)", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "20px 24px", borderBottom: `1px solid ${C.line}` }}>
              <div style={{ width: 5, height: 34, borderRadius: 3, background: C.accent }} />
              <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: .5, color: C.textHi }}>Hide your setup?</div>
            </div>
            <div style={{ padding: "20px 24px", fontSize: 13, lineHeight: 1.65, color: C.textMid }}>
              Do you want to hide your car setup in this saved lap? Choose <b style={{ color: C.textHi }}>Yes</b> to
              share the telemetry without disclosing your garage loadout.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, padding: "16px 24px",
              borderTop: `1px solid ${C.line}`, background: C.bg }}>
              <button onClick={() => finishSave(false)} style={{ padding: "11px 22px", borderRadius: 9,
                border: `1px solid ${C.borderStrong}`, background: C.surface, color: C.textMid, fontSize: 12,
                fontWeight: 800, letterSpacing: .5, cursor: "pointer", fontFamily: FONT.ui }}>No, keep setup</button>
              <button onClick={() => finishSave(true)} style={{ padding: "11px 22px", borderRadius: 9,
                border: `1px solid ${C.blue}`, background: C.blue, color: C.onAccent, fontSize: 12,
                fontWeight: 800, letterSpacing: .5, cursor: "pointer", fontFamily: FONT.ui }}>Yes, hide it</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const caret = { position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: C.textFaint, fontSize: 11 };
