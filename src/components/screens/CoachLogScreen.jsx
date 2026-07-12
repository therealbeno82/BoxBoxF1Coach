// ─── COACH LOG SCREEN ───────────────────────────────────────────────────────
// The AI's structured findings per telemetry channel + recommended setup
// directions + a next-lap focus. Driven by buildCoachLog (a deterministic analysis
// of the most recent completed lap vs the reference — real, never mock); the
// next-lap focus prefers the LLM's grounded tip when one is available.

import { C, FONT, eyebrow } from "../../lib/ui/tokens.js";

const card = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12 };

export default function CoachLogScreen({ coachLog, trackName, sessionLabel, llmFocus, llmSummary, trends, trackMismatch }) {
  // buildTrends returns a prose block: a header line then "\n- " bullet items.
  // Split off the bullets for a compact recurring-patterns strip.
  const trendItems = typeof trends === "string" ? trends.split("\n- ").slice(1) : [];

  return (
    <div style={{ flex: 1, minHeight: 0, background: C.bg, padding: "16px 28px 22px",
      display: "flex", flexDirection: "column", gap: 14, fontFamily: FONT.ui }}>

      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 13, flex: "none" }}>
        <div style={{ width: 5, height: 42, borderRadius: 3, background: C.blue }} />
        <div>
          <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 1, lineHeight: 1 }}>{trackName || "Coach Log"}</div>
          <div style={{ fontSize: 11, letterSpacing: 2, color: C.textDim, textTransform: "uppercase", marginTop: 5 }}>Coach Log · {sessionLabel || "Analysis"}</div>
        </div>
      </div>

      {trackMismatch ? (
        <div style={{ flex: 1, ...card, borderColor: C.red || "#ff4d5e", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "48px 24px" }}>
          <div style={{ fontSize: 30, marginBottom: 12 }}>⚠️</div>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6, color: C.red || "#ff4d5e" }}>Track names do not match</div>
          <div style={{ fontSize: 12, color: C.textMid, maxWidth: 460, lineHeight: 1.6 }}>
            The loaded reference lap is from <b style={{ color: C.textBody }}>{trackMismatch.refTrack || "another circuit"}</b>,
            but you're driving <b style={{ color: C.textBody }}>{trackMismatch.drivenTrack || "a different circuit"}</b>.
            The coach only compares laps from the same track, so no advice is shown. Load a reference for this
            circuit — or clear it — to get coaching again.
          </div>
        </div>
      ) : !coachLog ? (
        <div style={{ flex: 1, ...card, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "48px 24px" }}>
          <div style={{ fontSize: 30, marginBottom: 12 }}>✦</div>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>No analysis yet</div>
          <div style={{ fontSize: 12, color: C.textMid, maxWidth: 440, lineHeight: 1.6 }}>
            Load a reference lap and drive a full lap. When you cross the line the coach breaks down where
            the time went — per channel, with setup directions and a next-lap focus.
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 14 }}>

          {/* Channel insight panels */}
          <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
            {coachLog.channels.map((ch) => (
              <div key={ch.name} style={{ minHeight: 0, ...card, borderTop: `3px solid ${ch.color}`, padding: "16px 15px", display: "flex", flexDirection: "column", gap: 13 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 34, height: 34, flex: "none", borderRadius: 9, background: ch.color + "1f", border: `1px solid ${ch.color}`, color: ch.color,
                    display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.mono, fontWeight: 800, fontSize: 14 }}>{ch.abbr}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: 1 }}>{ch.name}</div>
                    <div style={{ fontSize: 9, letterSpacing: 1.5, color: C.textDim, textTransform: "uppercase", marginTop: 2 }}>{ch.insights.length} insight{ch.insights.length === 1 ? "" : "s"}</div>
                  </div>
                </div>

                {/* Potential */}
                <div style={{ flex: "none", background: C.inset, border: `1px solid ${C.line}`, borderRadius: 9, padding: "11px 12px" }}>
                  <div style={{ fontSize: 8, letterSpacing: 1.5, color: C.textDim, textTransform: "uppercase" }}>Potential gain</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 4 }}>
                    <span style={{ fontFamily: FONT.mono, fontSize: 22, fontWeight: 800, color: ch.color }}>{ch.potential}</span>
                    <span style={{ fontSize: 10, color: C.textDim }}>/ lap</span>
                  </div>
                  <div style={{ marginTop: 9, height: 5, background: C.line, borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: ch.signal === "—" ? "0%" : ch.signal, background: ch.color, borderRadius: 3 }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5 }}>
                    <span style={{ fontSize: 8, letterSpacing: 1, color: C.textDim, textTransform: "uppercase" }}>Evidence</span>
                    <span style={{ fontFamily: FONT.mono, fontSize: 9, color: C.textMuted }}>{ch.signal}</span>
                  </div>
                </div>

                {/* Insights */}
                <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 9, paddingRight: 4 }}>
                  {ch.insights.length === 0 && (
                    <div style={{ fontSize: 11, color: C.textFaint, lineHeight: 1.5, padding: "4px 2px" }}>On the reference here — no change needed.</div>
                  )}
                  {ch.insights.map((ins, i) => (
                    <div key={i} style={{ background: C.inset, border: `1px solid ${C.line}`, borderLeft: `3px solid ${ch.color}`, borderRadius: "0 8px 8px 0", padding: "10px 11px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 6 }}>
                        <span style={{ fontFamily: FONT.mono, fontSize: 9, letterSpacing: .5, color: C.textMuted }}>{ins.zone}</span>
                        <span style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
                          {ins.time && <span style={{ fontFamily: FONT.mono, fontSize: 9, color: C.textDim }}>{ins.time}</span>}
                          <span style={{ fontFamily: FONT.mono, fontSize: 10, fontWeight: 700, color: ch.color }}>{ins.delta}</span>
                        </span>
                      </div>
                      <div style={{ fontSize: 11.5, lineHeight: 1.5, color: C.textBody }}>{ins.text}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Setup changes */}
          {coachLog.setupSuggestions.length > 0 && (
            <div style={{ flex: "none", ...card, padding: "13px 16px 15px", display: "flex", flexDirection: "column", gap: 11 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                <span style={{ width: 24, height: 24, flex: "none", borderRadius: 7, background: "#2ED57322", border: `1px solid ${C.green}`, display: "flex", alignItems: "center", justifyContent: "center", color: C.green, fontFamily: FONT.mono, fontWeight: 800, fontSize: 11 }}>⚙</span>
                <span style={{ fontSize: 11, letterSpacing: 2, color: C.textMuted, textTransform: "uppercase", fontWeight: 700 }}>Setup Directions to Try</span>
                <span style={{ fontSize: 10, color: C.textDim, letterSpacing: .5 }}>Rule-of-thumb · derived from this lap</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 11 }}>
                {coachLog.setupSuggestions.map((s, i) => (
                  <div key={i} style={{ background: C.inset, border: `1px solid ${C.line}`, borderLeft: `3px solid ${s.color}`, borderRadius: "0 8px 8px 0", padding: "11px 12px", display: "flex", flexDirection: "column", gap: 7 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 26, height: 26, flex: "none", borderRadius: 7, background: s.color + "1f", border: `1px solid ${s.color}`, color: s.color, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.mono, fontWeight: 800, fontSize: 10 }}>{s.abbr}</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: C.textBody2, lineHeight: 1.1 }}>{s.label}</span>
                      <span style={{ marginLeft: "auto", fontFamily: FONT.mono, fontSize: 13, fontWeight: 800, color: s.color }}>{s.dir}</span>
                    </div>
                    <div style={{ fontSize: 10.5, lineHeight: 1.45, color: C.textMid }}>{s.note}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Coach debrief — the LLM's grounded read of the lap (when a model is on) */}
          {llmSummary && (
            <div style={{ flex: "none", background: "linear-gradient(135deg,#161029,#11151d)", border: "1px solid #2c2150", borderRadius: 12, padding: "13px 17px", display: "flex", gap: 13 }}>
              <span style={{ width: 26, height: 26, flex: "none", borderRadius: 7, background: "#b45bff22", border: `1px solid ${C.purple}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>✦</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 9, letterSpacing: 2, color: "#c39bff", textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>Coach · Debrief</div>
                <div style={{ fontSize: 12.5, lineHeight: 1.55, color: C.textBody }}>{llmSummary}</div>
              </div>
            </div>
          )}

          {/* Recurring patterns across the driver's saved laps */}
          {trendItems.length > 0 && (
            <div style={{ flex: "none", ...card, padding: "13px 16px 15px", display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                <span style={{ width: 24, height: 24, flex: "none", borderRadius: 7, background: "#34c8ff22", border: `1px solid ${C.ers || "#34c8ff"}`, display: "flex", alignItems: "center", justifyContent: "center", color: "#34c8ff", fontSize: 12 }}>↻</span>
                <span style={{ fontSize: 11, letterSpacing: 2, color: C.textMuted, textTransform: "uppercase", fontWeight: 700 }}>Recurring Across Your Laps</span>
                <span style={{ fontSize: 10, color: C.textDim, letterSpacing: .5 }}>Patterns on most laps · not just this one</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 9 }}>
                {trendItems.map((t, i) => (
                  <div key={i} style={{ background: C.inset, border: `1px solid ${C.line}`, borderLeft: "3px solid #34c8ff", borderRadius: "0 8px 8px 0", padding: "9px 11px", fontSize: 11, lineHeight: 1.5, color: C.textBody }}>{t}</div>
                ))}
              </div>
            </div>
          )}

          {/* Next-lap focus strip */}
          <div style={{ flex: "none", display: "flex", gap: 14, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 360px", minWidth: 280, background: "linear-gradient(135deg,#161029,#11151d)", border: "1px solid #2c2150", borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", gap: 14 }}>
              <span style={{ width: 26, height: 26, flex: "none", borderRadius: 7, background: "#b45bff22", border: `1px solid ${C.purple}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>✦</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 9, letterSpacing: 2, color: "#c39bff", textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>Coach · Next-Lap Focus</div>
                <div style={{ fontSize: 13, lineHeight: 1.5, color: C.textBody }}>{llmFocus || coachLog.nextLapFocus}</div>
              </div>
            </div>
            <div style={{ flex: "none", width: 300, ...card, padding: "14px 18px", display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 8, letterSpacing: 1.5, color: C.textDim, textTransform: "uppercase" }}>Time on table</div>
                <div style={{ fontFamily: FONT.mono, fontSize: 24, fontWeight: 800, color: C.yellow, marginTop: 3 }}>{coachLog.totalGain}</div>
                <div style={{ fontSize: 8, letterSpacing: 1, color: C.textDim, textTransform: "uppercase", marginTop: 2 }}>
                  {coachLog.estimated ? "Estimated · no ref lap time" : "Measured vs reference"}
                </div>
              </div>
              <div style={{ flex: 1, borderLeft: `1px solid ${C.line}`, paddingLeft: 16 }}>
                <div style={{ fontSize: 8, letterSpacing: 1.5, color: C.textDim, textTransform: "uppercase" }}>Laps analysed</div>
                <div style={{ fontFamily: FONT.mono, fontSize: 24, fontWeight: 800, marginTop: 3 }}>{coachLog.lapsAnalysed}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
