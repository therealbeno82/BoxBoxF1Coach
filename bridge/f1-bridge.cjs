/**
 * F1 25/26 UDP → WebSocket bridge
 * ────────────────────────────────────────────────────────────────────────────
 * The F1 game broadcasts telemetry as binary UDP packets, which a browser can't
 * read. This little Node process listens for those packets, parses them with a
 * spec-accurate library, pulls out the player car's data, and re-broadcasts a
 * compact JSON snapshot over a WebSocket the app already knows how to consume
 * (ws://localhost:9001 — see the Setup tab → "UDP Bridge").
 *
 * Run it:   npm run bridge          (real telemetry from the game)
 *           npm run bridge:fake     (synthetic data, to test the link with no game)
 *
 * ── Enable telemetry in F1 25/26 ────────────────────────────────────────────
 *   Game Options → Settings → Telemetry Settings
 *     UDP Telemetry .......... On
 *     UDP Broadcast Mode ..... Off  (On only if the game is on a different PC)
 *     UDP IP Address ......... 127.0.0.1   (this PC) — or this PC's LAN IP
 *     UDP Port ............... 20777
 *     UDP Send Rate .......... 30 (or 60)
 *     UDP Format ............. 2025
 */

const { F1TelemetryClient, constants } = require("@deltazeroproduction/f1-udp-parser");
const { WebSocketServer } = require("ws");

const { PACKETS } = constants;

const UDP_PORT = Number(process.env.F1_UDP_PORT) || 20777;
const WS_PORT = Number(process.env.F1_WS_PORT) || 9001;
const BROADCAST_HZ = 30;
const MAX_ERS_JOULES = 4_000_000; // 4 MJ deployable per lap → battery %
const FAKE = process.argv.includes("--fake");

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ts = () => new Date().toLocaleTimeString();
const log = (...a) => console.log(`[${ts()}]`, ...a);

// ── Latest combined player-car state (filled in from several packet types) ──
let trackLength = 0;
let trackId = -1;
// Game-authoritative sector boundaries (metres into the lap where S2 / S3 begin),
// from the Session packet. Forwarded as lap fractions so the app can align the live
// mini-sectors to the real sectors instead of guessing equal thirds. 0 until known.
let sector2Start = 0;
let sector3Start = 0;
// F1 25/26 (Format 2025) session type: 0 unknown · 1-4 practice · 5-9 qualifying ·
// 10-14 sprint shootout · 15-17 race · 18 time trial. Forwarded raw; the app maps
// it to a coarse label (see sessionTypeName in src/lib/format.js).
let sessionType = 0;
let gotPacket = false;
let loggedSetup = false; // gate the one-shot raw-setup diagnostic (see carSetups handler)
// The UDP listener can be re-pointed at a different port at runtime (some users run
// a tool that receives the game's stream first and rebroadcasts it on another port).
// The app pushes the configured port over the WebSocket; setUdpPort() rebinds live.
let currentUdpPort = UDP_PORT;
let udpClient = null;
// Repeater: re-send every raw game datagram, byte-for-byte, to a second app that
// also wants the stream. Two apps can't bind the game's port at once, so the
// bridge is the sole receiver on 20777 and forwards a copy here. Off by default;
// the app toggles it (and sets host/port) live over the WebSocket (setRepeater).
// Env vars seed it for the standalone `npm run bridge` case.
let repeater = {
  enabled: process.env.F1_REPEAT_ENABLED === "1",
  host: process.env.F1_REPEAT_HOST || "127.0.0.1",
  port: Number(process.env.F1_REPEAT_PORT) || 20778,
};
// The forward-address list the parser library understands. Explicit ip is required:
// the lib defaults a missing ip to 0.0.0.0, which won't reach a localhost listener.
const fwdList = () =>
  repeater.enabled && repeater.port ? [{ ip: repeater.host, port: repeater.port }] : undefined;
