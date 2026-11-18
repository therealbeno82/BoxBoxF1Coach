// ─── ANALYTICS SCREEN (Performance Center) ──────────────────────────────────
// Post-session lap analysis, one combined view: reference/driven lap selectors
// above the 2D driving lines beside the telemetry trace stack, with the
// lap-consistency sector matrix as a collapsible strip along the bottom (no
// tab-flicking while analysing a lap). The heavy reusable views are passed in
// as slots (`linesSlot` / `tracesSlot`) so they keep their existing engine;
// this screen owns the chrome + the matrix.

import { useMemo, useRef, useState } from "react";
import { C, FONT, fmtDelta } from "../../lib/ui/tokens.js";
import { formatLapTime } from "../../lib/format.js";
import { useViewport } from "../../hooks/useViewport.jsx";
import Hint from "../Hint.jsx";
import { computeDriverStats, isRankable } from "../../lib/driverStats.js";
import { eligibility } from "../../lib/leaderboard/eligibility.js";
import { WrenchIcon, TrashIcon } from "../icons.jsx";
import ModalShell, { modalBtn } from "../ModalShell.jsx";
import DeleteLapConfirm from "../DeleteLapConfirm.jsx";

// The `phone` variants are 30px tall rather than 42, because vertical space is
// the scarce axis there. They keep the `height: 30` but NO LONGER set
// `minHeight: 0` — that opt-out was the reason the load button measured 25×30 on
// a phone, well under anything a thumb can hit, and the icon-only variants are
// the smallest targets in the app.
//
// Dropping it hands the row back to index.html's `(pointer: coarse)` floor,
// which is the honest arbiter: `min-height` beats `height` in the cascade, so a
// TOUCH screen gets a full 44px control while a fine pointer at the same width —
// a narrow desktop window — still gets the compact 30px this row was designed
// around. The controls of one row have to agree, so the select opted back in
// alongside the buttons rather than leaving 30px selects in a 44px row.
const selectStyle = (color, phone = false) => ({
  width: "100%", appearance: "none", WebkitAppearance: "none", background: C.surface,
  border: `1px solid ${C.borderStrong}`, borderRadius: phone ? 7 : 9, color, fontFamily: FONT.mono,
  fontSize: phone ? 12 : 14, fontWeight: 700,
  padding: phone ? "0 26px 0 10px" : "11px 36px 11px 14px",
  ...(phone && { height: 30 }),
  cursor: "pointer", outline: "none",
});

const actionBtn = (border, color, phone = false) => ({
  flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
  padding: phone ? "0 9px" : "0 14px",
  borderRadius: phone ? 7 : 9, border: `1px solid ${border}`, background: C.surface, color,
  fontFamily: FONT.ui, fontSize: phone ? 10 : 11, letterSpacing: phone ? 0.5 : 1,
  textTransform: "uppercase", fontWeight: 700,
  cursor: "pointer", whiteSpace: "nowrap", height: phone ? 30 : 42,
  // A thumb needs width as well as height, and the coarse-pointer rule only
  // grants the latter. 44 on the icon-only phone variants; the label-bearing
  // desktop ones are already wider than this.
  ...(phone && { minWidth: 44 }),
});

// The matrix's setup button. Its column is 28px wide and cannot be widened —
// the lap-time track beside it needs 62px of its 66.5 for "1:38.311", so the 16
// a 44px column would cost comes straight out of the data. So the BUTTON grows
// instead of the track: 44 wide, hanging 16px back over the lap time with a
// negative margin, and only its right-hand 28px carries the visible chrome
// (`justifyContent: flex-end`). That space is safe to take because a matrix row
// is a plain div — nothing under the overhang is clickable, so a wider hit area
// here steals no other control's taps.
const WrenchBtn = ({ onClick, has }) => (
  <button onClick={onClick} title="View car setup" disabled={!has} style={{
    justifySelf: "end", flex: "none", display: "flex", alignItems: "center", justifyContent: "flex-end",
    width: 44, marginLeft: -16, height: 44, padding: 0, border: "none", background: "transparent",
    cursor: has ? "pointer" : "default" }}>
    <span style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      width: 28, height: 28, borderRadius: 7, border: `1px solid ${C.line}`, background: C.surface,
      color: has ? "#7ea6e6" : C.textFaintest, opacity: has ? 1 : 0.5 }}>
      <WrenchIcon size={14} />
    </span>
  </button>
);

