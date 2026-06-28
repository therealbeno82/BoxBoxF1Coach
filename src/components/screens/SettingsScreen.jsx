// ─── SETTINGS SCREEN ────────────────────────────────────────────────────────
// System configuration: AI provider/model, the telemetry-bridge WebSocket, the
// trace configurator + calibrator, general preferences (speed units + cue/insight
// toggles), the coach voice (engine + voice + rate), and the driver roster sign-up.
// Replaces the legacy SetupPanel; the light/dark + team-skin appearance picker is
// retired with the dark-only redesign.

import { useEffect, useRef, useState } from "react";
import { C, FONT, LIVERY_COLORS, eyebrow } from "../../lib/ui/tokens.js";
import { KOKORO_VOICES, DEFAULT_KOKORO_VOICE } from "../../lib/kokoroTTS.js";
import { listOpenRouterModels } from "../../lib/coach/provider.js";
import { DEFAULT_OPENROUTER_MODEL } from "../../lib/coach/config.js";
import { fileToAvatarDataUrl } from "../../lib/avatarImage.js";

// In the packaged Tauri app the telemetry bridge is bundled and started
// automatically (see src-tauri/src/lib.rs). In plain browser dev it still has to
// be launched by hand with `npm run bridge`, so the hint copy adapts to context.
const isTauri = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

const card = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 13 };
const label = { fontSize: 10, letterSpacing: 1.5, color: C.textMuted, textTransform: "uppercase", fontWeight: 600 };
const input = { background: C.inset, border: `1px solid ${C.borderInput}`, borderRadius: 8, padding: "11px 13px", color: C.textBody, fontSize: 13, fontFamily: FONT.mono, letterSpacing: 1, outline: "none", width: "100%" };

function Switch({ on, onClick }) {
  return (
    <span onClick={onClick} style={{ width: 34, height: 19, flex: "none", borderRadius: 11, background: on ? C.blue : C.borderInput, position: "relative", transition: "background .15s", display: "inline-block", cursor: "pointer" }}>
      <span style={{ position: "absolute", top: 2, left: on ? 17 : 2, width: 15, height: 15, borderRadius: "50%", background: "#fff", transition: "left .15s" }} />
    </span>
  );
}

function ProviderCard({ active, dot, name, model, onClick }) {
  return (
    <button onClick={onClick} style={{ display: "flex", flexDirection: "column", gap: 7, alignItems: "flex-start", textAlign: "left",
      padding: "12px 13px", borderRadius: 10, cursor: "pointer", fontFamily: FONT.ui,
      background: active ? C.elevated : C.inset, border: `1px solid ${active ? C.blue : C.borderInput}`,
      boxShadow: active ? `0 0 0 1px ${C.blue} inset` : "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: dot }} />
        <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: .3 }}>{name}</span>
      </div>
      <span style={{ fontSize: 10, color: C.textDim, fontFamily: FONT.mono }}>{model}</span>
    </button>
  );
}