const latest = {
  speed: 0, throttle: 0, brake: 0, steer: 0, gear: 0, rpm: 0,
  ersMode: 0, ersBattery: 50, ersDeploy: 0,
  lapDistance: 0, lapTime: 0,
  lapNumber: 0, lastLapTime: 0, // game-authoritative lap number + last completed lap time (s)
  tyreVisual: -1, tyreActual: -1, tyreAge: 0, // current tyre compound (CarStatus) → tagged onto recorded laps
  driverStatus: 4, pitStatus: 0, lapInvalid: 0, // lap-validity signals (see lapData handler)
  sector1Time: 0, sector2Time: 0, currentSector: 0, // game-native sector splits (current lap)
  worldX: null, worldY: null, worldZ: null, // world position (Motion packet) → live track map / 3D view
  setup: null, // player car setup (CarSetups packet) → tied to the lap when recorded
};

// The LapData sector splits come either as a flat InMS field (older formats) or
// split into minutes + ms parts (F1 24/25). Fold whichever the packet carries
// into seconds; returns 0 until the game has actually set the split.
function sectorSeconds(c, n) {
  const ms = c[`m_sector${n}TimeMSPart`] ?? c[`m_sector${n}TimeInMS`] ?? 0;
  const min = c[`m_sector${n}TimeMinutesPart`] ?? c[`m_sector${n}TimeMinutes`] ?? 0;
  return (min * 60000 + ms) / 1000;
}

// Pull the player's entry out of a per-car array using the packet's own header.
function playerOf(packet, arrayKey) {
  const idx = packet?.m_header?.m_playerCarIndex ?? 0;
  const arr = packet?.[arrayKey];
  return Array.isArray(arr) ? arr[idx] : undefined;
}

// ── WebSocket server: the app connects here ─────────────────────────────────
const wss = new WebSocketServer({ port: WS_PORT });
wss.on("listening", () =>
  log(`WebSocket up on ws://localhost:${WS_PORT}  — connect from the app's Setup tab`)
);
wss.on("connection", (ws) => {
  log(`✓ app connected (${wss.clients.size} client(s))`);
  // Let the app know which UDP port we're currently listening on, so its Settings
  // panel can reflect the real state (and whether we're in fake mode).
  try { ws.send(JSON.stringify({ type: "status", udpPort: currentUdpPort, fake: FAKE, repeater: { ...repeater } })); } catch {}
  // Control channel: the app sends a request to re-point the UDP listener
  // (custom-port / rebroadcaster setups) or to (re)configure the repeater that
  // forwards the raw stream to a second app. Ignore anything malformed.
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg) return;
    if (msg.type === "setUdpPort") setUdpPort(Number(msg.port));
    else if (msg.type === "setRepeater") setRepeater(msg);
  });
});
wss.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    // Almost always a stale bridge from a previous (force-killed) app session
    // still holding the port. Exit loudly rather than hang silently.
    log(`✗ port ${WS_PORT} is already in use — another bridge is still running. Exiting.`);
    process.exit(1);
  }
  log("WebSocket error:", e.message);
});

