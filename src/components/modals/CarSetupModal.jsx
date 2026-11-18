// ─── CAR SETUP MODAL ────────────────────────────────────────────────────────
// The garage loadout captured with a personal-best / session lap. Opened from a
// wrench button on the Dashboard PBs, the Live session-laps list, and the
// Analytics consistency matrix. Fed the lap's raw CarSetups snapshot, grouped for
// display by the shared formatSetup() helper. The per-row bar is a decorative
// scale reflecting where the real value sits in its plausible range.

import { C, FONT } from "../../lib/ui/tokens.js";
import ModalShell, { modalBtn } from "../ModalShell.jsx";
import { formatSetup } from "../../lib/setupDisplay.js";

// Per-channel min/max for the in-game F1 setup sliders, keyed by the exact labels
// formatSetup() emits. Each channel has its own range, so the bar can only read as
// "in sync" with the slider if we scale against that channel's own min/max — a single
// per-unit range (all psi together, abs() camber, etc.) is what threw the bars off.
const RANGES = {
  "Front Wing": [0, 50],
  "Rear Wing": [0, 50],
  "On Throttle": [10, 100],            // differential: 10% unlocked → 100% locked
  "Off Throttle": [10, 100],
  "Front Camber": [-3.5, -2.5],        // negative; more negative = emptier bar
  "Rear Camber": [-2.0, -1.0],
  "Front Toe": [0.0, 0.2],
  "Rear Toe": [0.1, 0.25],
  "Front Springs": [1, 41],            // suspension stiffness 1 soft → 41 firm
  "Rear Springs": [1, 41],
  "Front Anti-Roll Bar": [1, 21],      // 1 soft → 21 firm
  "Rear Anti-Roll Bar": [1, 21],
  "Front Ride Height": [15, 35],
  "Rear Ride Height": [40, 60],
  "Brake Pressure": [80, 100],
  "Front Brake Bias": [70, 50],        // game slider runs 70% → 50%, so bar fills in reverse
  "Front Left Pressure": [22.5, 29.5], // front tyres run higher than rears
  "Front Right Pressure": [22.5, 29.5],
  "Rear Left Pressure": [20.5, 26.5],
  "Rear Right Pressure": [20.5, 26.5],
  "Fuel Load": [5, 110],               // min fuel → full race tank
};

// Map a formatted value ("57%", "23.5 psi", "-3.00°", "8", "10.0 kg") to a 3–100%
// bar width by placing it within that channel's real min/max. Honest scale, not data.
function barPct(label, value) {
  const n = parseFloat(String(value).replace(/[^-\d.]/g, ""));
  if (!isFinite(n)) return null;
  const range = RANGES[label];
  if (!range) return null;
  const [min, max] = range;
  const frac = (n - min) / (max - min);
  return Math.round(Math.max(3, Math.min(100, frac * 100)));
}

export default function CarSetupModal({ pb, onClose }) {
  // Escape, Android back and the backdrop all close it — ModalShell owns that.
  if (!pb) return null;
  const color = C.accent; // title bar + slider fills follow the active skin accent
  const sections = formatSetup(pb.setup);

  return (
    <ModalShell title={`Car Setup · ${pb.track || "—"}`} subtitle={`Setup used${pb.date ? ` · ${pb.date}` : ""}`}
      accent={color} barHeight={38} showClose onClose={onClose} width={760} maxHeight="88%" zIndex={140}
      aside={pb.time && (
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 8, letterSpacing: 1.5, color: C.textDim, textTransform: "uppercase" }}>Lap Time</div>
          <div style={{ fontFamily: FONT.mono, fontSize: 20, fontWeight: 800, color: C.yellow, marginTop: 2 }}>{pb.time}</div>
        </div>
      )}
      footerStyle={{ justifyContent: "space-between", gap: 14 }}
      footer={<>
        <span style={{ fontSize: 12, color: C.textDim, fontFamily: FONT.mono }}>Loadout snapshot saved with this lap</span>
        <button onClick={onClose} style={modalBtn("primary")}>Close</button>
      </>}>
      {/* Body */}
      {sections.length === 0 ? (
        <div style={{ padding: "40px 24px", textAlign: "center", color: C.textDim, fontSize: 13, lineHeight: 1.6 }}>
          No setup was captured with this lap.<br />
          Laps recorded with the game's UDP car-setup output carry their garage loadout here.
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 24px",
          display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          {sections.map((sec) => (
            <div key={sec.title} style={{ background: C.inset, border: `1px solid ${C.line}`, borderRadius: 12, padding: "14px 16px" }}>
              <div style={{ fontSize: 10, letterSpacing: 2, color: C.textMuted, textTransform: "uppercase", fontWeight: 600, marginBottom: 13 }}>{sec.title}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {sec.rows.map((row) => {
                  const w = barPct(row.label, row.value);
                  return (
                    <div key={row.label}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                        <span style={{ fontSize: 12, color: C.textMid }}>{row.label}</span>
                        <span style={{ fontFamily: FONT.mono, fontSize: 13, fontWeight: 800, color: C.textHi }}>{row.value}</span>
                      </div>
                      <div style={{ height: 4, borderRadius: 3, background: C.line, overflow: "hidden" }}>
                        <div style={{ height: "100%", borderRadius: 3, width: `${w ?? 0}%`, background: color }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </ModalShell>
  );
}
