// ─── SETTINGS SCREEN ────────────────────────────────────────────────────────
// System configuration: AI provider/model, the telemetry UDP port, the
// trace configurator + calibrator, general preferences (speed units), the coach
// voice (engine + voice + rate), the Appearance · Team Skin picker, the driver
// roster sign-up, and the About footer carrying the running build's version.
// Replaces the legacy SetupPanel.

import { useEffect, useRef, useState } from "react";
import { C, FONT, LIVERY_COLORS, eyebrow } from "../../lib/ui/tokens.js";
import { SKINS } from "../../lib/ui/skins.js";
import { KOKORO_VOICES, DEFAULT_KOKORO_VOICE } from "../../lib/kokoroTTS.js";
import { listOpenRouterModels } from "../../lib/coach/provider.js";
import { DEFAULT_OPENROUTER_MODEL } from "../../lib/coach/config.js";
import { fileToAvatarDataUrl } from "../../lib/avatarImage.js";
import { parseProfileFile } from "../../lib/profileBackup.js";
import { APP_VERSION } from "../../lib/updateCheck.js";
// The telemetry core is built into the native app (see src-tauri) and is always
// running; there's nothing to launch. In plain browser dev there is no native
// core at all, so the hint copy adapts to context (inTauri).
import { inTauri } from "../../lib/env.js";
import LeaderboardSettings from "../LeaderboardSettings.jsx";
import { invoke } from "@tauri-apps/api/core";

const card = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 13 };
const label = { fontSize: 10, letterSpacing: 1.5, color: C.textMuted, textTransform: "uppercase", fontWeight: 600 };
const input = { background: C.inset, border: `1px solid ${C.borderInput}`, borderRadius: 8, padding: "11px 13px", color: C.textBody, fontSize: 13, fontFamily: FONT.mono, letterSpacing: 1, outline: "none", width: "100%" };