// ── Lifecycle: shut down cleanly when the parent app goes away ───────────────
// When launched as the Tauri sidecar the app kills us on a graceful exit. But on
// a crash/force-kill that kill never runs, which would orphan this process and
// leave :9001 occupied. The parent holds the write end of our stdin, so when it
// dies stdin hits EOF — use that as a reliable "parent gone" signal on Windows.
let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  try { wss.close(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Watch the parent app via stdin, but only when it's a pipe the parent holds
// open (the Tauri sidecar case) — not an interactive terminal (`npm run bridge`,
// where stdin is a TTY). When the parent process dies its end of the pipe closes
// and we get EOF; that's our "parent gone" signal so we don't orphan on a crash.
// Some launchers hand the child an already-dead stdin, which yields EOF instantly
// — distinguish that benign case from a real parent exit by *when* the EOF lands:
// only a close well after startup means the parent actually went away.
if (!process.stdin.isTTY) {
  const startedAt = Date.now();
  const onEof = () => {
    if (Date.now() - startedAt < 2000) return; // dead-at-launch stdin → ignore
    shutdown("parent exited");
  };
  process.stdin.on("end", onEof);
  process.stdin.on("close", onEof);
  process.stdin.resume();
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
}

// ── Map current state → the JSON shape the app's telemetry consumer expects ─
// (currentZone is derived app-side from lapPct, so it isn't sent here.)
function snapshot() {
  const lapPct = trackLength > 0 ? clamp(latest.lapDistance / trackLength, 0, 1) : 0;
  return {
    trackId,
    sessionType,
    lapPct,
    lapDistance: latest.lapDistance,
    throttle: latest.throttle,
    brake: latest.brake,
    steer: latest.steer,
    speed: latest.speed,
    gear: latest.gear,
    rpm: Math.round(latest.rpm),
    ersMode: latest.ersMode,
    ersDeploy: latest.ersDeploy,
    ersBattery: Math.round(latest.ersBattery),
    lapTime: latest.lapTime,
    lapNumber: latest.lapNumber,
    lastLapTime: latest.lastLapTime,
    tyreVisual: latest.tyreVisual,
    tyreActual: latest.tyreActual,
    tyreAge: latest.tyreAge,
    driverStatus: latest.driverStatus,
    pitStatus: latest.pitStatus,
    lapInvalid: latest.lapInvalid,
    sector1Time: latest.sector1Time,
    sector2Time: latest.sector2Time,
    currentSector: latest.currentSector,
    // Real sector boundaries as lap fractions (fall back to equal thirds until the
    // Session packet supplies them) → the app's live mini-sector alignment.
    sector2Pct: trackLength > 0 && sector2Start > 0 ? clamp(sector2Start / trackLength, 0, 1) : 1 / 3,
    sector3Pct: trackLength > 0 && sector3Start > 0 ? clamp(sector3Start / trackLength, 0, 1) : 2 / 3,
    worldX: latest.worldX,
    worldY: latest.worldY,
    worldZ: latest.worldZ,
    setup: latest.setup, // null until the game sends a CarSetups packet
  };
}

// Push to the app at a steady rate — but only once we actually have data, so
// the app keeps using its own simulator until real telemetry starts flowing.
setInterval(() => {
  if (!gotPacket) return;
  broadcast(snapshot());
}, 1000 / BROADCAST_HZ);

// ── Real telemetry from the game ────────────────────────────────────────────
// Wire every packet handler onto a client. Pulled out of the start path so a
// rebind (setUdpPort) can attach the same handlers to a freshly-bound client.
function attachTelemetryHandlers(client) {
  client.on(PACKETS.session, (d) => {
    if (d?.m_trackLength) trackLength = d.m_trackLength;
    if (typeof d?.m_trackId === "number") trackId = d.m_trackId;
    if (typeof d?.m_sessionType === "number") sessionType = d.m_sessionType;
    // Real sector-start distances (F1 25/26) → drive the app's mini-sector alignment.
    if (typeof d?.m_sector2LapDistanceStart === "number") sector2Start = d.m_sector2LapDistanceStart;
    if (typeof d?.m_sector3LapDistanceStart === "number") sector3Start = d.m_sector3LapDistanceStart;
  });

  client.on(PACKETS.motion, (d) => {
    const c = playerOf(d, "m_carMotionData");
    if (!c) return;
    latest.worldX = c.m_worldPositionX; // metres, world ground plane
    latest.worldY = c.m_worldPositionY; // metres, elevation → 3D view undulation
    latest.worldZ = c.m_worldPositionZ;
    markPacket();
  });

  client.on(PACKETS.carTelemetry, (d) => {
    const c = playerOf(d, "m_carTelemetryData");
    if (!c) return;
    latest.speed = c.m_speed;                              // km/h (uint16)
    latest.throttle = Math.round(clamp(c.m_throttle, 0, 1) * 100); // 0..1 → %
    latest.brake = Math.round(clamp(c.m_brake, 0, 1) * 100);       // 0..1 → %
    latest.steer = Math.round(clamp(c.m_steer, -1, 1) * 100);      // -1..1 → -100..100 %
    latest.gear = c.m_gear;                                // -1..8
    latest.rpm = c.m_engineRPM;
    markPacket();
  });

  client.on(PACKETS.carStatus, (d) => {
    const c = playerOf(d, "m_carStatusData");
    if (!c) return;
    latest.ersMode = c.m_ersDeployMode;                          // 0..3
    latest.ersBattery = clamp((c.m_ersStoreEnergy / MAX_ERS_JOULES) * 100, 0, 100);
    latest.ersDeploy = Math.round((c.m_ersDeployedThisLap || 0) / 1000); // J → kJ
    // Tyre compound the player is currently running — visual is the driver-facing
    // name (Soft/Medium/Hard/Inter/Wet), actual is the underlying spec (C0–C6).
    // The app tags each recorded lap with this so a wet/inter lap is filed apart
    // from dry laps (see useLapRecorder + lib/tyres.js).
    if (typeof c.m_visualTyreCompound === "number") latest.tyreVisual = c.m_visualTyreCompound;
    if (typeof c.m_actualTyreCompound === "number") latest.tyreActual = c.m_actualTyreCompound;
    if (typeof c.m_tyresAgeLaps === "number") latest.tyreAge = c.m_tyresAgeLaps;
    markPacket();
  });

  client.on(PACKETS.lapData, (d) => {
    const c = playerOf(d, "m_lapData");
    if (!c) return;
    latest.lapDistance = Math.max(0, Math.round(c.m_lapDistance)); // m (neg before line)
    latest.lapTime = (c.m_currentLapTimeInMS || 0) / 1000;         // ms → s
    latest.lastLapTime = (c.m_lastLapTimeInMS || 0) / 1000;        // ms → s; official time of the lap just completed
    latest.lapNumber = c.m_currentLapNum ?? 0;                     // increments on every start/finish crossing
    // Lap-validity signals so the app's recorder can reject out-laps / in-laps /
    // pit excursions / game-flagged-invalid laps instead of timing them as real laps.
    latest.driverStatus = c.m_driverStatus ?? 4;                   // 0 garage · 1 flying · 2 in-lap · 3 out-lap · 4 on track
    latest.pitStatus = c.m_pitStatus ?? 0;                         // 0 none · 1 pitting · 2 in pit area
    latest.lapInvalid = c.m_currentLapInvalid ?? 0;                // 1 once the current lap has been invalidated
    latest.sector1Time = sectorSeconds(c, 1);                      // 0 until S1 complete
    latest.sector2Time = sectorSeconds(c, 2);                      // 0 until S2 complete
    latest.currentSector = c.m_sector ?? 0;                        // 0|1|2 live sector
    markPacket();
  });

  client.on(PACKETS.carSetups, (d) => {
    const c = playerOf(d, "m_carSetups");
    if (!c) return;
    latest.setup = c; // raw setup fields for the player car — held until lap is recorded
    // One-shot diagnostic: the bundled parser only understands UDP formats up to
    // 2025. If the game emits 2026, the CarSetups layout drifts (the engine-braking
    // byte is dropped) and the tyre-pressure / ballast / fuel fields decode as
    // garbage. Log the format + raw player setup once so we can confirm what the
    // game is actually sending and map any off values channel-by-channel.
    if (!loggedSetup) {
      loggedSetup = true;
      const fmt = d?.m_header?.m_packetFormat;
      log(`CarSetups received — UDP format ${fmt}. Raw player setup:`);
      console.log(JSON.stringify(c, null, 2));
      if (fmt !== 2024 && fmt !== 2025) {
        log(`⚠ UDP format ${fmt} is newer than the bundled parser supports (≤2025) — setup tyre pressures / fuel may be misaligned.`);
      }
    }
    markPacket();
  });
}

// Make a bad packet non-fatal. The parser library reads the packet header with an
// unguarded DataView, so a stray/too-short datagram on the game port throws
// `RangeError: Offset is outside the bounds of the DataView` — and because it throws
// inside the library's own socket 'message' handler (not our client.on(...) packet
// callbacks), a try/catch around our handlers can't catch it; uncaught, it kills the
// process. Real game telemetry never hits this, but as the sole front-line receiver
// on 20777 (now also forwarding to a second app) we must survive junk from anything
// else on the port. The socket handler calls `this.handleMessage(m)`, so overriding
// the instance method with a try/catch wrapper intercepts exactly that throw — and
// since forwarding (bridgeMessage) runs first inside handleMessage, the malformed
// packet is still repeated; only its failed parse is swallowed. Logging is throttled
// so a flood of bad packets can't spam the console.
let lastBadPacketLog = 0;
function guardHandleMessage(client) {
  const orig = client.handleMessage.bind(client);
  client.handleMessage = (message) => {
    try {
      orig(message);
    } catch (e) {
      const now = Date.now();
      if (now - lastBadPacketLog > 5000) {
        lastBadPacketLog = now;
        log(`⚠ dropped an unparseable UDP packet (${message?.length ?? "?"} bytes): ${e.message}`);
      }
    }
  };
}

// (Re)bind the UDP listener to `port`. Tears down any existing client first so we
// never hold two sockets. Safe to call repeatedly — it's how a port change lands.
function startUdp(port) {
  if (udpClient) { try { udpClient.stop(); } catch {} udpClient = null; }
  currentUdpPort = port;
  const client = new F1TelemetryClient({ port, forwardAddresses: fwdList() });
  attachTelemetryHandlers(client);
  guardHandleMessage(client);
  client.start();
  udpClient = client;
  log(`Listening for F1 25/26 telemetry on UDP ${port} …`);
  log(`(In-game: Settings → Telemetry → UDP On, Port ${port}, Format 2025)`);
}

// Handle the app's "use a different UDP port" request. Validates, no-ops on an
// unchanged port, and rebinds otherwise. In fake mode there's no UDP socket to
// move, so it's a logged no-op. Resetting gotPacket re-arms the "no packets yet"
// nudge (and lets the app fall back to its simulator) until data flows on the new port.
function setUdpPort(port) {
  if (FAKE) { log(`(fake mode) ignoring UDP port change to ${port}`); return; }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    log(`✗ ignoring invalid UDP port ${port}`);
    return;
  }
  if (port === currentUdpPort) return;
  log(`↻ switching UDP listen port ${currentUdpPort} → ${port}`);
  gotPacket = false;
  startUdp(port);
}

// Handle the app's "forward the raw stream to a second app" request. Updates the
// repeater config (enabled / host / port) and applies it live by re-assigning the
// forward list onto the running client — the parser library re-reads
// this.forwardAddresses on every packet, so there's no need to rebind the 20777
// socket. In fake mode there's no real UDP socket to forward from, so it's a
// logged no-op (mirrors setUdpPort).
function setRepeater(cfg) {
  const enabled = !!cfg.enabled;
  const host = typeof cfg.host === "string" && cfg.host.trim() ? cfg.host.trim() : repeater.host;
  const port = Number(cfg.port);
  if (enabled && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    log(`✗ ignoring invalid repeater port ${cfg.port}`);
    return;
  }
  repeater = { enabled, host, port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : repeater.port };
  if (FAKE) { log(`(fake mode) repeater config noted (${enabled ? `→ ${host}:${repeater.port}` : "off"}) — nothing to forward`); return; }
  if (udpClient) udpClient.forwardAddresses = fwdList();
  log(enabled ? `⇉ repeating raw telemetry → ${host}:${repeater.port}` : "⇉ repeater off");
}

if (!FAKE) {
  startUdp(UDP_PORT);

  // Nudge the user if the socket is up but the game isn't actually sending.
  const noDataWarner = setInterval(() => {
    if (gotPacket) return clearInterval(noDataWarner);
    log("… no packets yet — is the game running with UDP telemetry enabled?");
  }, 8000);

  process.on("SIGINT", () => {
    log("shutting down");
    try { udpClient && udpClient.stop(); } catch {}
    wss.close();
    process.exit(0);
  });
}

// ── Fake mode: synthetic lap so you can test the app↔bridge link with no game ─
if (FAKE) {
  trackLength = 5278;
  trackId = 0; // Melbourne — fake mode always broadcasts as Melbourne
  const t0 = Date.now();
  // A plausible static garage setup so the Setup popup is testable with no game.
  latest.setup = {
    m_frontWing: 6, m_rearWing: 8,
    m_onThrottle: 65, m_offThrottle: 55,
    m_frontCamber: -3.0, m_rearCamber: -1.7, m_frontToe: 0.07, m_rearToe: 0.34,
    m_frontSuspension: 5, m_rearSuspension: 6,
    m_frontAntiRollBar: 7, m_rearAntiRollBar: 4,
    m_frontSuspensionHeight: 3, m_rearSuspensionHeight: 6,
    m_brakePressure: 95, m_brakeBias: 54,
    m_frontLeftTyrePressure: 23.5, m_frontRightTyrePressure: 23.5,
    m_rearLeftTyrePressure: 21.5, m_rearRightTyrePressure: 21.5,
    m_fuelLoad: 10.0, // ballast + engine braking dropped in F1 26 — omitted here too
  };
  log("FAKE mode — generating synthetic telemetry (no game needed)");
  setInterval(() => {
    const elapsed = (Date.now() - t0) / 1000;
    const LAP = 90;
    const pct = (elapsed % LAP) / LAP;
    // Alternate session type each lap (Time Trial ↔ Q3) so the dashboard's
    // per-session-type fastest-lap split has data to show with no game running.
    sessionType = Math.floor(elapsed / LAP) % 2 === 0 ? 18 : 7;
    const braking = Math.sin(pct * Math.PI * 8) < -0.5;
    latest.lapDistance = Math.round(pct * trackLength);
    latest.speed = Math.round(braking ? 90 + Math.random() * 40 : 200 + Math.random() * 120);
    latest.throttle = braking ? Math.round(Math.random() * 15) : 80 + Math.round(Math.random() * 20);
    latest.brake = braking ? 40 + Math.round(Math.random() * 50) : 0;
    latest.steer = Math.round(clamp(Math.sin(pct * Math.PI * 12) * 85, -100, 100)); // synthetic cornering
    latest.gear = clamp(Math.round(latest.speed / 42), 1, 8);
    latest.rpm = 9000 + Math.random() * 3000;
    latest.ersMode = braking ? 1 : 3;
    latest.ersBattery = 40 + Math.random() * 30;
    latest.ersDeploy = Math.round(pct * 4000);
    latest.lapTime = elapsed % LAP;
    // Synthetic lap-validity signals: a clean flying lap, never in the pits, so the
    // app's recorder treats each synthetic lap as a real timed lap.
    latest.lapNumber = Math.floor(elapsed / LAP) + 1;
    latest.lastLapTime = elapsed >= LAP ? LAP : 0; // 0 until the first lap completes
    // Alternate dry (Soft, visual 16) ↔ wet (Intermediate, visual 7) each lap so the
    // app's dry/wet PB split has both kinds of lap to show with no game running.
    const wetLap = Math.floor(elapsed / LAP) % 2 === 1;
    latest.tyreVisual = wetLap ? 7 : 16;
    latest.tyreActual = wetLap ? 7 : 16;
    latest.tyreAge = Math.floor(elapsed / LAP);
    latest.driverStatus = 1; // flying lap
    latest.pitStatus = 0;
    latest.lapInvalid = 0;
    // Synthetic sector splits: freeze S1 once past 1/3 of the lap, S2 once past 2/3,
    // mirroring how the game sets each split as the car crosses the sector line.
    latest.currentSector = pct < 1 / 3 ? 0 : pct < 2 / 3 ? 1 : 2;
    latest.sector1Time = pct >= 1 / 3 ? LAP / 3 : 0;
    latest.sector2Time = pct >= 2 / 3 ? LAP / 3 : 0;
    // Synthetic closed-loop "circuit" so the live track map can be tested.
    const ang = pct * 2 * Math.PI;
    latest.worldX = 600 * Math.cos(ang) + 160 * Math.cos(3 * ang);
    latest.worldZ = 420 * Math.sin(ang) + 130 * Math.sin(2 * ang);
    latest.worldY = 18 * Math.sin(ang * 3) + 9 * Math.cos(ang * 5); // synthetic hills for the 3D view
    markPacket();
  }, 1000 / BROADCAST_HZ);
}

function markPacket() {
  gotPacket = true;
}
