// ─── SETUP DISPLAY ──────────────────────────────────────────────────────────
// Turn the raw CarSetups packet fields (m_frontWing, m_brakeBias, …) the telemetry core
// forwards into grouped, game-style rows for the Setup popup. Mirrors the layout
// of the in-game garage screen so the numbers read the way the driver set them.
// Null-safe: returns [] when a lap carries no setup (older exports / not yet
// received from the game), so callers can simply hide the popup/button.

// Round only when the value actually has a fractional part, so integer settings
// (wings, springs) show clean and float channels (camber, pressures) keep 1 dp.
const num = (v, dp = 1) => {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(dp);
};
const pct = v => (typeof v === "number" && isFinite(v) ? `${Math.round(v)}%` : "—");
// Camber/toe and tyre pressures are inherently fractional — always show decimals
// so a round value (e.g. -3.0) reads as "-3.00°", consistent with its neighbours.
const deg = v => (typeof v === "number" && isFinite(v) ? `${v.toFixed(2)}°` : "—");
const psi = v => (typeof v === "number" && isFinite(v) ? `${v.toFixed(1)} psi` : "—");

export function formatSetup(setup) {
  if (!setup || typeof setup !== "object") return [];

  const sections = [
    {
      title: "Aerodynamics",
      rows: [
        { label: "Front Wing", value: num(setup.m_frontWing) },
        { label: "Rear Wing", value: num(setup.m_rearWing) },
      ],
    },
    {
      title: "Differential",
      rows: [
        { label: "On Throttle", value: pct(setup.m_onThrottle) },
        { label: "Off Throttle", value: pct(setup.m_offThrottle) },
      ],
    },
    {
      title: "Suspension Geometry",
      rows: [
        { label: "Front Camber", value: deg(setup.m_frontCamber) },
        { label: "Rear Camber", value: deg(setup.m_rearCamber) },
        { label: "Front Toe", value: deg(setup.m_frontToe) },
        { label: "Rear Toe", value: deg(setup.m_rearToe) },
      ],
    },
    {
      title: "Suspension",
      rows: [
        { label: "Front Springs", value: num(setup.m_frontSuspension) },
        { label: "Rear Springs", value: num(setup.m_rearSuspension) },
        { label: "Front Anti-Roll Bar", value: num(setup.m_frontAntiRollBar) },
        { label: "Rear Anti-Roll Bar", value: num(setup.m_rearAntiRollBar) },
        { label: "Front Ride Height", value: num(setup.m_frontSuspensionHeight) },
        { label: "Rear Ride Height", value: num(setup.m_rearSuspensionHeight) },
      ],
    },
    {
      title: "Brakes",
      rows: [
        { label: "Brake Pressure", value: pct(setup.m_brakePressure) },
        { label: "Front Brake Bias", value: pct(setup.m_brakeBias) },
        // Engine braking is not a garage option in F1 26, so it's deliberately
        // not shown — the packet may still carry the byte, but it's meaningless.
      ],
    },
    {
      title: "Tyres",
      rows: [
        { label: "Front Left Pressure", value: psi(setup.m_frontLeftTyrePressure) },
        { label: "Front Right Pressure", value: psi(setup.m_frontRightTyrePressure) },
        { label: "Rear Left Pressure", value: psi(setup.m_rearLeftTyrePressure) },
        { label: "Rear Right Pressure", value: psi(setup.m_rearRightTyrePressure) },
      ],
    },
    {
      // Ballast was dropped in F1 26 (it's no longer a setup option), so the only
      // remaining "misc" channel is the required fuel load — given its own section.
      title: "Fuel",
      rows: [
        { label: "Fuel Load", value: typeof setup.m_fuelLoad === "number" && isFinite(setup.m_fuelLoad) ? `${setup.m_fuelLoad.toFixed(1)} kg` : "—" },
      ],
    },
  ];

  return sections;
}