export default function SettingsScreen({
  openRouterKey, setOpenRouterKey, openRouterModel, setOpenRouterModel,
  wsConnected,
  udpPort, setUdpPort,
  fakeMode, setFakeMode,
  units, setUnits,
  tempUnits, setTempUnits,
  activeSkin, setActiveSkin,
  voicePrefs, setVoicePrefs, kokoro, onTestVoice,
  drivers = [], activeDriver, onSignDriver, avatars = {}, onDeleteDriver, onEditDriver,
  onExportProfile, onImportProfile,
  onOpenTrace, onOpenCalibrator,
  leaderboardEnabled, setLeaderboardEnabled, driverProfile,
}) {
  const engine = voicePrefs.engine || "browser";
  const [orModels, setOrModels] = useState([]);
  const [orStatus, setOrStatus] = useState("idle");
  const [availVoices, setAvailVoices] = useState([]);

  // Draft text for the UDP port field so the user can clear/retype freely; only a
  // valid 1–65535 value is committed up to the app (which pushes it to the Rust core).
  const [portDraft, setPortDraft] = useState(String(udpPort));
  useEffect(() => { setPortDraft(String(udpPort)); }, [udpPort]);
  const commitPort = () => {
    const n = parseInt(portDraft, 10);
    if (n >= 1 && n <= 65535) setUdpPort(n);
    else setPortDraft(String(udpPort)); // revert an out-of-range / empty entry
  };
  const portValid = (() => { const n = parseInt(portDraft, 10); return n >= 1 && n <= 65535; })();

  // Click-to-copy for the readouts a user gets asked to relay (LAN address, build
  // version). `copied` holds the value that just flashed its confirmation.
  const [copied, setCopied] = useState("");
  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); setCopied(text); setTimeout(() => setCopied(""), 1500); }
    catch { /* clipboard blocked — the value is still shown to read off manually */ }
  };

  // This device's LAN addresses — what a console player enters in the game's
  // telemetry target-IP field when running the app on a second device. Fetched
  // from the native core (browser JS can't read the real interface IP); empty in
  // plain-browser dev.
  const [localIps, setLocalIps] = useState([]);
  useEffect(() => {
    if (!inTauri) return;
    invoke("get_local_ips").then(setLocalIps).catch(() => setLocalIps([]));
  }, []);

  // Sign-up / edit form. `editingName` holds the original name of the driver being
  // edited (null when the form is signing a brand-new driver); `avatarTouched`
  // tracks whether the photo was changed so an untouched edit leaves it as-is.
  const [sName, setSName] = useState("");
  const [sNumber, setSNumber] = useState("");
  const [sTeam, setSTeam] = useState("");
  const [sColor, setSColor] = useState(LIVERY_COLORS[0]);
  const [sAvatar, setSAvatar] = useState(null);   // downscaled data URL, or null
  const [avatarErr, setAvatarErr] = useState("");
  const [editingName, setEditingName] = useState(null);
  const [avatarTouched, setAvatarTouched] = useState(false);
  const [formErr, setFormErr] = useState("");
  const fileRef = useRef(null);

  const pickAvatar = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setAvatarErr("");
    try { setSAvatar(await fileToAvatarDataUrl(file)); setAvatarTouched(true); }
    catch (err) { setAvatarErr(err.message || "Couldn't use that image."); }
  };

  const resetForm = () => {
    setSName(""); setSNumber(""); setSTeam(""); setSColor(LIVERY_COLORS[0]);
    setSAvatar(null); setAvatarErr(""); setEditingName(null); setAvatarTouched(false); setFormErr("");
  };

  // Load a roster driver into the form to edit it (its current photo included).
  const startEdit = (d) => {
    setSName(d.name); setSNumber(d.number || ""); setSTeam(d.team || "");
    setSColor(d.color || LIVERY_COLORS[0]); setSAvatar(avatars[d.name] || null);
    setAvatarErr(""); setFormErr(""); setAvatarTouched(false); setEditingName(d.name);
  };

  // ─── Profile backup / import ────────────────────────────────────────────────
  // Export the active driver's whole profile to a file; import one back. On a name
  // collision the user chooses copy-vs-overwrite (pendingImport holds the parsed
  // payload until they decide). backupMsg reports the outcome; backupBusy disables
  // the buttons while a read/write is in flight.
  const profileFileRef = useRef(null);
  const [backupMsg, setBackupMsg] = useState(null);       // { kind:"ok"|"err", text }
  const [backupBusy, setBackupBusy] = useState(false);
  const [pendingImport, setPendingImport] = useState(null); // { payload, name }

  const lapWord = (n) => `${n} lap${n === 1 ? "" : "s"}`;

  const exportActiveProfile = async () => {
    if (!onExportProfile) return;
    setBackupBusy(true); setBackupMsg(null); setPendingImport(null);
    try {
      const c = await onExportProfile();
      if (!c) return; // dialog cancelled — nothing written, no message
      const maps = c?.trackMaps ? `, ${c.trackMaps} track map${c.trackMaps === 1 ? "" : "s"}` : "";
      setBackupMsg({ kind: "ok", text: `Exported ${activeDriver} — ${lapWord(c?.laps || 0)}${maps}.` });
    } catch (e) { setBackupMsg({ kind: "err", text: e.message || "Export failed." }); }
    finally { setBackupBusy(false); }
  };

  // A non-colliding "<name> (imported)" variant for the copy option.
  const uniqueCopyName = (base) => {
    const names = new Set(drivers.map(d => d.name));
    if (!names.has(`${base} (imported)`)) return `${base} (imported)`;
    let i = 2;
    while (names.has(`${base} (imported ${i})`)) i++;
    return `${base} (imported ${i})`;
  };

  const pickProfileFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setBackupMsg(null); setPendingImport(null);
    try {
      const payload = parseProfileFile(await file.text());
      const incoming = payload.driver.name;
      if (drivers.some(d => d.name === incoming)) setPendingImport({ payload, name: incoming });
      else await runImport(payload, { name: incoming, overwrite: false });
    } catch (err) { setBackupMsg({ kind: "err", text: err.message || "Couldn't read that file." }); }
  };

  const runImport = async (payload, opts) => {
    if (!onImportProfile) return;
    setBackupBusy(true); setBackupMsg(null); setPendingImport(null);
    try {
      const entry = await onImportProfile(payload, opts);
      const c = entry?.counts || {};
      setBackupMsg({ kind: "ok", text: `Imported ${opts.name} — ${lapWord(c.laps || 0)}${opts.overwrite ? " (overwrote existing)" : ""}.` });
    } catch (err) { setBackupMsg({ kind: "err", text: err.message || "Import failed." }); }
    finally { setBackupBusy(false); }
  };

  useEffect(() => {
    // List every English system voice. We used to hide "Microsoft …" voices (to
    // favour Chrome's Google voices in dev), but the packaged app runs in WebView2
    // where the ONLY system voices are Microsoft ones — that filter emptied the list.
    const load = () => setAvailVoices(window.speechSynthesis.getVoices().filter(v => v.lang.startsWith("en")));
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  const loadOrModels = async () => {
    setOrStatus("loading");
    try {
      const list = await listOpenRouterModels({ key: openRouterKey, signal: AbortSignal.timeout(8000) });
      setOrModels(list); setOrStatus(list.length ? "ok" : "error");
    } catch { setOrStatus("error"); }
  };

  const submit = async () => {
    if (!sName.trim()) return;
    const base = { name: sName, number: sNumber, team: sTeam, color: sColor };
    if (editingName) {
      // Untouched photo → send undefined so a rename keeps it; otherwise the
      // current form photo (a data URL or null for "removed").
      const ok = await onEditDriver(editingName, { ...base, avatar: avatarTouched ? sAvatar : undefined });
      if (!ok) { setFormErr("That name is already on the roster."); return; }
    } else {
      onSignDriver({ ...base, avatar: sAvatar });
    }
    resetForm();
  };

  // Demo mode drives `wsConnected` true (the core stamps packet times as it
  // replays), so the status readouts must call it out explicitly — otherwise
  // they'd claim "TELEMETRY LIVE · Receiving on UDP 20777" while nothing is
  // arriving on that port at all.
  const coreColor = fakeMode ? C.yellow : wsConnected ? C.green : C.red;
  const coreLabel = fakeMode ? "DEMO TELEMETRY" : wsConnected ? "TELEMETRY LIVE" : "NO TELEMETRY";

  return (
    <div style={{ flex: 1, minHeight: 0, background: C.bg, padding: "16px 28px 22px",
      display: "flex", flexDirection: "column", gap: 16, fontFamily: FONT.ui, color: C.textBody }}>

      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap", flex: "none" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
          <div style={{ width: 5, height: 42, borderRadius: 3, background: C.blue }} />
          <div>
            <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 1, lineHeight: 1, color: "#fff" }}>SETTINGS</div>
            <div style={{ fontSize: 11, letterSpacing: 2, color: C.textDim, textTransform: "uppercase", marginTop: 5 }}>System Configuration &amp; Connections</div>
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 7, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 9, padding: "7px 13px" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: coreColor, boxShadow: `0 0 8px ${coreColor}` }} />
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, color: "#fff" }}>{coreLabel}</span>
        </div>
      </div>

      {/* Two columns */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>

        {/* LEFT */}
        <div style={{ flex: "1 1 420px", minWidth: 320, display: "flex", flexDirection: "column", gap: 16 }}>

          {/* AI Model Connection · OpenRouter */}
          <div style={card}>
            <span style={eyebrow}>AI Model Connection · OpenRouter</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <label style={label}>API Key</label>
              <input type="password" value={openRouterKey} onChange={e => setOpenRouterKey(e.target.value)} placeholder="sk-or-…" autoComplete="off" style={input} />
              <div style={{ fontSize: 10, color: C.textDim, lineHeight: 1.6 }}>
                Stored locally on this PC in cleartext (browser storage) so you don't re-enter it each launch —
                it never leaves your machine except in requests to OpenRouter. Use a key scoped to this app and revoke it if the machine is shared.
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <label style={label}>Model</label>
              <input value={openRouterModel} onChange={e => setOpenRouterModel(e.target.value)} list="or-models" placeholder={DEFAULT_OPENROUTER_MODEL} style={input} />
              <datalist id="or-models">{orModels.map(m => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}</datalist>
            </div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <button onClick={loadOrModels} style={testBtn}>Load models</button>
              <span style={{ fontSize: 11, fontFamily: FONT.mono, color: orStatus === "ok" ? C.green : orStatus === "error" ? C.red : C.textDim }}>
                {orStatus === "ok" ? `✓ ${orModels.length} models` : orStatus === "error" ? "✗ Couldn't load" : orStatus === "loading" ? "Loading…" : "Not loaded"}
              </span>
            </div>
          </div>

          {/* Telemetry (native in-process core) */}
          <div style={card}>
            <span style={eyebrow}>Telemetry · UDP</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 7, maxWidth: 220 }}>
              <label style={label}>UDP Port</label>
              <input
                type="number" min="1" max="65535" inputMode="numeric"
                value={portDraft}
                onChange={e => setPortDraft(e.target.value)}
                onBlur={commitPort}
                onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
                placeholder="20777"
                style={{ ...input, color: portValid ? C.cyan : C.red }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, background: C.inset, border: `1px solid ${fakeMode ? "#3a331d" : wsConnected ? "#1d3a2a" : "#3a1d23"}`, borderRadius: 9, padding: "12px 14px" }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: coreColor, boxShadow: `0 0 8px ${coreColor}`, flex: "none" }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: .5, color: "#fff" }}>{coreLabel}</div>
                <div style={{ fontSize: 11, color: C.textDim, fontFamily: FONT.mono }}>{
                  fakeMode ? "Synthetic lap — the game is not being read"
                  : wsConnected ? `Receiving on UDP ${udpPort}`
                  : inTauri ? "Waiting for the game's UDP stream"
                  : "Telemetry needs the native app (tauri dev)"}</div>
              </div>
            </div>

            {/* Demo mode — the native core replays a real recorded race (see
                src-tauri/src/telemetry/demo.rs), so the whole pipeline can be driven
                with no game running. Hidden in plain-browser dev, where there is no
                core to toggle. */}
            {inTauri && (
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                <label style={label}>Demo Mode · no game needed</label>
                <div style={{ display: "flex", gap: 8 }}>
                  {[["Off", false], ["Replay session", true]].map(([text, on]) => (
                    <button key={text} onClick={() => setFakeMode(on)} style={{
                      padding: "9px 14px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 700, letterSpacing: .3, fontFamily: FONT.ui,
                      background: fakeMode === on ? C.elevated : C.inset,
                      border: `1px solid ${fakeMode === on ? (on ? C.yellow : C.blue) : C.borderInput}`,
                      color: fakeMode === on ? "#fff" : "#9aa3b5" }}>{text}</button>
                  ))}
                </div>
                <div style={{ fontSize: 10, color: C.textDim, lineHeight: 1.7 }}>
                  Replays a real recorded race — every input, line and lap time as it was
                  actually driven — so you can try the cockpit, coaching and force feedback
                  without the game open. It starts from lap 1 each time you switch it on.
                  Replayed laps are tagged DEMO and never count towards your personal bests,
                  records or stats.
                </div>
              </div>
            )}
            {/* Online leaderboards: the master switch, what your board identity
                actually is, and the only place a published lap can be taken back
                down. */}
            <LeaderboardSettings
              enabled={leaderboardEnabled} setEnabled={setLeaderboardEnabled}
              driver={driverProfile}
            />

            {/* Console / second-device setup — the game sends telemetry to THIS
                device's LAN IP, so surface the address(es) to enter in-game. */}
            {inTauri && (
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                <label style={label}>This Device's Address · for consoles</label>
                {localIps.length ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {localIps.map(({ name, ip }) => (
                      <button key={ip} onClick={() => copy(ip)} title={`Copy ${ip}`} style={{
                        display: "flex", alignItems: "center", gap: 10, textAlign: "left", width: "100%",
                        background: C.inset, border: `1px solid ${copied === ip ? C.green : C.borderInput}`,
                        borderRadius: 8, padding: "9px 12px", cursor: "pointer", fontFamily: FONT.mono }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: C.cyan, letterSpacing: 1 }}>{ip}</span>
                        <span style={{ fontSize: 10, color: C.textDim, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: FONT.ui }}>{name}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: .5, color: copied === ip ? C.green : C.textDim, flex: "none", fontFamily: FONT.ui }}>{copied === ip ? "✓ COPIED" : "COPY"}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: C.textDim, fontFamily: FONT.mono }}>No network address found — connect this device to your network.</div>
                )}
              </div>
            )}
            <div style={{ fontSize: 10, color: C.textDim, lineHeight: 1.7 }}>
              The telemetry core is built into the app and always listening — just enable UDP telemetry in-game
              (Settings → Telemetry, port {udpPort}, <span style={{ color: C.textMuted, fontFamily: FONT.mono }}>format 2026</span>, rate 60 Hz for the smoothest force feedback).
              {inTauri && localIps.length > 0 && (
                <> <br /><b style={{ color: C.textMuted }}>On console (PS5 / Xbox):</b> run this app on a PC or laptop on the same
                network, then in the game set <span style={{ color: C.textMuted, fontFamily: FONT.mono }}>IP Address</span> to this device's
                address above (e.g. <span style={{ color: C.cyan, fontFamily: FONT.mono }}>{localIps[0].ip}</span>) and Port to {udpPort}.</>
              )}
              {" "}Leave the port at 20777 unless another tool receives the game's stream first and rebroadcasts it on a different port — then set that port here.
            </div>
          </div>

          {/* General Preferences */}
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <span style={eyebrow}>General Preferences</span>
              {activeDriver && <span style={perDriverNote}>Saved for {activeDriver}</span>}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <label style={label}>Speed Units</label>
              <div style={{ display: "flex", gap: 8 }}>
                {["km/h", "mph"].map(u => (
                  <button key={u} onClick={() => setUnits(u)} style={{
                    padding: "9px 14px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 700, letterSpacing: .3, fontFamily: FONT.ui,
                    background: units === u ? C.elevated : C.inset, border: `1px solid ${units === u ? C.blue : C.borderInput}`, color: units === u ? "#fff" : "#9aa3b5" }}>{u}</button>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <label style={label}>Tyre Temp Units</label>
              <div style={{ display: "flex", gap: 8 }}>
                {["°C", "°F"].map(u => (
                  <button key={u} onClick={() => setTempUnits(u)} style={{
                    padding: "9px 14px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 700, letterSpacing: .3, fontFamily: FONT.ui,
                    background: tempUnits === u ? C.elevated : C.inset, border: `1px solid ${tempUnits === u ? C.blue : C.borderInput}`, color: tempUnits === u ? "#fff" : "#9aa3b5" }}>{u}</button>
                ))}
              </div>
            </div>
          </div>

          {/* Coach Voice */}
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <span style={eyebrow}>Coach Voice</span>
              {activeDriver && <span style={perDriverNote}>Saved for {activeDriver}</span>}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <label style={label}>Voice Engine</label>
              <div style={{ display: "flex", gap: 8 }}>
                {/* Dots follow the skin: Kokoro = primary accent, System = secondary accent.
                    Fallbacks (purple / cyan) keep the Default skin's original look. */}
                {[["kokoro", "Kokoro AI", "local", C.accent1], ["browser", "System", "instant", C.accent2]].map(([id, name, tag, dot]) => {
                  const active = engine === id;
                  return (
                    <button key={id} onClick={() => setVoicePrefs(p => ({ ...p, engine: id }))} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start",
                      padding: "10px 12px", borderRadius: 8, cursor: "pointer", fontFamily: FONT.ui, textAlign: "left",
                      background: active ? C.elevated : C.inset, border: `1px solid ${active ? C.blue : C.borderInput}`, color: C.textBody }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        <span style={{ width: 9, height: 9, borderRadius: "50%", background: dot }} />
                        <span style={{ fontSize: 12, fontWeight: 800 }}>{name}</span>
                      </div>
                      <span style={{ fontSize: 10, color: C.textDim, fontFamily: FONT.mono }}>{tag}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {engine === "kokoro" && kokoro.status !== "ready" && (
              <div>
                <button onClick={kokoro.load} disabled={kokoro.status === "loading"} style={{ ...testBtn, width: "100%" }}>
                  {kokoro.status === "loading" ? `⏳ Downloading… ${Math.round(kokoro.progress)}%` : kokoro.status === "error" ? "⚠ Download failed — retry" : "⬇ Download voice model (~90 MB, once)"}
                </button>
                {kokoro.status === "loading" && (
                  <div style={{ height: 5, background: C.line, borderRadius: 3, marginTop: 8, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${kokoro.progress}%`, background: C.blue, transition: "width .2s" }} />
                  </div>
                )}
              </div>
            )}
            {engine === "kokoro" && kokoro.status === "ready" && (
              <div style={{ fontSize: 10, color: C.green }}>✓ Voice model loaded — runs 100% offline</div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <label style={label}>Voice</label>
              <div style={{ display: "flex", gap: 9 }}>
                {engine === "kokoro" ? (
                  <select value={voicePrefs.kokoroVoice || DEFAULT_KOKORO_VOICE} onChange={e => setVoicePrefs(p => ({ ...p, kokoroVoice: e.target.value }))} style={{ ...input, fontFamily: FONT.ui, flex: 1 }}>
                    {["British", "American"].map(g => (
                      <optgroup key={g} label={g}>{KOKORO_VOICES.filter(v => v.accent === g).map(v => <option key={v.id} value={v.id}>{v.label}</option>)}</optgroup>
                    ))}
                  </select>
                ) : (
                  <select value={voicePrefs.voiceName || ""} onChange={e => setVoicePrefs(p => ({ ...p, voiceName: e.target.value }))} style={{ ...input, fontFamily: FONT.ui, flex: 1 }}>
                    <option value="">Default (British)</option>
                    {availVoices.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
                  </select>
                )}
                <button onClick={() => onTestVoice("Brake now for Turn 3. Box this lap, box.")} style={{ ...testBtn, border: `1px solid ${C.blue}`, background: "#16243f", color: "#fff" }}>▶ Test</button>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={label}>Speed · {(voicePrefs.rate ?? 1.1).toFixed(2)}×</label>
              <input type="range" min="0.7" max="1.5" step="0.05" value={voicePrefs.rate ?? 1.1}
                onChange={e => setVoicePrefs(p => ({ ...p, rate: +e.target.value }))} style={{ accentColor: C.blue }} />
            </div>
          </div>

          {/* Trace Configurator + Calibrator */}
          <div style={card}>
            <span style={eyebrow}>Trace Configurator</span>
            <button onClick={onOpenCalibrator} style={{ width: "100%", padding: 13, borderRadius: 9, border: `1px solid ${C.blue}`,
              background: "linear-gradient(135deg,#16243f,#11151d)", color: "#fff", fontSize: 13, fontWeight: 800, letterSpacing: .5,
              cursor: "pointer", fontFamily: FONT.ui, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              Open Trace Configurator <span style={{ fontSize: 15 }}>→</span>
            </button>
            <div style={{ fontSize: 10, color: C.textDim, lineHeight: 1.7 }}>
              The Calibrator traces a reference lap from an onboard image to build the benchmark the Coach measures you against.
            </div>
          </div>
        </div>

        {/* RIGHT */}
        <div style={{ flex: "1 1 420px", minWidth: 320, display: "flex", flexDirection: "column", gap: 16 }}>

          {/* Appearance · Team Skin — recolours the whole app; selecting applies live */}
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <span style={eyebrow}>Appearance · Team Skin</span>
              {activeDriver && <span style={perDriverNote}>Saved for {activeDriver}</span>}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {SKINS.map((s) => {
                const on = activeSkin === s.id;
                return (
                  <button key={s.id} onClick={() => setActiveSkin(s.id)} title={`Apply ${s.name} skin`} style={{
                    display: "flex", alignItems: "center", gap: 13, textAlign: "left", width: "100%",
                    background: on ? C.elevated : C.inset,
                    border: `1px solid ${on ? C.blue : C.borderInput}`,
                    borderRadius: 10, padding: "11px 13px", cursor: "pointer", fontFamily: FONT.ui,
                    boxShadow: on ? `0 0 0 1px ${C.accent55}` : "none" }}>
                    <span style={{ display: "flex", gap: 3, flex: "none" }}>
                      <span style={{ width: 10, height: 26, borderRadius: 2, background: s.chips[0] }} />
                      <span style={{ width: 10, height: 26, borderRadius: 2, background: s.chips[1], border: `1px solid ${C.borderStrong}` }} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 800, color: on ? "#fff" : C.textHi }}>{s.name}</div>
                      <div style={{ fontSize: 10, color: C.textDim, fontFamily: FONT.mono, marginTop: 2 }}>{s.descriptor}</div>
                    </div>
                    <span style={{ width: 20, height: 20, borderRadius: "50%", flex: "none",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      background: on ? C.accent : "transparent",
                      border: on ? "none" : `2px solid ${C.borderStrong}` }}>
                      {on && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: C.onAccent }}>
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: C.textDim, lineHeight: 1.6 }}>
              Selecting a skin restyles the whole app — surfaces, accents, textures and numerals — and applies instantly. Data colours (sector purple / green / yellow) are held constant across every skin so timing always reads the same.
            </div>
          </div>

          {/* Driver Profile · Backup — export the active driver's whole profile to a
              file (laps + sectors + track maps + photo + prefs) and import it back. */}
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <span style={eyebrow}>Driver Profile · Backup</span>
              {activeDriver && <span style={perDriverNote}>{activeDriver}</span>}
            </div>
            <div style={{ fontSize: 11, color: C.textDim, lineHeight: 1.6 }}>
              Save <b style={{ color: C.textMuted }}>{activeDriver || "the active driver"}</b>'s whole profile — every lap with telemetry, sector times, saved track maps, photo and preferences — to one file, to keep as a backup or move to another PC. Your API key is never included.
            </div>
            <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
              <button onClick={exportActiveProfile} disabled={backupBusy || !activeDriver}
                style={{ ...testBtn, border: `1px solid ${C.blue}`, background: "#16243f", color: "#fff", opacity: backupBusy || !activeDriver ? .5 : 1, cursor: backupBusy || !activeDriver ? "default" : "pointer" }}>
                ⭳ Export Profile
              </button>
              <input ref={profileFileRef} type="file" accept="application/json,.json" onChange={pickProfileFile} style={{ display: "none" }} />
              <button onClick={() => profileFileRef.current?.click()} disabled={backupBusy}
                style={{ ...testBtn, opacity: backupBusy ? .5 : 1, cursor: backupBusy ? "default" : "pointer" }}>
                ⭱ Import Profile…
              </button>
            </div>

            {pendingImport && (
              <div style={{ display: "flex", flexDirection: "column", gap: 9, background: C.inset, border: `1px solid ${C.borderInput}`, borderRadius: 9, padding: "12px 13px" }}>
                <div style={{ fontSize: 12, color: "#fff", fontWeight: 700 }}>“{pendingImport.name}” is already on the roster</div>
                <div style={{ fontSize: 11, color: C.textDim, lineHeight: 1.6 }}>
                  Bring it in as a separate copy, or overwrite that profile's current laps, track maps, photo and preferences?
                </div>
                <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                  <button onClick={() => runImport(pendingImport.payload, { name: uniqueCopyName(pendingImport.name), overwrite: false })}
                    style={{ ...testBtn, border: `1px solid ${C.blue}`, background: "#16243f", color: "#fff" }}>Import as copy</button>
                  <button onClick={() => runImport(pendingImport.payload, { name: pendingImport.name, overwrite: true })}
                    style={{ ...testBtn, border: `1px solid ${C.red}`, color: C.red }}>Overwrite {pendingImport.name}</button>
                  <button onClick={() => setPendingImport(null)} style={testBtn}>Cancel</button>
                </div>
              </div>
            )}

            {backupMsg && (
              <div style={{ fontSize: 11, color: backupMsg.kind === "ok" ? C.green : C.red, fontFamily: FONT.mono, lineHeight: 1.5 }}>
                {backupMsg.kind === "ok" ? "✓ " : "✗ "}{backupMsg.text}
              </div>
            )}
          </div>

          {/* Driver Roster */}
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={eyebrow}>Driver Roster · {editingName ? "Edit" : "Sign Up"}</span>
              <span style={{ fontSize: 9, letterSpacing: 1, color: C.blue, fontWeight: 700, fontFamily: FONT.mono }}>{drivers.length} SIGNED</span>
            </div>
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 240px", minWidth: 220, display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 12 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    <label style={label}>Driver Name</label>
                    <input value={sName} onChange={e => setSName(e.target.value)} placeholder="e.g. JORDAN REYES" style={{ ...input, fontFamily: FONT.ui }} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    <label style={label}>Number</label>
                    <input value={sNumber} onChange={e => setSNumber(e.target.value)} placeholder="00" style={{ ...input, color: C.cyan }} />
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  <label style={label}>Team</label>
                  <input value={sTeam} onChange={e => setSTeam(e.target.value)} placeholder="e.g. Velocity Works" style={{ ...input, fontFamily: FONT.ui }} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  <label style={label}>Livery Colour</label>
                  <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                    {LIVERY_COLORS.map(c => (
                      <button key={c} onClick={() => setSColor(c)} style={{ width: 32, height: 32, flex: "none", borderRadius: 9, cursor: "pointer",
                        background: c, border: `2px solid ${sColor === c ? "#fff" : "transparent"}`, boxShadow: sColor === c ? `0 0 0 1px ${c}` : "none" }} />
                    ))}
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  <label style={label}>Driver Photo</label>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <input ref={fileRef} type="file" accept="image/*" onChange={pickAvatar} style={{ display: "none" }} />
                    <button onClick={() => fileRef.current?.click()} title="Upload a photo" style={{ width: 52, height: 52, flex: "none", borderRadius: "50%",
                      cursor: "pointer", overflow: "hidden", padding: 0, background: C.inset,
                      border: `1px solid ${sAvatar ? sColor : C.borderInput}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {sAvatar
                        ? <img src={sAvatar} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        : <span style={{ fontSize: 22, color: C.textDim, lineHeight: 1 }}>+</span>}
                    </button>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-start" }}>
                      <button onClick={() => fileRef.current?.click()} style={{ ...testBtn, padding: "7px 12px" }}>{sAvatar ? "Change" : "Upload photo"}</button>
                      {sAvatar && <button onClick={() => { setSAvatar(null); setAvatarErr(""); setAvatarTouched(true); }} style={{ background: "none", border: "none", color: C.textDim,
                        fontSize: 10, letterSpacing: .5, cursor: "pointer", padding: 0, fontFamily: FONT.ui }}>Remove</button>}
                    </div>
                  </div>
                  {avatarErr && <span style={{ fontSize: 10, color: C.red }}>{avatarErr}</span>}
                </div>
                {formErr && <span style={{ fontSize: 10, color: C.red }}>{formErr}</span>}
                <div style={{ display: "flex", gap: 9 }}>
                  <button onClick={submit} disabled={!sName.trim()} style={{ flex: 1, padding: 13, borderRadius: 9, border: `1px solid ${C.blue}`,
                    background: sName.trim() ? "linear-gradient(135deg,#3671C6,#2a5aa0)" : C.inset, color: sName.trim() ? "#fff" : C.textFaint,
                    fontSize: 13, fontWeight: 800, letterSpacing: 1, cursor: sName.trim() ? "pointer" : "default", fontFamily: FONT.ui,
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                    {editingName ? "SAVE CHANGES" : <>SIGN DRIVER <span style={{ fontSize: 15 }}>→</span></>}
                  </button>
                  {editingName && (
                    <button onClick={resetForm} style={{ ...testBtn, padding: "13px 16px" }}>Cancel</button>
                  )}
                </div>
              </div>
              <div style={{ flex: "1 1 200px", minWidth: 200, display: "flex", flexDirection: "column", gap: 9 }}>
                <span style={{ fontSize: 9, letterSpacing: 1.5, color: C.textDim, textTransform: "uppercase" }}>Current Roster</span>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 240, overflowY: "auto", paddingRight: 4 }}>
                  {drivers.map(d => {
                    const beingEdited = editingName === d.name;
                    return (
                    <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 10, background: beingEdited ? C.elevated : C.inset,
                      border: `1px solid ${beingEdited ? C.blue : d.name === activeDriver ? d.color : C.line}`, borderRadius: 9, padding: "8px 11px" }}>
                      <span style={{ width: 30, height: 30, flex: "none", borderRadius: 8, overflow: "hidden", background: d.color + "1f", border: `1px solid ${d.color}`,
                        display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.cond, fontWeight: 700, fontSize: 15, color: d.color }}>
                        {avatars[d.name]
                          ? <img src={avatars[d.name]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          : (d.number || d.name.slice(0, 2).toUpperCase())}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.name}</div>
                        <div style={{ fontSize: 10, color: C.textDim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.team || "Unassigned"}</div>
                      </div>
                      {onEditDriver && (
                        <button onClick={() => startEdit(d)} title={`Edit ${d.name}`} aria-label={`Edit ${d.name}`} style={{ flex: "none",
                          width: 24, height: 24, borderRadius: 6, border: `1px solid ${beingEdited ? C.blue : C.line}`, background: "transparent",
                          color: beingEdited ? C.blue : C.textDim, cursor: "pointer", fontSize: 12, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>✎</button>
                      )}
                      {onDeleteDriver && drivers.length > 1 && (
                        <button onClick={() => { if (editingName === d.name) resetForm(); onDeleteDriver(d.name); }} title={`Remove ${d.name}`} aria-label={`Remove ${d.name}`} style={{ flex: "none",
                          width: 24, height: 24, borderRadius: 6, border: `1px solid ${C.line}`, background: "transparent", color: C.textDim,
                          cursor: "pointer", fontSize: 12, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                      )}
                    </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* About — the running build's version. The only place the app states which
            version is actually installed (the update banner names the *latest*
            release, and only when one is newer), so it's what "which version are you
            on?" gets answered from. Click to copy, like the addresses above. */}
        <div style={{ flex: "1 1 100%", display: "flex", alignItems: "center", gap: 10,
          borderTop: `1px solid ${C.line}`, paddingTop: 12, marginTop: 2 }}>
          <span style={{ ...eyebrow, fontSize: 9, letterSpacing: 1.5, color: C.textFaint }}>F1 Coach</span>
          <button onClick={() => copy(APP_VERSION)} title={`Copy version ${APP_VERSION}`} style={{
            display: "flex", alignItems: "center", gap: 7, background: "transparent",
            border: `1px solid ${copied === APP_VERSION ? C.green : "transparent"}`,
            borderRadius: 7, padding: "3px 8px", cursor: "pointer" }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, fontFamily: FONT.mono,
              color: copied === APP_VERSION ? C.green : C.textDim }}>v{APP_VERSION}</span>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: .5, fontFamily: FONT.ui,
              color: copied === APP_VERSION ? C.green : C.textFaintest }}>{copied === APP_VERSION ? "✓ COPIED" : "COPY"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

const testBtn = {
  flex: "none", padding: "9px 16px", borderRadius: 8, border: `1px solid ${C.borderStrong}`,
  background: C.inset, color: C.textBody, fontSize: 12, fontWeight: 700, letterSpacing: .3,
  cursor: "pointer", fontFamily: FONT.ui,
};

const perDriverNote = {
  fontSize: 9, letterSpacing: 1, color: C.blue, fontWeight: 700, fontFamily: FONT.mono,
  textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
};