const SetupBtn = ({ onClick, phone = false }) => (
  <button onClick={onClick} title="View car setup"
    style={{ ...actionBtn(C.borderStrong, "#7ea6e6", phone), width: phone ? 44 : 42, padding: 0, justifyContent: "center", gap: 0 }}>
    <WrenchIcon size={phone ? 13 : 16} />
  </button>
);

// Delete a recorded lap. A bin rather than the ✕ it used to share with "remove
// trace": one glyph for a harmless action and an irreversible one is how a lap
// gets destroyed by accident. The click only opens the confirmation.
const DeleteBtn = ({ onClick, phone = false }) => (
  <button onClick={onClick} title="Delete lap" aria-label="Delete lap"
    style={{ ...actionBtn("#4a2130", "#ff6b7d", phone), width: phone ? 44 : 42, padding: 0, justifyContent: "center", gap: 0 }}>
    <TrashIcon size={phone ? 13 : 15} />
  </button>
);

// Publish to the online leaderboard. Disabled — with the reason in its tooltip —
// when the lap isn't publishable, rather than hidden: a driver who has just set a
// good race lap should find out WHY it can't go on a board, not be left guessing
// where the button went.
const PublishBtn = ({ lap, onPublish, phone = false }) => {
  const elig = eligibility(lap);
  return (
    <button
      onClick={() => elig.ok && onPublish(lap)}
      disabled={!elig.ok}
      title={elig.ok ? "Publish this lap to the leaderboard" : elig.reason}
      aria-label={elig.ok ? "Publish this lap to the leaderboard" : `Can't publish: ${elig.reason}`}
      style={{
        ...actionBtn(elig.ok ? "#2c2150" : C.line, elig.ok ? "#b98cff" : C.textFaintest, phone),
        cursor: elig.ok ? "pointer" : "default",
        opacity: elig.ok ? 1 : 0.55,
      }}>{phone ? "🏆" : "🏆 Publish"}</button>
  );
};

const card = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12 };

const fmtSec = (s) => (typeof s === "number" && s > 0 ? s.toFixed(3) : "—");

// ─── Consistency-matrix column template ─────────────────────────────────────
// The header row and every lap row MUST resolve to identical tracks, or the
// S1/S2/S3 labels stop describing the columns beneath them. Defined once here
// and read by both, so they cannot drift.
//
// Every flexible track is `minmax(0, …)` rather than a bare `1fr`, and that is
// the whole fix. A bare `1fr` means `minmax(auto, 1fr)`, and the `auto` floor is
// a track's MIN-CONTENT width — which differs between the two grids using this
// one template: a header cell holds "S1" (~12px) while a data cell holds
// "32.461 +4.881" (~88px). So on a phone the header's sector tracks resolved to
// ~40px and a row's to ~90px, the row overflowed the strip (534px of content in
// a 353px box), and because the scroll container sets overflowY — which makes
// the other axis `auto` too — the row scrolled sideways out from under a header
// that could not follow. Rows disagreed with EACH OTHER for the same reason: a
// session-best sector carries no delta, so that one track came out 50px, not 90.
// `minmax(0, …)` lets a track go narrower than its content, so a row can never
// be wider than the box it sits in and the two grids are identical by
// construction. Desktop always had room and so never showed any of it.
//
// The compact column set is narrower everywhere it can afford to be — the lap
// number needs two digits, not four — and gives the lap time a larger share,
// since "1:38.311" is the widest single value in the row.
const matrixCols = (compact) => (compact
  ? "32px repeat(3, minmax(0, 1fr)) minmax(0, 1.4fr) 28px"
  : "60px repeat(3, minmax(0, 1fr)) minmax(0, 1.15fr) 34px");

