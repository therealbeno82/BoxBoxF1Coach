// ─── FUEL ─────────────────────────────────────────────────────────────────────
// A lap's fuel story as the lap recorder stamps it (BoxBoxApp): what the lap
// burned — the tank level (Car Status packet) diffed across the lap — and the
// delta the game's own MFD was showing at the flag. That delta is laps of fuel in
// hand AGAINST WHAT IS LEFT TO RUN, so 0 is exactly enough and a negative number
// means the car has to start saving. It comes straight from the packet, so no lap
// count or race length has to be inferred here.

// { used, delta } for a lap, or null when it carries no fuel data at all (laps
// recorded before fuel was collected, or a game that never sent it). Either half
// can be null on its own — a lap can know its delta without a clean burn figure.
export function lapFuel(lap) {
  const f = lap?.fuel;
  if (!f) return null;
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  const used = num(f.used);
  const delta = num(f.delta);
  if (used == null && delta == null) return null;
  return { used, delta };
}

// Signed laps-in-hand, as the pit wall says it: "+0.4" / "−1.2". The sign comes off
// the ROUNDED value, so a delta of −0.04 prints as a flat "0.0" rather than "−0.0".
export function fuelDeltaLabel(delta) {
  const v = Math.round(delta * 10) / 10;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`;
}