export default function SettingsScreen({
  provider, setProvider, ollamaUrl, setOllamaUrl, model, setModel,
  openRouterKey, setOpenRouterKey, openRouterModel, setOpenRouterModel,
  ollamaStatus, onTestOllama, ollamaModels = [], onLoadOllamaModels,
  wsUrl, setWsUrl, wsConnected, onWsConnect, onWsDisconnect,
  udpPort, setUdpPort,
  repeatEnabled, setRepeatEnabled, repeatPort, setRepeatPort,
  units, setUnits, audioOn, setAudioOn, autoInsights, setAutoInsights,
  voicePrefs, setVoicePrefs, kokoro, onTestVoice,
  drivers = [], activeDriver, onSignDriver, avatars = {}, onDeleteDriver,
  onOpenTrace, onOpenCalibrator,
}) {
  const engine = voicePrefs.engine || "browser";
  const [orModels, setOrModels] = useState([]);
  const [orStatus, setOrStatus] = useState("idle");
  const [availVoices, setAvailVoices] = useState([]);

  // Draft text for the UDP port field so the user can clear/retype freely; only a
  // valid 1–65535 value is committed up to the app (which pushes it to the bridge).
  const [portDraft, setPortDraft] = useState(String(udpPort));
  useEffect(() => { setPortDraft(String(udpPort)); }, [udpPort]);
  const commitPort = () => {
    const n = parseInt(portDraft, 10);
    if (n >= 1 && n <= 65535) setUdpPort(n);
    else setPortDraft(String(udpPort)); // revert an out-of-range / empty entry
  };
  const portValid = (() => { const n = parseInt(portDraft, 10); return n >= 1 && n <= 65535; })();

  // Same draft-commit pattern for the repeater's target port (where the raw stream
  // is re-broadcast for a second app to read).
  const [repeatPortDraft, setRepeatPortDraft] = useState(String(repeatPort));
  useEffect(() => { setRepeatPortDraft(String(repeatPort)); }, [repeatPort]);
  const commitRepeatPort = () => {
    const n = parseInt(repeatPortDraft, 10);
    if (n >= 1 && n <= 65535) setRepeatPort(n);
    else setRepeatPortDraft(String(repeatPort));
  };
  const repeatPortValid = (() => { const n = parseInt(repeatPortDraft, 10); return n >= 1 && n <= 65535; })();

  // Sign-up form
  const [sName, setSName] = useState("");
  const [sNumber, setSNumber] = useState("");
  const [sTeam, setSTeam] = useState("");
  const [sColor, setSColor] = useState(LIVERY_COLORS[0]);
  const [sAvatar, setSAvatar] = useState(null);   // downscaled data URL, or null
  const [avatarErr, setAvatarErr] = useState("");
  const fileRef = useRef(null);

  const pickAvatar = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setAvatarErr("");
    try { setSAvatar(await fileToAvatarDataUrl(file)); }
    catch (err) { setAvatarErr(err.message || "Couldn't use that image."); }
  };

  useEffect(() => {
    // List every English system voice. We used to hide "Microsoft …" voices (to
    // favour Chrome's Google voices in dev), but the packaged app runs in WebView2
    // where the ONLY system voices are Microsoft ones — that filter emptied the list.
    const load = () => setAvailVoices(window.speechSynthesis.getVoices().filter(v => v.lang.startsWith("en")));
    load();
    window.speechSynthesis.onvoiceschanged = load;
  }, []);

  // Populate the model picker from Ollama's installed models whenever the Ollama
  // provider is active or its URL changes — so the dropdown is ready without the
  // user having to click Test first.
  useEffect(() => {
    if (provider === "ollama") onLoadOllamaModels?.();
  }, [provider, ollamaUrl, onLoadOllamaModels]);

  const loadOrModels = async () => {
    setOrStatus("loading");
    try {
      const list = await listOpenRouterModels({ key: openRouterKey, signal: AbortSignal.timeout(8000) });
      setOrModels(list); setOrStatus(list.length ? "ok" : "error");
    } catch { setOrStatus("error"); }
  };

  const signUp = () => {
    onSignDriver({ name: sName, number: sNumber, team: sTeam, color: sColor, avatar: sAvatar });
    setSName(""); setSNumber(""); setSTeam(""); setSColor(LIVERY_COLORS[0]);
    setSAvatar(null); setAvatarErr("");
  };

  const bridgeColor = wsConnected ? C.green : C.red;

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
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: bridgeColor, boxShadow: `0 0 8px ${bridgeColor}` }} />
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, color: "#fff" }}>{wsConnected ? "BRIDGE LINKED" : "BRIDGE OFFLINE"}</span>
        </div>
      </div>

      {/* Two columns */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>

        {/* LEFT */}
        <div style={{ flex: "1 1 420px", minWidth: 320, display: "flex", flexDirection: "column", gap: 16 }}>

          {/* AI Model Connections */}
          <div style={card}>
            <span style={eyebrow}>AI Model Connections</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
              <ProviderCard active={provider === "ollama"} dot={C.purple} name="Ollama" model={model || "llama3.2:3b"} onClick={() => setProvider("ollama")} />
              <ProviderCard active={provider === "openrouter"} dot={C.cyan} name="OpenRouter" model={openRouterModel || DEFAULT_OPENROUTER_MODEL} onClick={() => setProvider("openrouter")} />
            </div>

            {provider === "ollama" ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 12 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    <label style={label}>Ollama URL</label>
                    <input value={ollamaUrl} onChange={e => setOllamaUrl(e.target.value)} placeholder="http://localhost:11434" style={input} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    <label style={label}>Model</label>
                    <select value={model} onChange={e => setModel(e.target.value)} style={{ ...input, fontFamily: FONT.mono, cursor: "pointer" }}>
                      {/* Keep a not-installed model visible+selected so the mismatch is obvious. */}
                      {model && !ollamaModels.includes(model) && <option value={model}>{model} — not installed</option>}
                      {ollamaModels.length === 0 && !model && <option value="">No models found</option>}
                      {ollamaModels.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <button onClick={onTestOllama} style={testBtn}>Test connection</button>
                  <span style={{ fontSize: 11, fontFamily: FONT.mono, color: ollamaStatus === "ok" ? C.green : ollamaStatus === "nomodel" ? C.amber || "#d9a441" : ollamaStatus === "error" ? C.red : C.textDim }}>
                    {ollamaStatus === "ok" ? "✓ Connected" : ollamaStatus === "nomodel" ? "✗ Server up — model not installed" : ollamaStatus === "error" ? "✗ Not reachable" : ollamaStatus === "testing" ? "Testing…" : "Untested"}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  <label style={label}>API Key</label>
                  <input type="password" value={openRouterKey} onChange={e => setOpenRouterKey(e.target.value)} placeholder="sk-or-…" autoComplete="off" style={input} />
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
              </>
            )}
          </div>

          {/* Telemetry Bridge */}
          <div style={card}>
            <span style={eyebrow}>Telemetry Bridge · UDP</span>
            <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                <label style={label}>Bridge WebSocket</label>
                <input value={wsUrl} onChange={e => setWsUrl(e.target.value)} placeholder="ws://localhost:9001" style={{ ...input, color: C.cyan }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
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
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, background: C.inset, border: `1px solid ${wsConnected ? "#1d3a2a" : "#3a1d23"}`, borderRadius: 9, padding: "12px 14px" }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: bridgeColor, boxShadow: `0 0 8px ${bridgeColor}`, flex: "none" }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: .5, color: "#fff" }}>{wsConnected ? "BRIDGE LINKED" : "BRIDGE OFFLINE"}</div>
                <div style={{ fontSize: 11, color: C.textDim, fontFamily: FONT.mono }}>{wsConnected ? "Receiving live telemetry" : isTauri ? "Bridge runs automatically — click Connect" : "Run the bridge, then connect"}</div>
              </div>
              {!wsConnected
                ? <button onClick={onWsConnect} style={{ ...testBtn, border: `1px solid ${C.blue}`, background: "#16243f" }}>Connect</button>
                : <button onClick={onWsDisconnect} style={testBtn}>Disconnect</button>}
            </div>
            <div style={{ fontSize: 10, color: C.textDim, lineHeight: 1.7 }}>
              The bridge reads the game's UDP telemetry (port {udpPort}) and forwards it over WebSocket.{" "}
              {isTauri
                ? <>It’s bundled with the app and starts automatically — just enable UDP telemetry in-game (Settings → Telemetry, port {udpPort}, format 2025).</>
                : <>Start it with <span style={{ color: C.textMuted, fontFamily: FONT.mono }}>npm run bridge</span>.</>}
              {" "}Leave the port at 20777 unless another tool receives the game's stream first and rebroadcasts it on a different port — then set that port here.
            </div>

            {/* Repeater: re-broadcast the raw stream to a second app */}
            <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.textBody }}>UDP Repeater</div>
                  <div style={{ fontSize: 11, color: C.textDim, marginTop: 3 }}>Forward the game's raw telemetry to a second app on this PC</div>
                </div>
                <Switch on={!!repeatEnabled} onClick={() => setRepeatEnabled(v => !v)} />
              </div>
              {repeatEnabled && (
                <div style={{ display: "flex", flexDirection: "column", gap: 7, maxWidth: 200 }}>
                  <label style={label}>Repeat to Port</label>
                  <input
                    type="number" min="1" max="65535" inputMode="numeric"
                    value={repeatPortDraft}
                    onChange={e => setRepeatPortDraft(e.target.value)}
                    onBlur={commitRepeatPort}
                    onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
                    placeholder="20778"
                    style={{ ...input, color: repeatPortValid ? C.cyan : C.red }}
                  />
                </div>
              )}
              <div style={{ fontSize: 10, color: C.textDim, lineHeight: 1.7 }}>
                When on, the bridge re-sends the game's raw packets to <span style={{ color: C.textMuted, fontFamily: FONT.mono }}>127.0.0.1:{repeatPort}</span> so a second telemetry app can read them at the same time. Set that app's UDP port to match — and keep it different from {udpPort}.
              </div>
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
            <div style={{ borderTop: `1px solid ${C.line}` }}>
              {[
                { label: "Audio Coaching Cues", desc: "Speak coach callouts over your headset during a session", on: audioOn, toggle: () => setAudioOn(a => !a) },
                { label: "Auto Insights", desc: "Generate a lap summary automatically when you cross the line", on: autoInsights, toggle: () => setAutoInsights(v => !v) },
              ].map(t => (
                <div key={t.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, borderBottom: `1px solid ${C.line}`, padding: "14px 2px" }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.textBody }}>{t.label}</div>
                    <div style={{ fontSize: 11, color: C.textDim, marginTop: 3 }}>{t.desc}</div>
                  </div>
                  <Switch on={t.on} onClick={t.toggle} />
                </div>
              ))}
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
                {[["kokoro", "Kokoro AI", "local", C.purple], ["browser", "System", "instant", C.cyan]].map(([id, name, tag, dot]) => {
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

          {/* Driver Roster */}
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={eyebrow}>Driver Roster · Sign Up</span>
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
                      {sAvatar && <button onClick={() => { setSAvatar(null); setAvatarErr(""); }} style={{ background: "none", border: "none", color: C.textDim,
                        fontSize: 10, letterSpacing: .5, cursor: "pointer", padding: 0, fontFamily: FONT.ui }}>Remove</button>}
                    </div>
                  </div>
                  {avatarErr && <span style={{ fontSize: 10, color: C.red }}>{avatarErr}</span>}
                </div>
                <button onClick={signUp} disabled={!sName.trim()} style={{ width: "100%", padding: 13, borderRadius: 9, border: `1px solid ${C.blue}`,
                  background: sName.trim() ? "linear-gradient(135deg,#3671C6,#2a5aa0)" : C.inset, color: sName.trim() ? "#fff" : C.textFaint,
                  fontSize: 13, fontWeight: 800, letterSpacing: 1, cursor: sName.trim() ? "pointer" : "default", fontFamily: FONT.ui,
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                  SIGN DRIVER <span style={{ fontSize: 15 }}>→</span>
                </button>
              </div>
              <div style={{ flex: "1 1 200px", minWidth: 200, display: "flex", flexDirection: "column", gap: 9 }}>
                <span style={{ fontSize: 9, letterSpacing: 1.5, color: C.textDim, textTransform: "uppercase" }}>Current Roster</span>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 240, overflowY: "auto", paddingRight: 4 }}>
                  {drivers.map(d => (
                    <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 10, background: C.inset, border: `1px solid ${d.name === activeDriver ? d.color : C.line}`, borderRadius: 9, padding: "8px 11px" }}>
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
                      {onDeleteDriver && drivers.length > 1 && (
                        <button onClick={() => onDeleteDriver(d.name)} title={`Remove ${d.name}`} aria-label={`Remove ${d.name}`} style={{ flex: "none",
                          width: 24, height: 24, borderRadius: 6, border: `1px solid ${C.line}`, background: "transparent", color: C.textDim,
                          cursor: "pointer", fontSize: 12, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
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
