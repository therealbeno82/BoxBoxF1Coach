// ─── COACH LOG SCREEN ───────────────────────────────────────────────────────
// The AI's structured findings per telemetry channel + a qualifying/race pace
// read + a next-lap focus. Driven by buildCoachLog (a deterministic analysis of
// ONE completed lap vs the reference — real, never mock); the next-lap focus
// prefers the LLM's grounded tip when one is available.
//
// That lap defaults to the newest one, so the screen updates itself as the driver
// laps, but the "Lap analysed" selector can pin it to any lap of the session —
// the whole screen (channels, trends, pace bucket, reference-match verdict) then
// describes that lap instead. The deterministic half recomputes for free on every
// selection; the LLM debrief costs an API call, so it's behind a button.
//
// The pace panel (buildPaceBuckets, lib/lapBuckets.js) took over the slot the old
// setup-direction guesses held: it shows each session type and race compound as
// its own bucket, which is also the scope every other figure on this screen is
// now computed over.

import { C, FONT, eyebrow } from "../../lib/ui/tokens.js";
import { formatLapTime } from "../../lib/format.js";

const card = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12 };

export default function CoachLogScreen({
  coachLog, trackName, sessionLabel, llmFocus, llmSummary, trends, refMismatch, refLabel,
  pace, coachBucket, coachingSet,
  // Which lap is being analysed. Shared with the Analytics "Driven Lap" selector:
  // "live" means "follow the newest completed lap" (Analytics' live lap is still
  // in progress, so it has no lap time and can't be analysed).
  lapOptions = [], lapId = "live", onSelectLap, coachLap, pinned = false,
  labelFor = (l) => l?.id, lapNotice = null,
  // Manual debrief for the lap on screen. Null when there's no LLM configured or
  // no evidence to ground it in.
  onAskCoach = null, asking = false,
}) {
  // buildTrends returns a prose block: a header line then "\n- " bullet items.
  // Split off the bullets for a compact recurring-patterns strip.
  const trendItems = typeof trends === "string" ? trends.split("\n- ").slice(1) : [];
  const paceRows = pace?.rows || [];
  const paceNotes = pace?.notes || [];
  // The exact lap set behind every cross-lap figure on this screen, plus what the
  // pace gate excluded — shown so the driver can audit the advice.
  const lapSet = coachingSet?.laps || [];
  const dropped = coachingSet?.dropped || [];
  const gate = coachingSet?.gate || null;

  return (
    <div style={{ flex: 1, minHeight: 0, background: C.bg, padding: "16px 28px 22px",
      display: "flex", flexDirection: "column", gap: 14, fontFamily: FONT.ui }}>

      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 13, flex: "none", flexWrap: "wrap" }}>
        <div style={{ width: 5, height: 42, borderRadius: 3, background: C.blue }} />
        <div>
          <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 1, lineHeight: 1 }}>{trackName || "Coach Log"}</div>
          {/* The bucket names which laps the advice was drawn from — a race stint on
              hards is coached against other hard-tyre race laps, never against quali.
              `refLabel` names the reference's own running, so the driver can see both
              sides of the comparison the numbers came from. */}
          <div style={{ fontSize: 11, letterSpacing: 2, color: C.textDim, textTransform: "uppercase", marginTop: 5 }}>
            Coach Log · {sessionLabel || "Analysis"}{coachBucket?.label ? ` · ${coachBucket.label}` : ""}
            {refLabel ? ` · vs ref ${refLabel}` : ""}
          </div>
        </div>

        {/* Which lap is under analysis. "Latest lap" keeps the pre-selector
            behaviour — the coach follows each lap as it completes; picking a
            specific lap pins the whole screen to it. */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 9 }}>
          {pinned && (
            <span title="Auto debriefs resume when you go back to the latest lap"
              style={{ fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 700,
                color: "#ffd54f", background: "#ffd54f1a", border: "1px solid #ffd54f55", borderRadius: 6, padding: "4px 8px" }}>
              Pinned lap
            </span>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 9, letterSpacing: 2, color: C.textDim, textTransform: "uppercase", fontWeight: 600 }}>Lap analysed</label>
            <select value={lapId} onChange={(e) => onSelectLap && onSelectLap(e.target.value)}
              style={{ appearance: "none", background: C.inset, color: C.textBody, border: `1px solid ${pinned ? "#ffd54f" : C.line}`,
                borderRadius: 8, padding: "7px 26px 7px 11px", fontSize: 12, fontFamily: FONT.ui, minWidth: 200, cursor: "pointer" }}>
              <option value="live">Latest lap (follows)</option>
              {lapOptions.map((l) => <option key={l.id} value={l.id}>{labelFor(l)}</option>)}
            </select>
          </div>
          {onAskCoach && (
            <button onClick={onAskCoach} disabled={asking}
              title="Run the AI debrief for the lap on screen"
              style={{ alignSelf: "flex-end", background: asking ? C.inset : "#1a1030", color: asking ? C.textDim : "#c39bff",
                border: `1px solid ${asking ? C.line : "#2c2150"}`, borderRadius: 8, padding: "8px 13px",
                fontSize: 11.5, fontWeight: 700, fontFamily: FONT.ui, cursor: asking ? "default" : "pointer" }}>
              {asking ? "Analysing…" : "✦ Ask the coach"}
            </button>
          )}
        </div>
      </div>

      {/* The selected lap isn't one the coach can analyse (invalidated in-game, or
          no usable telemetry), so the analysis below is of a different lap than the
          dropdown names. Never let that pass silently. */}
      {lapNotice && (
        <div style={{ flex: "none", background: "#3a2400", border: "1px solid #ff910055", borderRadius: 9,
          padding: "9px 13px", fontSize: 11.5, color: "#ffb74d", lineHeight: 1.5 }}>
          {lapNotice}
        </div>
      )}

      {/* Reference not comparable with the lap driven — track, conditions, session
          type or compound differ (lib/coach/refMatch.js). Every channel figure
          would be an artefact of that difference rather than of the driving, so
          the coach withholds the analysis and names what's wrong instead. */}
      {refMismatch ? (
        <div style={{ flex: 1, ...card, borderColor: C.red || "#ff4d5e", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "48px 24px" }}>
          <div style={{ fontSize: 30, marginBottom: 12 }}>⚠️</div>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 10, color: C.red || "#ff4d5e" }}>
            Reference isn't comparable with your lap
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 520, width: "100%", marginBottom: 12 }}>
            {refMismatch.reasons.map((r) => (
              <div key={r.kind} style={{ background: C.inset, border: `1px solid ${C.line}`, borderRadius: 9, padding: "10px 13px", textAlign: "left" }}>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, marginBottom: 3 }}>{r.title}</div>
                <div style={{ fontSize: 11, color: C.textMid, lineHeight: 1.55 }}>{r.detail}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, color: C.textMid, maxWidth: 460, lineHeight: 1.6 }}>
            Comparing across those differences produces confident advice about time you couldn't take back,
            so no insights are shown. Pick a reference set in the same conditions — or clear it — to get coaching again.
          </div>
        </div>
      ) : !coachLog ? (
        <div style={{ flex: 1, ...card, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "48px 24px" }}>
          <div style={{ fontSize: 30, marginBottom: 12 }}>✦</div>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>No analysis yet</div>
          <div style={{ fontSize: 12, color: C.textMid, maxWidth: 440, lineHeight: 1.6 }}>
            Load a reference lap and drive a full lap. When you cross the line the coach breaks down where
            the time went — per channel, with your qualifying and race pace and a next-lap focus.
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

          {/* Qualifying vs race pace, one card per bucket */}
          {paceRows.length > 0 && (
            <div style={{ flex: "none", ...card, padding: "13px 16px 15px", display: "flex", flexDirection: "column", gap: 11 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                <span style={{ width: 24, height: 24, flex: "none", borderRadius: 7, background: "#FFC40022", border: `1px solid ${C.yellow}`, display: "flex", alignItems: "center", justifyContent: "center", color: C.yellow, fontFamily: FONT.mono, fontWeight: 800, fontSize: 11 }}>⏱</span>
                <span style={{ fontSize: 11, letterSpacing: 2, color: C.textMuted, textTransform: "uppercase", fontWeight: 700 }}>Qualifying &amp; Race Pace</span>
                <span style={{ fontSize: 10, color: C.textDim, letterSpacing: .5 }}>Each session type and race compound judged only against its own laps</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 11 }}>
                {paceRows.map((r) => {
                  const accent = r.color || (r.group === "Race" ? C.textMuted : C.purple);
                  return (
                    <div key={r.key} style={{ background: C.inset, border: `1px solid ${r.active ? accent : C.line}`, borderLeft: `3px solid ${accent}`, borderRadius: "0 8px 8px 0", padding: "11px 12px", display: "flex", flexDirection: "column", gap: 7 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: C.textBody2, lineHeight: 1.1 }}>{r.label}</span>
                        {r.active && <span style={{ fontSize: 8, letterSpacing: 1, textTransform: "uppercase", color: accent, border: `1px solid ${accent}`, borderRadius: 4, padding: "1px 5px" }}>This run</span>}
                        <span style={{ marginLeft: "auto", fontSize: 9, letterSpacing: 1, color: C.textDim, textTransform: "uppercase" }}>{r.laps} lap{r.laps === 1 ? "" : "s"}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                        <span>
                          <span style={{ fontSize: 8, letterSpacing: 1.5, color: C.textDim, textTransform: "uppercase", marginRight: 5 }}>Best</span>
                          <span style={{ fontFamily: FONT.mono, fontSize: 14, fontWeight: 800, color: accent }}>{r.bestText}</span>
                        </span>
                        <span>
                          <span style={{ fontSize: 8, letterSpacing: 1.5, color: C.textDim, textTransform: "uppercase", marginRight: 5 }}>Typical</span>
                          <span style={{ fontFamily: FONT.mono, fontSize: 12, color: C.textBody }}>{r.typicalText}</span>
                        </span>
                        {r.deg != null && (
                          <span>
                            <span style={{ fontSize: 8, letterSpacing: 1.5, color: C.textDim, textTransform: "uppercase", marginRight: 5 }}>Stint</span>
                            <span style={{ fontFamily: FONT.mono, fontSize: 12, color: r.deg > 0.06 ? C.red : r.deg < -0.06 ? C.green : C.textMid }}>
                              {r.deg >= 0 ? "+" : "−"}{Math.abs(r.deg).toFixed(2)}s/lap
                            </span>
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 10.5, lineHeight: 1.45, color: C.textMid }}>{r.advice}</div>
                    </div>
                  );
                })}
              </div>
              {paceNotes.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {paceNotes.map((n, i) => (
                    <div key={i} style={{ fontSize: 11, lineHeight: 1.5, color: C.textBody, borderLeft: `3px solid ${C.yellow}`, paddingLeft: 9 }}>{n}</div>
                  ))}
                </div>
              )}
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

          {/* Which laps the cross-lap figures were actually drawn from. A trend the
              driver doesn't recognise is usually a lap they wouldn't have counted —
              an out-lap, a traffic lap — so the set is stated openly, including
              what the pace gate threw out and why (see lib/lapBuckets.js). */}
          {lapSet.length > 0 && (
            <div style={{ flex: "none", ...card, padding: "12px 16px 14px", display: "flex", flexDirection: "column", gap: 9 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, letterSpacing: 2, color: C.textMuted, textTransform: "uppercase", fontWeight: 700 }}>Laps Feeding This Analysis</span>
                <span style={{ fontSize: 10, color: C.textDim, letterSpacing: .5 }}>
                  {coachBucket?.label ? `${coachBucket.label} · ` : ""}
                  {gate ? `within ${formatLapTime(gate.cutoff)}` : "no pace gate — too few laps"}
                </span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {lapSet.map((l, i) => (
                  <span key={l.id ?? `k${i}`} style={{ background: C.inset, border: `1px solid ${C.line}`, borderRadius: 7, padding: "4px 9px", fontFamily: FONT.mono, fontSize: 10.5, color: C.textBody }}>
                    {l.lapNumber != null ? `L${l.lapNumber} ` : ""}{formatLapTime(l.lapTime)}
                  </span>
                ))}
                {dropped.map(({ lap: l, reason }, i) => (
                  <span key={l.id ?? `d${i}`} title={`Excluded — ${reason}`}
                    style={{ background: "transparent", border: `1px dashed ${C.line}`, borderRadius: 7, padding: "4px 9px", fontFamily: FONT.mono, fontSize: 10.5, color: C.textDim, textDecoration: "line-through" }}>
                    {l.lapNumber != null ? `L${l.lapNumber} ` : ""}{formatLapTime(l.lapTime)}
                  </span>
                ))}
              </div>
              {dropped.length > 0 && (
                <div style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.5 }}>
                  {dropped.length} lap{dropped.length === 1 ? "" : "s"} excluded as off-pace (out-laps, traffic, fuel saving) — they'd skew every cross-lap figure above.
                </div>
              )}
              {coachingSet?.outlierSubject && (
                <div style={{ fontSize: 10.5, color: C.yellow || "#ffd54f", lineHeight: 1.5 }}>
                  The lap being analysed is itself off the pace of this set — it's still analysed (it's the lap you asked for), but read the cross-lap figures with that in mind.
                </div>
              )}
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
                <div style={{ fontSize: 8, letterSpacing: 1, color: C.textDim, textTransform: "uppercase", marginTop: 2 }}>
                  {coachBucket?.label ? `Comparable · ${coachBucket.label}` : "Comparable laps only"}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