export default function AnalyticsScreen({
  trackName, sessionLabel, laps = [],
  comparisonLap,
  referenceSources = [], referenceId, onSelectReference, onLoadTrace, onRemoveTrace,
  comparisonSources = [], comparisonId, onSelectComparison, onDeleteLap, onExportLap, onPublishLap,
  labelFor = (s) => s?.id, onOpenSetup,
  tracesSlot, linesSlot,
  // Demo Mode is replaying: this screen's best-lap readout follows the replay's
  // laps, which the driver's own boards never see (isDemoLap).
  demoMode = false,
}) {
  // Is the consistency strip along the bottom expanded?
  // `compact` (≤1023px), not `phone`, drives the consistency matrix below. Above
  // phone width this screen is TWO columns, so the strip only ever gets about
  // half the viewport: ~615px at a 1280 desktop, but ~372px on a landscape phone
  // once the nav rail has taken its 78, and ~486px at the 1023px tablet ceiling
  // against the ~492px the roomy layout needs. Keying its density on `phone`
  // would hand the widest treatment to the two cases with the least room.
  const { phone, compact } = useViewport();
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

  // Lap awaiting a delete confirmation. Deleting is irreversible, so these
  // buttons ask first, in the same words the Dashboard's PB rows use.
  const [pendingDelete, setPendingDelete] = useState(null);

  const stats = useMemo(() => computeDriverStats(laps, { demo: demoMode }), [laps, demoMode]);

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
    <div style={{ flex: 1, minHeight: 0, background: C.bg, padding: "16px var(--screen-px) 22px",
      display: "flex", flexDirection: "column", gap: 14, fontFamily: FONT.ui,
      // On a phone the panels below carry their own heights and the whole screen
      // scrolls in Shell's body, so the screen must be free to grow past the
      // viewport rather than squeezing its children into it.
      ...(phone && { flex: "none", minHeight: "auto" }) }}>

      {/* Top bar */}
      {/* Title and best lap share one line on a phone, at the same sizes the Live
          screen's header uses — two headers on the same device that describe the
          same session should not be two different sizes. */}
      <div style={{ display: "flex", alignItems: "center", gap: phone ? 10 : 20, flexWrap: "wrap", flex: "none" }}>
        <div style={{ display: "flex", alignItems: "center", gap: phone ? 9 : 13, minWidth: 0, ...(phone && { flex: "1 1 auto" }) }}>
          <div style={{ width: 5, height: phone ? 34 : 42, borderRadius: 3, background: C.blue, flex: "none" }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: phone ? 15 : 21, fontWeight: 800, letterSpacing: 1, lineHeight: 1,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{trackName || "Performance Center"}</div>
            <div style={{ fontSize: phone ? 9 : 11, letterSpacing: 2, color: C.textDim, textTransform: "uppercase", marginTop: phone ? 4 : 5,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {phone ? (sessionLabel || "Analysis") : `Performance Center · ${sessionLabel || "Analysis"}`}
            </div>
          </div>
        </div>
        {!phone && <div style={{ width: 1, height: 38, background: C.line }} />}
        <div style={{ ...(phone && { flex: "none", textAlign: "right" }) }}>
          <div style={{ fontSize: phone ? 8 : 9, letterSpacing: phone ? 1 : 2, color: C.textDim, textTransform: "uppercase" }}>Best Lap</div>
          <div style={{ fontFamily: FONT.mono, fontSize: phone ? 17 : 30, fontWeight: 800, lineHeight: 1, marginTop: 3, color: C.purple,
            whiteSpace: "nowrap" }}>
            {stats.fastestOverall ? formatLapTime(stats.fastestOverall.lapTime, 3) : "—"}
          </div>
        </div>
      </div>

      {/* Lap selectors */}
      <div style={{ display: "flex", gap: phone ? 7 : 18, padding: "2px", flex: "none", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 280px", display: "flex", flexDirection: "column", gap: phone ? 2 : 5 }}>
          <label style={{ fontSize: phone ? 8 : 9, letterSpacing: phone ? 1 : 2, color: C.textDim, textTransform: "uppercase", fontWeight: 600 }}>Reference Lap</label>
          <div style={{ display: "flex", gap: phone ? 5 : 8 }}>
            <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
              <select value={referenceId || ""} onChange={(e) => onSelectReference(e.target.value || null)} style={selectStyle("#ffffff", phone)}>
                <option value="">None — no reference</option>
                {referenceSources.map((s) => <option key={s.id} value={s.id}>{labelFor(s)}</option>)}
              </select>
              <span style={phone ? caretPhone : caret}>▾</span>
            </div>
            <input ref={fileRef} type="file" accept=".json" multiple style={{ display: "none" }}
              onChange={(e) => { Array.from(e.target.files).forEach(onLoadTrace); e.target.value = ""; }} />
            <button onClick={() => fileRef.current.click()} title="Load a trace JSON from the Calibrator" aria-label="Load a trace file" style={actionBtn(C.borderStrong, "#9aa3b8", phone)}>{phone ? "↧" : "↧ Load"}</button>
            {selectedRef?.setup && <SetupBtn onClick={() => onOpenSetup(selectedRef)} phone={phone} />}
            {selectedRef && (
              // A loaded trace is only REMOVED from this session (✕, harmless); a
              // recorded lap picked as the reference is DELETED (bin, confirmed).
              refIsLoaded
                ? <button onClick={() => onRemoveTrace(selectedRef.id)} title="Remove trace" aria-label="Remove trace"
                    style={actionBtn("#3a2400", "#ff9100", phone)}>✕</button>
                : <DeleteBtn onClick={() => setPendingDelete(selectedRef)} phone={phone} />
            )}
          </div>
        </div>
        {/* Reads as a divider only while the two selectors sit side by side; once
            they stack it's a stray word hanging off the first one. */}
        {!phone && (
          <div style={{ display: "flex", alignItems: "flex-end", paddingBottom: 11, color: C.textFaint, fontSize: 11, letterSpacing: 1 }}>VS</div>
        )}
        <div style={{ flex: "1 1 280px", display: "flex", flexDirection: "column", gap: phone ? 2 : 5 }}>
          <label style={{ fontSize: phone ? 8 : 9, letterSpacing: phone ? 1 : 2, color: C.textDim, textTransform: "uppercase", fontWeight: 600 }}>Driven Lap</label>
          <div style={{ display: "flex", gap: phone ? 5 : 8 }}>
            <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
              <select value={comparisonId} onChange={(e) => onSelectComparison(e.target.value)} style={selectStyle(C.cyan, phone)}>
                <option value="live">Live lap</option>
                {comparisonSources.map((s) => <option key={s.id} value={s.id}>{labelFor(s)}</option>)}
              </select>
              <span style={phone ? caretPhone : caret}>▾</span>
            </div>
            {selectedComparisonIsLap && (
              <>
                {comparisonLap.setup && <SetupBtn onClick={() => onOpenSetup(comparisonLap)} phone={phone} />}
                <button onClick={() => requestSave(comparisonLap)} title="Save lap to a .json file" aria-label="Save lap to a file" style={actionBtn("#0c3a1c", "#00e676", phone)}>{phone ? "⬇" : "⬇ Save"}</button>
                {onPublishLap && <PublishBtn lap={comparisonLap} onPublish={onPublishLap} phone={phone} />}
                <DeleteBtn onClick={() => setPendingDelete(comparisonLap)} phone={phone} />
              </>
            )}
          </div>
        </div>
      </div>

      {/* Left column: the driving-lines view above the lap strip (both share its width);
          right column: the telemetry trace stack running the full height. Both
          columns are equal width so the split lands under the "VS" above — the
          two lap selectors are equal width too, centring the VS on the same axis.
          NOTE this row does NOT wrap — the two columns are meant to share the
          height, so on a narrow window they'd squash to ~170 px each rather than
          stack. On a phone that's unreadable, so the row becomes a COLUMN and each
          panel takes a fixed height and scrolls past instead. */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 14,
        ...(phone && { flexDirection: "column", flex: "none", minHeight: "auto" }) }}>
        {/* On a phone this wrapper has no job left. Its only purpose is to hold
            the map and the consistency strip together as ONE of the two desktop
            columns, and the row above is already a column here. `display:
            contents` dissolves it, so its two children become direct children of
            that column — which is the whole point: while the strip lives inside
            this wrapper and the traces live beside it, the two are in DIFFERENT
            flex containers and no `order` can interleave them. Dissolving the
            wrapper is what puts all three panels in one container and makes the
            strip's `order` below mean something. (The 12px gap goes with it; the
            outer column's 14px takes over, which is the spacing the other
            phone stacks already use.) */}
        <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 12,
          ...(phone && { display: "contents" }) }}>
          {/* Taller on a phone than it looks like it needs: the driving-lines view
              un-stacks its corner overlays into rows above and below the map there,
              so ~270px of this panel is controls before the road gets any.
              710, up from 655, because those controls grew when they were lifted to
              the 44px tap floor — the camera pills, the transport and the zoom row
              took ~55px between them. The map viewport is `flex: 1 1 0`, so without
              this it silently paid for all of it and dropped to 351px.
              698 now: the camera pills went from 44px tall to 32 (they are 79px
              WIDE, so the target is bigger in area than the floor protects — see
              DrivingLinesView), and the 12px that frees has to come off the PANEL
              rather than be left to the map. `flex: 1 1 0` means the map absorbs
              any slack silently, and a 12px taller map is not what was asked for:
              the point was to give the 12px back to the screen. */}
          <div style={{ flex: 1, minHeight: 0, ...card, padding: phone ? "10px 10px" : "14px 16px", display: "flex", flexDirection: "column",
            ...(phone && { flex: "none", height: 698 }) }}>
            {linesSlot}
          </div>

        {/* Collapsible lap-consistency strip. Under the map on desktop, where it
            shares the left column's width; LAST on a phone, below the telemetry
            traces. Everything else on this screen is the lap you are looking at —
            the road and the traces — while the matrix is a table of the OTHER
            laps, consulted rather than read. Putting it third keeps the two
            views of the current lap adjacent instead of separated by a table.
            `order` rather than a second copy of the markup: it is defined once
            and sits in one place in the DOM, so the two layouts cannot drift. */}
        <div style={{ flex: "none", ...card, overflow: "hidden",
          ...(phone && { order: 1 }) }}>
          {/* The strip's own header carried 534px of content in the 353px box a
              phone gives it, which pushed the ▾ chevron clean off the screen at
              x536 — the button still toggled, but the only sign of whether the
              strip was open or shut was invisible. So when compact the title
              drops its explanatory half (the S1/S2/S3 column headers below say
              the same thing) and the three per-sector bests go with it: each
              sector's best is already the benchmark every row's delta is
              measured against, so it is stated three times over. The
              theoretical best LAP is the one number that appears nowhere else. */}
          <button onClick={() => setStripOpen((o) => !o)} title={stripOpen ? "Collapse" : "Expand"}
            style={{ width: "100%", display: "flex", alignItems: "center", gap: compact ? 10 : 14,
              padding: compact ? "11px 12px" : "11px 16px",
              background: "transparent", border: "none", cursor: "pointer", fontFamily: FONT.ui, textAlign: "left" }}>
            {/* 0.5 rather than the desktop 2: at 1 the tracking alone added 15px
                across "LAP CONSISTENCY" and tipped it 1px past its share, so the
                title ellipsised to "LAP CONSISTEN…". Tightening the letters is
                cheaper than dropping a word. */}
            <span style={{ fontSize: 10, letterSpacing: compact ? 0.5 : 2, color: C.textMuted, textTransform: "uppercase", fontWeight: 600,
              minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {compact ? "Lap Consistency" : "Lap Consistency · Sector Times vs Best"}</span>
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "baseline", gap: 7, flex: "none" }}>
              <span style={{ fontSize: 9, letterSpacing: 1.5, color: C.textDim, textTransform: "uppercase", whiteSpace: "nowrap" }}>Theoretical Best</span>
              <span style={{ fontFamily: FONT.mono, fontSize: compact ? 15 : 17, fontWeight: 800, color: C.purple, lineHeight: 1 }}>
                {matrix.best.every((s) => typeof s === "number" && s > 0)
                  ? formatLapTime(matrix.best.reduce((a, b) => a + b, 0), 3) : "—"}
              </span>
              {!compact && [0, 1, 2].map((i) => (
                <span key={i} style={{ display: "flex", alignItems: "baseline", gap: 4, marginLeft: i === 0 ? 6 : 0 }}>
                  <span style={{ fontSize: 9, letterSpacing: 1, color: C.textDim, textTransform: "uppercase" }}>S{i + 1}</span>
                  <span style={{ fontFamily: FONT.mono, fontSize: 13, fontWeight: 700, color: C.textBody2 }}>{fmtSec(matrix.best[i])}</span>
                </span>
              ))}
            </span>
            <span style={{ color: C.textDim, fontSize: 11, flex: "none" }}>{stripOpen ? "▾" : "▸"}</span>
          </button>
          {stripOpen && (
            <div style={{ padding: "0 16px 14px" }}>
              {/* The header lives INSIDE the scrolling box with the rows, stuck
                  to its top, rather than sitting above it. Outside it, the two
                  were in different boxes: a classic desktop scrollbar takes
                  layout width from the rows and none from the header, which put
                  the columns 10px out of step — invisible on Android, where
                  WebView scrollbars are overlays, and so exactly the kind of
                  thing that ships. Sticky puts both grids in one box at one
                  width, so there is nothing left to keep in sync by hand. */}
              <div style={{ maxHeight: 230, overflowY: "auto", display: "flex", flexDirection: "column", gap: 7 }}>
                {/* 11px, not the rows' 10px: a row also carries a 1px border, so
                    matching the padding alone leaves the header 2px wider in
                    content and every shared `fr` track lands ~0.5px off. */}
                <div style={{ display: "grid", gridTemplateColumns: matrixCols(compact), gap: compact ? 6 : 8,
                  // Opaque and above the rows: they scroll underneath it now.
                  padding: "0 11px 8px", position: "sticky", top: 0, zIndex: 1, background: C.surface }}>
                  {["Lap", "S1", "S2", "S3", "Lap Time", ""].map((h, i) => (
                    <div key={i} style={{ fontSize: 9, letterSpacing: 1, color: C.textDim, textTransform: "uppercase",
                      // Clipped rather than allowed to widen its track: a header
                      // that outgrows its column is how the two grids drifted
                      // apart in the first place.
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      textAlign: i === 0 ? "left" : i === 4 ? "right" : "center" }}>{h}</div>
                  ))}
                </div>
                {matrix.rows.length === 0 && (
                  <div style={{ margin: "auto", textAlign: "center", color: C.textFaint, fontSize: 12, lineHeight: 1.6, padding: 20 }}>
                    No laps with sector splits yet. Drive laps with sector timing to build the matrix.
                  </div>
                )}
                {matrix.rows.map(({ lap, cells }) => {
                  const cur = lap.id === comparisonId;
                  const invalid = !!lap.invalid;
                  return (
                    <div key={lap.id} style={{ display: "grid", gridTemplateColumns: matrixCols(compact), gap: compact ? 6 : 8, alignItems: "center",
                      background: cur ? C.elevated : C.inset, border: `1px solid ${cur ? C.blue : invalid ? C.red : C.line}`, borderRadius: 8, padding: "9px 10px" }}>
                      <div style={{ fontFamily: FONT.mono, fontSize: compact ? 13 : 15, fontWeight: 700, color: invalid ? C.textDim : cur ? "#fff" : C.textMuted }}>{lap.lapNumber ?? "?"}</div>
                      {cells.map((c, i) => (
                        // Side by side on desktop; on a compact the delta drops
                        // UNDER its sector time. Both readings still fit a ~50px
                        // column that way, where the side-by-side pair needs ~88
                        // and would simply be cut off at the cell edge now that
                        // the track can no longer grow to hold it.
                        <div key={i} style={{ display: "flex", justifyContent: "center", minWidth: 0,
                          ...(compact
                            ? { flexDirection: "column", alignItems: "center", gap: 0, lineHeight: 1.15 }
                            : { alignItems: "baseline", gap: 4 }) }}>
                          <span style={{ fontFamily: FONT.mono, fontSize: compact ? 12.5 : 14, fontWeight: 700, color: c.color }}>{c.time}</span>
                          {c.delta && (
                            <span style={{ fontFamily: FONT.mono, fontSize: compact ? 9 : 10, fontWeight: 600, color: C.red }}>{c.delta}</span>
                          )}
                        </div>
                      ))}
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, minWidth: 0 }}>
                        <span style={{ fontFamily: FONT.mono, fontSize: compact ? 13 : 15, fontWeight: 700, textAlign: "right", color: invalid ? C.textDim : C.textBody2, textDecoration: invalid ? "line-through" : "none" }}>{formatLapTime(lap.lapTime, 3)}</span>
                        {invalid && (
                          <Hint text="Lap time deleted by the game (track limits / corner cut)" style={{ fontSize: 7.5, fontWeight: 800, letterSpacing: 0.4, color: C.red, textTransform: "uppercase", border: `1px solid ${C.red}`, borderRadius: 4, padding: "0 4px", whiteSpace: "nowrap" }}>Invalidated</Hint>
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
        <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column",
          ...(phone && { flex: "none", height: 460 }) }}>
          {tracesSlot}
        </div>
      </div>

      {pendingSave && (
        <ModalShell title="Hide your setup?" onClose={() => setPendingSave(null)}
          footer={<>
            <button onClick={() => finishSave(false)} style={modalBtn("secondary")}>No, keep setup</button>
            <button onClick={() => finishSave(true)} style={modalBtn("primary")}>Yes, hide it</button>
          </>}>
          <div style={{ padding: "20px 24px", fontSize: 13, lineHeight: 1.65, color: C.textMid }}>
            Do you want to hide your car setup in this saved lap? Choose <b style={{ color: C.textHi }}>Yes</b> to
            share the telemetry without disclosing your garage loadout.
          </div>
        </ModalShell>
      )}

      {pendingDelete && (
        <DeleteLapConfirm lap={pendingDelete} onCancel={() => setPendingDelete(null)}
          onConfirm={(lap) => { setPendingDelete(null); onDeleteLap?.(lap.id); }} />
      )}
    </div>
  );
}

const caret = { position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: C.textFaint, fontSize: 11 };
const caretPhone = { ...caret, right: 9, fontSize: 9 };
