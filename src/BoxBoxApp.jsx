import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Shell from "./components/Shell.jsx";
import DashboardScreen from "./components/screens/DashboardScreen.jsx";
import LiveScreen from "./components/screens/LiveScreen.jsx";
import AnalyticsScreen from "./components/screens/AnalyticsScreen.jsx";
import SettingsScreen from "./components/screens/SettingsScreen.jsx";
import CoachLogScreen from "./components/screens/CoachLogScreen.jsx";
import FfbScreen from "./components/screens/FfbScreen.jsx";
import SwitchDriverModal from "./components/modals/SwitchDriverModal.jsx";
import CarSetupModal from "./components/modals/CarSetupModal.jsx";
import TraceConfiguratorModal from "./components/modals/TraceConfiguratorModal.jsx";
import { C, LIVERY_COLORS } from "./lib/ui/tokens.js";
import { applySkin, isSkin, DEFAULT_SKIN } from "./lib/ui/skins.js";
import CoachChat from "./components/CoachChat.jsx";
import TelemetryStudio from "./components/TelemetryStudio.jsx";
import { exportLapToFile, exportSessionToFile, parseSessionLaps } from "./lib/lapExport.js";
import * as lapStore from "./lib/lapStore.js";
import { exportProfile as exportProfileFile, importProfile as importProfileData } from "./lib/profileBackup.js";
import { buildLapEvidence } from "./lib/lapEvidence.js";
import { buildLapLog, buildTrends, buildCornerProfiles } from "./lib/lapHistory.js";
import { makeTrackLabeler } from "./lib/trackLabels.js";
// trackScene3d (and its three.js dependency) is loaded on demand inside the Driving
// Lines tab — see the dynamic import in CompareDrivingLines — so three stays out of
// the app's startup bundle.
import { getTrack, sameTrack, isKnownTrackName } from "./lib/trackData.js";
import { getCorners, cornerLabel, resolveSlug } from "./lib/cornerData.js";
import { synthesize, loadKokoro, isKokoroLoaded, DEFAULT_KOKORO_VOICE } from "./lib/kokoroTTS.js";
import { buildCoachLog } from "./lib/coach/coachLog.js";
import { buildTipPrompt, buildDebriefPrompt } from "./lib/coach/prompts.js";
import { COACHING_TIP_SCHEMA, DEBRIEF_SCHEMA, validateTip, repairTip, cleanSummary } from "./lib/coach/schema.js";
import { telemetryIsUsable, collectAllowedNumbers, enforceGrounding } from "./lib/coach/guardrails.js";
import { createProvider } from "./lib/coach/provider.js";
import { PARAMS, ERS_MODES, DEFAULT_OPENROUTER_MODEL } from "./lib/coach/config.js";
import { formatLapTime, sessionTypeName, speakable, clamp, MINI_SECTORS, MINI_PER_SECTOR } from "./lib/format.js";
import { isRankable, visibleSessionLaps } from "./lib/driverStats.js";
import { inTauri } from "./lib/env.js";
import { useLlmHealth } from "./hooks/useLlmHealth.js";
import { useUpdateCheck } from "./hooks/useUpdateCheck.js";
import { useTelemetry } from "./hooks/useTelemetry.js";
import { useFfbEngine } from "./hooks/useFfbEngine.js";
import { invoke } from "@tauri-apps/api/core";

// Guard the `invoke` calls so `npm run dev` in a browser doesn't throw.
const coreInvoke = (cmd, args) => { if (inTauri) invoke(cmd, args).catch(() => {}); };

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const ERS_COLORS    = { 0: "#444", 1: "#888", 2: "#e040fb", 3: "#2979ff" };

// How many recent same-track laps the coach reasons over. Scopes every coaching
// input (evidence, structured log, trends, corner profiles) to the current form on
// THIS circuit rather than the driver's entire back-catalogue across all tracks.
const COACH_LAP_WINDOW = 20;
// How many older-session laps (same track) the coach also sees, clearly labelled
// as previous-session material — trends/progress only, never "lap N" answers.
const COACH_PREV_LAP_WINDOW = 10;

// Colour per call/zone type. ERS zones colour by their ERS mode (see zoneFill);
// the bare ZONE_COLORS.ers is only used for the toggle chip / legend swatch.
const ZONE_COLORS = { brake:"#ff5252", lico:"#ffab00", lift:"#ffd54f", ers:"#2979ff" };
const zoneFill = (z) => z?.type === "ers" ? (ERS_COLORS[z.ersMode] || "#2979ff") : (ZONE_COLORS[z?.type] || "#1e1e1e");
// Which map-filter category a zone belongs to. "lift" (partial-throttle lift)
// folds into the lift-&-coast filter, mirroring the voice-call toggle grouping.
// Used by the COMPARE maps (their 3 coarse chips: brake / lico / ers).
const filterKeyForZone = (z) => z?.type === "lift" ? "lico" : z?.type;
// Granular per-category key for the LIVE screen's legend chips. Each chip maps to
// exactly one key: ERS zones split by mode (Medium/Hotlap/Boost) and partial "lift"
// stays distinct from "lico". One key drives BOTH the map colour and that category's
// voice cue. "normal" = un-cued/neutral track.
// ERS modes 1-3 (Medium/Hotlap/Boost) each get their own chip; the ERS-OFF "None"
// markers (ersMode 0, which speak "None") share the "normal"/None chip — there is no
// ers0 chip, so without this they'd be gated by a key that never exists in liveCues
// and the None cue would never fire.
const legendKeyFor = (z) => z?.type === "ers" ? (z.ersMode >= 1 ? `ers${z.ersMode}` : "normal") : (z?.type || "normal");
const ZONE_OFF_COLOR = "#222"; // neutral colour for a filtered-out zone segment

// Thresholds for turning one telemetry sample into a call/zone type. Shared by the
// reference zone-derivation (deriveZonesFromTrace) and the per-lap Compare maps so
// the dashboard map, voice calls and the comparison maps all classify identically.
const BRAKE_ON = 12, COAST_THR = 15, LIFT_HI = 85, ERS_THR = 85;
// Classify a single sample into a pseudo-zone { type, ersMode } consumable by
// zoneFill()/filterKeyForZone(). hasBrake=false (trace with no brake channel) treats
// every off-throttle stretch as braking, matching deriveZonesFromTrace. Priority:
// braking > full coast > ERS deploy > partial lift.
function classifySample(s, hasBrake = true) {
  const thr  = typeof s?.throttle === "number" ? s.throttle : 100;
  const brk  = typeof s?.brake === "number" ? s.brake : 0;
  const mode = Math.round(clamp(s?.ersMode ?? 0, 0, 3));
  if (hasBrake && brk > BRAKE_ON)           return { type: "brake", ersMode: mode };
  if (thr < COAST_THR)                      return { type: hasBrake ? "lico" : "brake", ersMode: mode };
  if (thr >= ERS_THR && mode >= 1)          return { type: "ers", ersMode: mode };
  if (thr < LIFT_HI)                        return { type: hasBrake ? "lift" : "normal", ersMode: mode };
  return { type: "normal", ersMode: mode };
}

// Track-map colour key for the COMPARE maps: [swatch colour, label, coarse filter
// category]. ERS modes all fold under the "ers" filter; "None" base is always shown.
const MAP_LEGEND = [
  ["#ff5252", "Brake",  "brake"],
  ["#ffab00", "LiCo",   "lico"],
  ["#ffd54f", "Lift",   "lico"],
  ["#888",    "Medium", "ers"],
  ["#e040fb", "Hotlap", "ers"],
  ["#2979ff", "Boost",  "ers"],
  ["#1e1e1e", "None",   null],
];
// LIVE screen legend: [swatch colour, label, GRANULAR key (legendKeyFor)]. Each chip
// is an independent on/off toggle controlling both the map colour AND that category's
// voice cue. "normal" (None) toggles whether un-cued track segments are drawn AND
// gates the ERS-off "None" cue (ersMode 0 maps to this key — see legendKeyFor).
const LIVE_LEGEND = [
  ["#ff5252", "Brake",  "brake"],
  ["#ffab00", "LiCo",   "lico"],
  ["#ffd54f", "Lift",   "lift"],
  ["#888888", "Medium", "ers1"],  // 6-digit so the chip's `color + "66"` alpha border is valid
  ["#e040fb", "Hotlap", "ers2"],
  ["#2979ff", "Boost",  "ers3"],
  ["#6b7280", "None",   "normal"], // visible neutral grey (was near-black #1e1e1e)
];
// The three selectable map-colour categories (grouped). Each chip toggles which
// zones are colour-coded on the map.
const MAP_FILTER_ITEMS = [
  { key:"brake", label:"Brake",      icon:"🛑" },
  { key:"lico",  label:"Lift&Coast", icon:"〰️" },
  { key:"ers",   label:"ERS",        icon:"🔋" },
];

const DEFAULT_ZONES = [
  { id:1, name:"T1",          start:0.04, end:0.08, type:"brake", ersMode:0, note:"Heavy braking zone" },
  { id:2, name:"S1 Straight", start:0.12, end:0.22, type:"ers",   ersMode:3, note:"Main straight — Boost" },
  { id:3, name:"T3 Entry",    start:0.27, end:0.30, type:"lico",  ersMode:1, note:"Lift and coast into chicane" },
  { id:4, name:"T3 Apex",     start:0.30, end:0.34, type:"brake", ersMode:1, note:"Brake — chicane entry" },
  { id:5, name:"T6 Hairpin",  start:0.42, end:0.47, type:"brake", ersMode:0, note:"Max brake — tight hairpin" },
  { id:6, name:"S2 Deploy",   start:0.52, end:0.62, type:"ers",   ersMode:3, note:"Boost through S2" },
  { id:7, name:"T10 Entry",   start:0.71, end:0.74, type:"lico",  ersMode:1, note:"Lift early — long entry" },
  { id:8, name:"T10 Brake",   start:0.74, end:0.78, type:"brake", ersMode:1, note:"Brake zone" },
  { id:9, name:"S3 Deploy",   start:0.85, end:0.95, type:"ers",   ersMode:2, note:"Hotlap — final sector" },
];

// ── Derive strategy zones FROM a loaded reference trace ─────────────────────
// A trace (exported by the Trace Calibrator) carries throttle, brake + ERS
// channels sampled by lap distance. We segment the lap into three call types:
//   • brake — brake actually applied
//   • lico  — off throttle but not yet braking (the coast before a corner)
//   • ers   — on throttle while the reference is deploying ERS, split BY MODE
//             (Medium / Hotlap / Boost) so the call IS the ERS mode itself.
// There is deliberately no separate "deploy" concept — deploying ERS and the
// ERS mode are one and the same. No trace → DEFAULT_ZONES.
function mostCommon(arr) {
  const counts = {};
  let best = arr[0] ?? 0, bestC = 0;
  for (const v of arr) {
    counts[v] = (counts[v] || 0) + 1;
    if (counts[v] > bestC) { bestC = counts[v]; best = v; }
  }
  return best;
}

// Smooth a numeric channel with a centred moving average (~`win` either side).
function smoothChannel(pts, key, win) {
  const N = pts.length;
  return pts.map((_, i) => {
    let sum = 0, c = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(N - 1, i + win); j++) {
      const v = pts[j][key];
      if (typeof v === "number") { sum += v; c++; }
    }
    return c ? sum / c : 0;
  });
}

function deriveZonesFromTrace(trace) {
  const raw = trace?.samples;
  if (!Array.isArray(raw) || raw.length < 8) return DEFAULT_ZONES;

  const pts = raw
    .filter(s => s && typeof s.dist === "number" && typeof s.throttle === "number")
    .sort((a, b) => a.dist - b.dist);
  const N = pts.length;
  const totalDist = N ? pts[N - 1].dist : 0;
  if (N < 8 || !(totalDist > 0)) return DEFAULT_ZONES;

  // Smooth throttle + brake to tame image-extraction noise (~1% of lap window).
  const win = Math.max(1, Math.round(N * 0.01));
  const thr = smoothChannel(pts, "throttle", win);
  const brk = smoothChannel(pts, "brake", win);
  // If the trace has no brake channel at all we can't tell coasting from braking,
  // so we treat every off-throttle stretch as a brake call (old behaviour).
  const hasBrake = pts.some(p => typeof p.brake === "number");

  // Classify each sample. Priority: braking > full coast > ERS deploy > partial lift.
  //  • brake — brake actually applied (from the brake trace)
  //  • lico  — (near-)zero throttle, NOT braking (the full coast before a corner)
  //  • ers   — on full throttle while deploying (mode ≥ 1); the mode labels the zone
  //  • lift  — throttle eased (partial) but still applied, NOT braking
  // Classify on the SMOOTHED throttle/brake but the raw ERS mode (thresholds shared
  // with the Compare maps via classifySample, defined near zoneFill).
  const classOf = (i) =>
    classifySample({ throttle: thr[i], brake: brk[i], ersMode: pts[i].ersMode }, hasBrake).type;

  // Group contiguous same-class runs. ERS runs additionally break on a change of
  // ERS MODE, so a straight that ramps Medium → Boost becomes two ERS zones (and
  // therefore two distinct mode calls), not one averaged blob.
  const runs = [];
  for (let i = 0; i < N; i++) {
    const cls = classOf(i);
    const mode = cls === "ers" ? Math.round(clamp(pts[i].ersMode ?? 0, 0, 3)) : null;
    const key  = cls === "ers" ? `ers${mode}` : cls;
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.endI = i;
    else runs.push({ cls, key, mode, startI: i, endI: i });
  }

  const zones = [];
  let brakeN = 0, licoN = 0, liftN = 0;
  const ersN = {}; // per-mode counter for nicer names ("Boost 1", "Boost 2")
  for (const r of runs) {
    if (r.cls === "normal") continue;
    // A partial lift is only a real coaching call when the driver eased off near-full
    // power and held it — not when throttle merely ramps back up on a corner exit.
    if (r.cls === "lift" && !(thr[Math.max(0, r.startI - 1)] >= ERS_THR)) continue;
    const start = pts[r.startI].dist / totalDist;
    const end   = pts[r.endI].dist / totalDist;
    // ERS bursts can be short — allow them down to ~0.6% of the lap.
    const minFrac = r.cls === "ers" ? 0.006 : 0.01;
    if (end - start < minFrac) continue;

    if (r.cls === "brake") {
      brakeN++;
      const ersVals = [];
      for (let i = r.startI; i <= r.endI; i++) ersVals.push(Math.round(pts[i].ersMode ?? 0));
      zones.push({ id: zones.length + 1, name: `Brake ${brakeN}`, start, end,
        type: "brake", ersMode: mostCommon(ersVals), note: "Braking zone (from reference)" });
    } else if (r.cls === "lico") {
      licoN++;
      const ersVals = [];
      for (let i = r.startI; i <= r.endI; i++) ersVals.push(Math.round(pts[i].ersMode ?? 0));
      zones.push({ id: zones.length + 1, name: `Lift & Coast ${licoN}`, start, end,
        type: "lico", ersMode: mostCommon(ersVals), note: "Lift and coast — off throttle, no brake" });
    } else if (r.cls === "lift") {
      liftN++;
      const ersVals = [];
      for (let i = r.startI; i <= r.endI; i++) ersVals.push(Math.round(pts[i].ersMode ?? 0));
      zones.push({ id: zones.length + 1, name: `Lift ${liftN}`, start, end,
        type: "lift", ersMode: mostCommon(ersVals), note: "Partial throttle lift (from reference)" });
    } else {
      const mode = Math.max(1, r.mode);
      ersN[mode] = (ersN[mode] || 0) + 1;
      zones.push({ id: zones.length + 1, name: `${ERS_MODES[mode]} ${ersN[mode]}`, start, end,
        type: "ers", ersMode: mode, note: `Reference runs ${ERS_MODES[mode]} here` });
    }
  }

  // ERS "None" markers: where the reference STOPS deploying (mode drops ≥1 → 0), tell
  // the driver to switch ERS off. Built after the minFrac filter so these short
  // transition markers survive. They render via ERS_COLORS[0] and speak "None".
  let noneN = 0;
  for (let i = 1; i < N; i++) {
    const prev = Math.round(clamp(pts[i - 1].ersMode ?? 0, 0, 3));
    const cur  = Math.round(clamp(pts[i].ersMode ?? 0, 0, 3));
    if (prev >= 1 && cur === 0) {
      noneN++;
      const at = pts[i].dist / totalDist;
      zones.push({ id: zones.length + 1, name: `None ${noneN}`,
        start: at, end: Math.min(1, at + 0.01),
        type: "ers", ersMode: 0, note: "Stop deploying — ERS off" });
    }
  }
  zones.sort((a, b) => a.start - b.start).forEach((z, i) => { z.id = i + 1; });

  return zones.length ? zones : DEFAULT_ZONES;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
// Telemetry has physical limits a hand-traced or older export can violate: a gear
// is always a whole number, throttle/brake are 0–100 %, steer is ±100 %. Clamp and
// round every channel as a trace loads so a stray 5.5 gear or -1 throttle from the
// Calibrator never reaches the coaching logic or the readouts. (-1 gear = reverse,
// 0 = neutral are kept legal to match the live bridge's gear range.)
function sanitizeTraceSamples(samples) {
  if (!Array.isArray(samples)) return samples;
  return samples.map(s => {
    if (!s || typeof s !== "object") return s;
    const out = { ...s };
    if (typeof out.throttle === "number") out.throttle = clamp(out.throttle, 0, 100);
    if (typeof out.brake    === "number") out.brake    = clamp(out.brake, 0, 100);
    if (typeof out.steer    === "number") out.steer    = clamp(out.steer, -100, 100);
    if (typeof out.gear     === "number") out.gear     = clamp(Math.round(out.gear), -1, 8);
    return out;
  });
}

function getThrottleColor(p) {
  if (p < 1)  return "#666";
  if (p < 5)  return "#90caf9";
  if (p < 10) return "#2979ff";
  if (p < 50) return "#00e676";
  if (p < 90) return "#ffea00";
  if (p < 99) return "#ff9100";
  return "#ff1744";
}

function findRefSample(samples, distM) {
  if (!samples || samples.length === 0) return null;
  return samples.reduce((best, s) =>
    Math.abs(s.dist - distM) < Math.abs(best.dist - distM) ? s : best, samples[0]);
}

// MoTeC-style time readout (3 dp) — delegates to the shared lap-time formatter.
const fmtTime = (s) => formatLapTime(s, 3);

// ─── AUDIO ENGINE ─────────────────────────────────────────────────────────────
// Speech priority: real-time corner calls must never be talked over by the
// AI's between-lap tip. urgent (brake/lift/coast) > normal (ERS) > low (AI).
const SPEAK_PRIO = { low: 1, normal: 2, urgent: 3 };

// Two interchangeable speech engines behind one `speak()` API + priority arbiter:
//   • "browser" — Web Speech API (instant, but robotic / OS-dependent voices)
//   • "kokoro"  — neural Kokoro model run locally (natural, but must SYNTHESISE
//                 audio first). To keep on-the-mark corner calls instant we
//                 pre-synthesise the known call phrases (see `prewarm`) and cache
//                 the decoded AudioBuffers; only novel text (AI tips, chat) is
//                 synthesised on demand.
function useAudio(voicePrefs = {}) {
  const lastCue  = useRef({ text:"", time:0 });
  // Single-voice arbiter: `current` is the item being spoken, `queue` holds at
  // most one pending lower-priority item so nothing overlaps. `source` is the
  // live Kokoro AudioBufferSourceNode (so a preempt can stop it).
  const stateRef      = useRef({ current: null, queue: null, source: null });
  // Keep a ref so the memoized callbacks always read the latest preference.
  const voicePrefsRef = useRef(voicePrefs);
  voicePrefsRef.current = voicePrefs;

  // Kokoro engine state surfaced to the UI (download progress / readiness).
  const [kokoroStatus,   setKokoroStatus]   = useState(isKokoroLoaded() ? "ready" : "idle");
  const [kokoroProgress, setKokoroProgress] = useState(isKokoroLoaded() ? 100 : 0);
  // Decoded-AudioBuffer cache, keyed by `${voice}|${speed}|${text}`.
  const bufCache = useRef(new Map());

  // One shared AudioContext for Kokoro playback + beeps (browsers cap the count).
  const ctxRef = useRef(null);
  const audioCtx = () => {
    if (!ctxRef.current) {
      try { ctxRef.current = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
    }
    const c = ctxRef.current;
    if (c && c.state === "suspended") c.resume().catch(() => {});
    return c;
  };

  const pickVoice = () => {
    const voices = window.speechSynthesis.getVoices();
    const prefs  = voicePrefsRef.current;
    if (prefs.voiceName) {
      const preferred = voices.find(v => v.name === prefs.voiceName);
      if (preferred) return preferred;
    }
    return voices.find(v => v.lang==="en-GB") || voices.find(v => v.lang.startsWith("en")) || null;
  };

  // Get a ready-to-play AudioBuffer for `text` in the current Kokoro voice/speed,
  // synthesising (and caching) on a miss.
  const getBuffer = useCallback(async (text) => {
    const prefs = voicePrefsRef.current;
    const voice = prefs.kokoroVoice || DEFAULT_KOKORO_VOICE;
    const speed = prefs.rate ?? 1.0;
    const key = `${voice}|${speed}|${text}`;
    const hit = bufCache.current.get(key);
    if (hit) {
      // Touch (re-insert at the end) so repeatedly-played corner calls stay warm
      // while one-shot AI tips/chat replies age out under the LRU cap below.
      bufCache.current.delete(key);
      bufCache.current.set(key, hit);
      return hit;
    }
    const { audio, sampleRate } = await synthesize(speakable(text), voice, speed);
    const ctx = audioCtx();
    const buf = ctx.createBuffer(1, audio.length, sampleRate);
    buf.copyToChannel(audio, 0);
    bufCache.current.set(key, buf);
    // Bound memory: evict the least-recently-used entries. Novel text (tips, chat)
    // is each unique, so without a cap the decoded-buffer cache grows unbounded.
    const CACHE_CAP = 64;
    while (bufCache.current.size > CACHE_CAP) {
      bufCache.current.delete(bufCache.current.keys().next().value);
    }
    return buf;
  }, []);

  const play = useCallback((item) => {
    const prefs = voicePrefsRef.current;
    stateRef.current.current = item;

    // Finish handler: clear the slot and advance the one pending item (unless stale).
    const onDone = () => {
      if (stateRef.current.current !== item) return; // already preempted
      stateRef.current.current = null;
      stateRef.current.source  = null;
      const next = stateRef.current.queue;
      stateRef.current.queue = null;
      if (next && Date.now() - next.time < 4000) play(next);
    };

    // ── Kokoro path: synth (or cache hit) → play through Web Audio ──
    if (prefs.engine === "kokoro" && isKokoroLoaded()) {
      getBuffer(item.text).then(buf => {
        if (stateRef.current.current !== item) return; // preempted while synthesising
        const ctx = audioCtx();
        if (!ctx) { onDone(); return; }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.onended = onDone;
        stateRef.current.source = src;
        try { src.start(); } catch { onDone(); }
      }).catch(() => onDone());
      return;
    }

    // ── Browser path: Web Speech utterance ──
    if (!window.speechSynthesis) { onDone(); return; }
    const u = new SpeechSynthesisUtterance(speakable(item.text));
    u.rate = prefs.rate ?? 1.1; u.pitch = item.prio >= SPEAK_PRIO.urgent ? 1.25 : 1.0; u.volume = 1;
    const v = pickVoice(); if (v) u.voice = v;
    u.onend = u.onerror = onDone;
    window.speechSynthesis.speak(u);
  }, [getBuffer]);

  // Stop whatever is currently speaking, on either engine.
  const stopCurrent = () => {
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch {}
    const s = stateRef.current.source;
    if (s) { try { s.onended = null; s.stop(); } catch {} stateRef.current.source = null; }
  };

  const speak = useCallback((text, priority="normal") => {
    if (!text) return;
    const now  = Date.now();
    const prio = SPEAK_PRIO[priority] || SPEAK_PRIO.normal;
    const gap  = prio >= SPEAK_PRIO.urgent ? 2000 : 4000;
    if (lastCue.current.text === text && now - lastCue.current.time < gap) return;
    lastCue.current = { text, time: now };

    const item = { text, prio, time: now };
    const st = stateRef.current;
    if (!st.current) { play(item); return; }
    if (prio > st.current.prio) {
      // Higher-priority call wins immediately. Detach the current item first so
      // its stop-triggered onended won't advance the queue, then speak now.
      st.current = null;
      stopCurrent();
      play(item);
      return;
    }
    // Equal/lower priority → hold one pending item, keeping the higher-priority one.
    if (!st.queue || prio > st.queue.prio) st.queue = item;
  }, [play]);

  // Load (download + init) the Kokoro model, surfacing progress to the UI.
  const loadKokoroEngine = useCallback(async () => {
    if (isKokoroLoaded()) { setKokoroStatus("ready"); setKokoroProgress(100); return; }
    setKokoroStatus("loading");
    try {
      await loadKokoro((p) => {
        if (p && typeof p.progress === "number") setKokoroProgress(p.progress);
      });
      setKokoroStatus("ready"); setKokoroProgress(100);
    } catch (e) {
      console.error("Kokoro load failed:", e);
      setKokoroStatus("error");
    }
  }, []);

  // Honor the persisted engine choice on every launch. The model itself lives in a
  // module-level var that resets each session, so a restart must re-load it (fast +
  // offline once the weights are cached) — otherwise speak() falls back to the browser
  // voice until the user manually hits Test. Also fires when the user switches to Kokoro.
  useEffect(() => {
    if (voicePrefs.engine === "kokoro" && !isKokoroLoaded()) {
      loadKokoroEngine();
    }
  }, [voicePrefs.engine, loadKokoroEngine]);

  // Pre-synthesise (and cache) a set of phrases so they play instantly later.
  // Sequential to avoid hammering the model. No-op unless Kokoro is the engine.
  const prewarm = useCallback(async (phrases) => {
    if (voicePrefsRef.current.engine !== "kokoro" || !isKokoroLoaded()) return;
    for (const text of phrases) {
      if (!text) continue;
      try { await getBuffer(text); } catch {}
    }
  }, [getBuffer]);

  // Speak a phrase immediately for the Setup "Test voice" button — bypasses the
  // arbiter and works on whichever engine is selected.
  const preview = useCallback(async (text) => {
    const prefs = voicePrefsRef.current;
    if (prefs.engine === "kokoro") {
      if (!isKokoroLoaded()) await loadKokoroEngine();
      try {
        const buf = await getBuffer(text);
        const ctx = audioCtx();
        const src = ctx.createBufferSource();
        src.buffer = buf; src.connect(ctx.destination); src.start();
      } catch (e) { console.warn("Kokoro preview failed:", e); }
      return;
    }
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(speakable(text));
    u.rate = prefs.rate ?? 1.1;
    const v = pickVoice(); if (v) u.voice = v;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }, [getBuffer, loadKokoroEngine]);

  const beep = useCallback((freq=880, dur=0.12, type="sine") => {
    try {
      const ctx = audioCtx();
      if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type=type; o.frequency.value=freq;
      g.gain.setValueAtTime(0.25, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+dur);
      o.start(); o.stop(ctx.currentTime+dur);
    } catch {}
  }, []);

  return {
    speak, beep, preview,
    kokoro: { status: kokoroStatus, progress: kokoroProgress, load: loadKokoroEngine, prewarm },
  };
}

// ─── LLM ENGINE ───────────────────────────────────────────────────────────────
function providerErr() {
  return "⚠ OpenRouter not reachable — check your API key in the Setup tab";
}

function useLLM(llmConfig) {
  const [thinking,  setThinking]  = useState(false);
  const [lastAdvice, setLastAdvice] = useState(null);
  const lastCallRef = useRef(0);
  const abortRef    = useRef(null);

  // Shared structured-tip pipeline: prompt → provider (JSON) → validate/repair →
  // strip any ungrounded figures. Used by both the on-track tip and the debrief.
  const runTip = useCallback(async (kind, promptCtx, groundCtx, signal) => {
    const provider = createProvider(llmConfig);
    const isDebrief = kind === "debrief";
    const { text, json } = await provider.complete({
      prompt: isDebrief ? buildDebriefPrompt(promptCtx) : buildTipPrompt(promptCtx),
      params: isDebrief ? PARAMS.debrief : PARAMS.tip,
      schema: isDebrief ? DEBRIEF_SCHEMA : COACHING_TIP_SCHEMA,
      signal,
    });
    let result = validateTip(json);
    if (!result.ok) result = repairTip(text);     // weak model returned non-JSON
    if (!result.ok) return null;
    const allowed = collectAllowedNumbers(groundCtx);
    const { text: grounded } = enforceGrounding(result.tip.tip, allowed);
    // The debrief's multi-sentence summary gets the same clean + grounding pass.
    let summary;
    if (isDebrief && json && typeof json.summary === "string") {
      const cleaned = cleanSummary(json.summary);
      const { text: gs } = enforceGrounding(cleaned, allowed);
      summary = gs || undefined;
    }
    return { text: grounded || result.tip.tip, severity: result.tip.severity, summary };
  }, [llmConfig]);

  const ask = useCallback(async (telemetry, refSample, zone, refMeta, evidence) => {
    const now = Date.now();
    if (now - lastCallRef.current < 5000) return; // throttle to once per 5s
    lastCallRef.current = now;

    // Input gate: never coach on stale/empty telemetry.
    if (!telemetryIsUsable(telemetry)) {
      setLastAdvice({ text:"Waiting for telemetry…", time:Date.now(), info:true });
      return null;
    }

    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setThinking(true);
    try {
      const tip = await runTip(
        "tip",
        { telemetry, refSample, zone, refMeta, evidence },
        { telemetry, refSample, evidence },
        ctrl.signal
      );
      if (tip) setLastAdvice({ text:tip.text, severity:tip.severity, time:Date.now(), dist:telemetry.lapDistance, zone:zone?.name });
      return tip?.text || null;
    } catch (e) {
      if (e.name!=="AbortError") setLastAdvice({ text:providerErr(), time:Date.now(), error:true });
      return null;
    } finally {
      setThinking(false);
    }
  }, [llmConfig, runTip]);

  // Between-lap debrief: one improvement tip grounded ONLY in the completed-lap
  // vs reference evidence (the instantaneous point at the line is irrelevant).
  const askLap = useCallback(async (evidence, refMeta, setup) => {
    if (!evidence) return null;
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setThinking(true);
    try {
      const tip = await runTip("debrief", { evidence, refMeta, setup }, { evidence, setup }, ctrl.signal);
      if (tip) setLastAdvice({ text:tip.text, severity:tip.severity, summary:tip.summary, time:Date.now(), lap:true });
      return tip?.text || null;
    } catch (e) {
      if (e.name!=="AbortError") setLastAdvice({ text:providerErr(), time:Date.now(), error:true });
      return null;
    } finally {
      setThinking(false);
    }
  }, [llmConfig, runTip]);

  return { ask, askLap, thinking, lastAdvice };
}

// ─── LAP RECORDER ─────────────────────────────────────────────────────────────
// Records the active telemetry stream into the in-progress lap and freezes a lap
// when lapPct wraps (end of lap → start of next). Frozen laps are normalised to
// the reference-trace sample shape, kept in memory for the live Compare overlay,
// AND persisted to IndexedDB under the active driver (lapStore) so their history +
// dashboard stats survive restarts. Distance-binning (~10 m) keeps a ~90 s / 30 Hz
// lap to a few hundred samples. The user can still export a lap to a file too.

// Idle telemetry reading shown before the live UDP bridge delivers a snapshot.
const EMPTY_TEL = { lapPct:0, lapDistance:0, throttle:0, brake:0, speed:0, gear:1, rpm:0, ersMode:0, ersDeploy:0, ersBattery:0, lapTime:0, currentZone:null, sector2Pct:1/3, sector3Pct:2/3,
  ersHarvestLimit:0, overtakeAvailable:0, overtakeActive:0, overtakeActivationDistance:0, activeAeroMode:0, activeAeroAvailable:0, activeAeroActivationDistance:0, regs2026:0, sessionUid:"0" };

// Cumulative lap-time stamped at each mini-sector boundary: index k = the running
// lap time when the car entered mini-sector k. Slot 0 is the start line (time 0);
// slot MINI_SECTORS is closed at the finish line. mini-sector k's duration is the
// gap between consecutive stamps. Reset at every lap start / driver change.
const freshMiniBound = () => { const a = new Array(MINI_SECTORS + 1).fill(null); a[0] = 0; return a; };

// Average of a 4-wheel array (tyre temps); NaN when absent (old bridge / no data).
const avg4 = (a) => (Array.isArray(a) && a.length === 4) ? (a[0] + a[1] + a[2] + a[3]) / 4 : NaN;

// Map a lap fraction to a mini-sector index using the GAME's real sector boundaries
// (S2/S3 start fractions from the UDP Session packet). Each of the 3 sectors is split
// into MINI_PER_SECTOR equal-distance slices — so a card's slices sum to the game's
// own sector time. Falls back to equal thirds before the boundaries arrive / if bad.
const miniIndexFor = (lapPct, s2, s3) => {
  if (!(s2 > 0 && s2 < s3 && s3 < 1)) { s2 = 1 / 3; s3 = 2 / 3; }
  let sector, lo, hi;
  if (lapPct < s2)      { sector = 0; lo = 0;  hi = s2; }
  else if (lapPct < s3) { sector = 1; lo = s2; hi = s3; }
  else                  { sector = 2; lo = s3; hi = 1;  }
  const span = hi - lo > 1e-6 ? hi - lo : 1;
  const sub = Math.min(MINI_PER_SECTOR - 1, Math.max(0, Math.floor(((lapPct - lo) / span) * MINI_PER_SECTOR)));
  return sector * MINI_PER_SECTOR + sub;
};

function useLapRecorder(tel, trackName, driver, sessionId, sessionType) {
  const [storedLaps, setStoredLaps] = useState([]);
  const bufRef    = useRef({ bins: new Map(), lastPct: null, lastLapTime: 0, lastLapNum: -1, lastDriverStatus: -1, lastS1: 0, lastS2: 0, lastSetup: null, lastTyre: null, tainted: false, invalidated: false, miniBound: freshMiniBound(), miniIdx: 0 });
  const lapNumRef = useRef(0);
  // The sessionId the lap counter is currently scoped to. Lap numbering restarts at 1
  // whenever the drive's session changes (a fresh connection, a manual "Reset Session
  // Laps", or an auto track/mode change), so the readout never shows a running career
  // total like "Lap 24" on the first lap of a new session.
  const lapNumSessionRef = useRef(null);
  // Latest lap-tagging inputs, read inside the per-tick effect without making them
  // dependencies (it already re-runs every telemetry tick). meta.driver names the
  // owner a frozen lap is saved under; sessionId/sessionType tag the drive + mode.
  const metaRef = useRef({ driver, sessionId, sessionType, trackName });
  metaRef.current = { driver, sessionId, sessionType, trackName };

  // Load the active driver's persisted laps when the driver changes, continuing lap
  // numbering from where they left off WITHIN the current session (so a mid-session
  // driver swap doesn't restart at 1 and collide with that session's earlier laps).
  // Any half-recorded lap from the previous driver is dropped so it can't be saved
  // under the new one.
  useEffect(() => {
    let cancelled = false;
    const buf = bufRef.current;
    buf.bins.clear(); buf.lastPct = null; buf.lastLapNum = -1; buf.lastDriverStatus = -1; buf.lastS1 = 0; buf.lastS2 = 0; buf.tainted = false; buf.invalidated = false;
    buf.miniBound = freshMiniBound(); buf.miniIdx = 0;
    if (!driver) { setStoredLaps([]); lapNumRef.current = 0; lapNumSessionRef.current = null; return; }
    lapStore.getLaps(driver).then(laps => {
      if (cancelled) return;
      setStoredLaps(laps);
      const sid = metaRef.current.sessionId;
      lapNumSessionRef.current = sid;
      lapNumRef.current = laps.reduce(
        (m, l) => (l.meta?.sessionId === sid ? Math.max(m, l.lapNumber || 0) : m), 0);
    });
    return () => { cancelled = true; };
  }, [driver]);

  useEffect(() => {
    const { lapDistance, lapPct, lapNumber, throttle, brake, steer, speed, gear, ersMode, ersDeploy, lapTime,
            sector1Time, sector2Time, lastLapTime, driverStatus, pitStatus, lapInvalid,
            setup, tyreVisual, tyreActual, tyreAge, worldX, worldY, worldZ,
            sector2Pct, sector3Pct, overtakeActive, activeAeroMode,
            tyreSurfaceTemps, tyreInnerTemps } = tel;
    if (typeof lapPct !== "number" || !isFinite(lapPct)) return;
    const buf = bufRef.current;

    // Lap completion: lapPct wrapped from the end of a lap back to the start.
    if (buf.lastPct != null && buf.lastPct > 0.85 && lapPct < 0.15) {
      const samples = [...buf.bins.values()].sort((a, b) => a.dist - b.dist);
      // Prefer the game's official just-completed lap time; an out-lap from the pit
      // box reports 0 here (no full lap was timed), which is our cue to drop it.
      const total = (typeof lastLapTime === "number" && lastLapTime > 0)
        ? lastLapTime : (buf.lastLapTime || 0);
      // A "ghost" crossing isn't a real timed lap: the car was on an out-lap / in-lap
      // / in the pits / the lap was flagged invalid (buf.tainted). When the bridge
      // supplies driver/pit status (driverStatus is a number) taint already catches
      // all of those, so we trust it alone. Only an OLDER bridge that omits those
      // signals falls back to the game's lastLapTime==0 (an out-lap from the pit box
      // reports no completed time). That fallback must NOT run when we have status
      // signals: lastLapTime is also 0 on the FIRST genuine flying lap (no prior lap
      // → the field hasn't populated at the line), which would wrongly drop it — the
      // exact bug seen entering Qualifying straight onto a flying lap. total still
      // falls back to buf.lastLapTime below, so the first lap keeps a valid time.
      const hasStatusSignals = typeof driverStatus === "number";
      // Race-start phantom lap: when the car starts BEHIND the S/F line (a standing
      // start, most pronounced at the back of the grid) the game reports lap distance
      // near the end of the lap, so the very first crossing of the line as the race
      // begins looks exactly like a lap "wrap" — but the buffer only spans the short
      // grid-to-line crawl, not a full lap, and its time is a couple of seconds. Left
      // alone it records a ~2 s "Lap 1" that corrupts PBs / best laps. Two independent
      // sanity checks catch it (and any flashback/reset teleport that fakes a wrap):
      //   • the samples cover only a sliver of the lap — a genuine lap starts near the
      //     line (dist ≈ 0) and spans most of the track, this one starts ~90% around;
      //   • the time is far below any real F1 lap (shortest circuits are still ~60 s+).
      // Neither rejects a legitimate lap: the buffer is wiped at each true lap start, so
      // a real lap's earliest sample sits near dist 0 and its time is tens of seconds.
      const minDist = samples.length ? samples[0].dist : 0;
      const maxDist = samples.length ? samples[samples.length - 1].dist : 0;
      const coveredLap = maxDist > 0 && (maxDist - minDist) >= 0.5 * maxDist;
      const tooShort = !(total >= 30); // s — no real F1 lap is this quick
      const ghost = buf.tainted || !coveredLap || tooShort ||
        (!hasStatusSignals && typeof lastLapTime === "number" && !(lastLapTime > 0));
      if (samples.length > 5 && !ghost) {
        const m = metaRef.current;
        // Lap numbers are scoped to the current drive: when the session changes, restart
        // the count at 1 (see lapNumSessionRef) so the first lap of a fresh session reads
        // "Lap 1", not a continuation of the driver's career total.
        if (lapNumSessionRef.current !== m.sessionId) {
          lapNumSessionRef.current = m.sessionId;
          lapNumRef.current = 0;
        }
        lapNumRef.current += 1;
        // S1/S2 are the game's native splits captured just before the line; S3 is
        // the remainder of the total lap time. Null the trio if we never saw splits.
        const s1 = buf.lastS1, s2 = buf.lastS2;
        const sectorTimes = (s1 > 0 && s2 > 0)
          ? [s1, s2, Math.max(0, total - s1 - s2)] : null;
        // Close the final mini-sector at the line and freeze the lap's mini splits
        // (durations between boundary stamps). Null the lot if any slice is missing —
        // a coarse/partial lap shouldn't feed bogus times into the per-mini PBs.
        buf.miniBound[MINI_SECTORS] = total;
        let miniSectors = [];
        for (let k = 0; k < MINI_SECTORS; k++) {
          const a = buf.miniBound[k], c = buf.miniBound[k + 1];
          const d = (a != null && c != null) ? c - a : null;
          if (typeof d !== "number" || !(d > 0)) { miniSectors = null; break; }
          miniSectors.push(d);
        }
        // Sector boundary distances (metres) from the game's S2/S3 start fractions,
        // scaled by this lap's own length (last bin ≤10 m short — negligible). Same
        // shape as imported traces' meta.sectors, so the Telemetry tab's sector
        // lines + zoom get real boundaries for live-recorded laps too.
        const recLapLen = samples.length ? samples[samples.length - 1].dist : 0;
        const sectors = (recLapLen > 0 && sector2Pct > 0 && sector3Pct > sector2Pct && sector3Pct < 1)
          ? [sector2Pct * recLapLen, sector3Pct * recLapLen] : null;
        const lap = {
          id: `lap-${crypto.randomUUID()}`, // UUID, not Date.now(): two laps closed in the same ms would collide

          lapNumber: lapNumRef.current,
          recordedAt: Date.now(),
          lapTime: total,
          invalid: buf.invalidated,     // true → track-limits/corner-cut deleted lap; shown but excluded from bests
          sectorTimes,
          miniSectors,                  // 18 live mini-sector splits → per-mini PBs (LiveScreen)
          source: "live",
          meta: {
            driver: m.driver || "You",
            track: m.trackName || "Live",
            sessionType: m.sessionType || null, // coarse game mode: Time Trial / Qualifying / …
            sessionId: m.sessionId || null,     // the drive this lap belongs to
            ...(sectors ? { sectors } : {}),    // S2/S3 start distances (m) for sector lines/zoom
          },
          setup: buf.lastSetup || null, // the garage setup active while this lap was driven
          tyre: buf.lastTyre || null,   // compound worn on this lap → dry/wet PB split (lib/tyres.js)
          samples,
        };
        setStoredLaps(prev => [...prev, lap]); // persisted history is uncapped per driver
        lapStore.putLap(lap);                  // fire-and-forget; no-op if no driver
      }
      buf.bins.clear();
      buf.lastS1 = 0; buf.lastS2 = 0; buf.tainted = false; buf.invalidated = false;
      buf.miniBound = freshMiniBound(); buf.miniIdx = 0;
    }

    // A new clean lap began with no pct-wrap this tick — the car crossed the line
    // straight onto a fresh lap without a preceding full out-lap (e.g. garage → flying
    // lap on a new Qualifying session). Clear the in-progress buffer + sticky taint so
    // the new lap records clean; without this the garage/pit taint would leak into the
    // first flying lap and drop it.
    //
    // Two triggers, both keyed to the true lap-start boundary:
    //   • lapNumber advanced (needs a prior lap: lastLapNum >= 0), OR
    //   • driverStatus rose into a clean driving state (flying lap 1 / on track 4) from
    //     a dirty one (garage 0 / in-lap 2 / out-lap 3, or the -1 seed), AND the car is
    //     near the lap start. The lap-start gate matters: a dirty→clean edge can also
    //     land mid-lap (e.g. a pit entry armed then cancelled flips in-lap → flying),
    //     and wiping the buffer + taint there would record a pit-excursion lap as a
    //     clean partial lap. At a true S/F-line start it needs NO prior lap, so it
    //     fixes the FIRST flying lap of a session — the lapNumber-advance heuristic
    //     alone missed it because the garage→flying teleport can skip the increment
    //     we'd need to see. On this tick driverStatus is already clean, so the
    //     taint-set block below won't re-taint it.
    // No-op when lapNumber is absent/static (idle EMPTY_TEL, replays) or on a normal
    // completion (the wrap block above already saved + reset that boundary).
    const wrapped = buf.lastPct != null && buf.lastPct > 0.85 && lapPct < 0.15;
    const cleanNow = driverStatus === 1 || driverStatus === 4; // flying lap / on track
    const wasDirty = buf.lastDriverStatus === 0 || buf.lastDriverStatus === 2 ||
                     buf.lastDriverStatus === 3 || buf.lastDriverStatus === -1;
    const enteredCleanLap = cleanNow && wasDirty && lapPct < 0.15;
    if (typeof lapNumber === "number") {
      if (!wrapped &&
          ((lapNumber > buf.lastLapNum && buf.lastLapNum >= 0) || enteredCleanLap)) {
        buf.bins.clear();
        buf.lastS1 = 0; buf.lastS2 = 0; buf.tainted = false; buf.invalidated = false;
        buf.miniBound = freshMiniBound(); buf.miniIdx = 0;
      }
      buf.lastLapNum = lapNumber;
    }
    if (typeof driverStatus === "number") buf.lastDriverStatus = driverStatus;

    // Taint the in-progress lap the moment the game tells us it isn't a real timed
    // lap — out-lap (3) / in-lap (2) / in garage (0) or any pit-lane activity. These
    // are dropped entirely. Sticky for the whole lap; cleared when the lap freezes.
    if (driverStatus === 0 || driverStatus === 2 || driverStatus === 3 ||
        (typeof pitStatus === "number" && pitStatus !== 0)) {
      buf.tainted = true;
    }
    // A game-invalidated flying lap (track limits / corner cut) is still fully timed —
    // keep it, but flag it so the UI can label it and the bests can exclude it. Sticky
    // for the whole lap; cleared alongside taint when the lap freezes.
    if (lapInvalid) buf.invalidated = true;

    buf.lastPct = lapPct;
    if (typeof lapTime === "number" && lapTime > 0) buf.lastLapTime = lapTime;
    // Stamp the running lap time as the car crosses each mini-sector boundary. The
    // index comes from the game's real sector boundaries (S2/S3 start fractions), each
    // sector split into MINI_PER_SECTOR equal slices. Stamp every boundary newly
    // passed this tick (≥2 only on a coarse stream).
    if (typeof lapTime === "number" && lapTime > 0) {
      const cur = miniIndexFor(lapPct, sector2Pct, sector3Pct);
      for (let k = buf.miniIdx + 1; k <= cur; k++) {
        if (buf.miniBound[k] == null) buf.miniBound[k] = lapTime;
      }
      if (cur > buf.miniIdx) buf.miniIdx = cur;
    }
    if (typeof sector1Time === "number" && sector1Time > 0) buf.lastS1 = sector1Time;
    if (typeof sector2Time === "number" && sector2Time > 0) buf.lastS2 = sector2Time;
    if (setup) buf.lastSetup = setup;
    // Tyre compound worn during the lap — captured live so the frozen lap records
    // the rubber it was actually set on (a wet/inter lap stays out of the dry PB).
    if (typeof tyreVisual === "number" && tyreVisual >= 0) {
      buf.lastTyre = { visual: tyreVisual, actual: tyreActual ?? -1, age: tyreAge ?? 0 };
    }
    if (typeof lapDistance === "number" && isFinite(lapDistance)) {
      // x/z (world position) let a lap draw its OWN track-map outline on the Compare
      // screen; absent for laps recorded before motion data arrived → map falls back
      // to the shared session outline. Keys match buildTrackMapGeometry's expectation.
      const bin = { dist: lapDistance, throttle, brake, steer, speed, gear, ersMode, ersSpent: ersDeploy,
        boost: overtakeActive ? 1 : 0, aeroMode: activeAeroMode ?? 0 }; // 2026: boost deploy + active-aero wing mode per sample
      // Averaged tyre temps (°C) — surface + carcass worms on the Telemetry tab.
      // >0 guards both a missing field (NaN) and the all-zeros no-data case.
      const tSurf = avg4(tyreSurfaceTemps), tCarc = avg4(tyreInnerTemps);
      if (tSurf > 0) bin.tyreSurf = Math.round(tSurf);
      if (tCarc > 0) bin.tyreCarc = Math.round(tCarc);
      if (typeof worldX === "number" && typeof worldZ === "number" && isFinite(worldX) && isFinite(worldZ)) {
        bin.x = worldX; bin.z = worldZ;
        if (typeof worldY === "number" && isFinite(worldY)) bin.y = worldY; // elevation → 3D view
      }
      buf.bins.set(Math.round(lapDistance / 10), bin);
    }
  }, [tel, trackName]);

  // Render-friendly snapshot of the in-progress lap, refreshed each telemetry tick.
  const currentLap = useMemo(() => ({
    samples: [...bufRef.current.bins.values()].sort((a, b) => a.dist - b.dist),
  }), [tel.lapDistance, storedLaps]);

  // Live mini-sector progress for the Live screen's S1/S2/S3 cards: each slice's
  // duration once the car has cleared it (null while ahead/un-driven), plus the slice
  // being driven now and the tyre worn — so the UI can colour past slices against the
  // per-mini PBs and pulse the current one. One tick behind (the buffer is stamped in
  // the effect, read here on the next render), imperceptible at telemetry rates.
  const liveMini = useMemo(() => {
    const b = bufRef.current;
    const durations = [];
    for (let m = 0; m < MINI_SECTORS; m++) {
      const a = b.miniBound[m], c = b.miniBound[m + 1];
      durations.push((a != null && c != null && c > a) ? c - a : null);
    }
    const driving = typeof tel.lapTime === "number" && tel.lapTime > 0;
    return { durations, current: driving ? b.miniIdx : -1, tyre: b.lastTyre };
  }, [tel.lapPct, tel.lapTime, storedLaps]);

  const deleteLap = useCallback(id => {
    setStoredLaps(prev => prev.filter(l => l.id !== id));
    lapStore.deleteLap(id);
  }, []);
  // Archive every loaded lap: mark it hidden from the live Session-Laps view but
  // keep it in memory AND in IndexedDB (archived) so history, trends and the
  // dashboard still count it. Backs "Reset Session Laps" so a cleared panel STAYS
  // cleared across restarts — a fresh sessionId alone only hid them until relaunch.
  const archiveSessionLaps = useCallback(() => {
    setStoredLaps(prev => prev.map(l => (l.archived ? l : { ...l, archived: true })));
    const d = metaRef.current.driver;
    if (d) lapStore.archiveLaps(d);
  }, []);

  // Merge a loaded session's laps into memory so they show in the Session Laps
  // panel + Compare/Analytics. In-memory ONLY — not written to IndexedDB, so a
  // reviewed session never pollutes the driver's persisted history / PBs, and a
  // driver switch or restart clears it (the saved file is the durable copy). The
  // caller re-tags each lap with a fresh id + the active sessionId first.
  const loadSessionLaps = useCallback((laps) => {
    if (!Array.isArray(laps) || !laps.length) return;
    setStoredLaps(prev => [...prev, ...laps]);
  }, []);

  // Re-read the active driver's persisted laps from IndexedDB. The driver-change
  // effect above already does this on a switch; this covers writes made OUTSIDE
  // the recorder (a profile import) that land under the CURRENT driver, where the
  // driver dep hasn't changed so that effect wouldn't fire.
  const reloadLaps = useCallback(() => {
    const d = metaRef.current.driver;
    if (!d) { setStoredLaps([]); return; }
    lapStore.getLaps(d).then(setStoredLaps).catch(() => {});
  }, []);

  return { currentLap, liveMini, storedLaps, deleteLap, archiveSessionLaps, loadSessionLaps, reloadLaps };
}

// ─── TRACK MAP ────────────────────────────────────────────────────────────────
// Project a world-position path into screen space and colour each segment via a
// caller-supplied colorAt(point, i) so the same projection drives the zone-coloured
// dashboard map AND the telemetry-coloured Compare maps. `path` points carry x/z
// (required) plus whatever fields colorAt reads (pct, throttle, brake, …).
function buildMapGeometry(path, W, H, colorAt) {
  const xs = path.map(p => p.x), zs = path.map(p => p.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const dataW = (maxX - minX) || 1, dataH = (maxZ - minZ) || 1;
  const pad = 18;
  const scale = Math.min((W - 2 * pad) / dataW, (H - 2 * pad) / dataH);
  const offX = (W - dataW * scale) / 2, offY = (H - dataH * scale) / 2;
  // Flip Z so increasing Z draws upward (more map-like).
  const proj = (x, z) => [offX + (x - minX) * scale, offY + (maxZ - z) * scale];

  const screen = path.map(p => ({ src: p, xy: proj(p.x, p.z) }));
  const segs = [];
  for (let i = 0; i < screen.length - 1; i++) {
    segs.push({ a: screen[i].xy, b: screen[i + 1].xy, color: colorAt(screen[i].src, i) });
  }
  const outline = "M " + screen.map(p => p.xy.join(",")).join(" L ");
  return { proj, segs, outline };
}

// Dashboard map: colour each segment by the strategy zone it falls in, honouring the
// LIVE granular filters (legendKeyFor keys). A false category neutralises that zone's
// colour (ZONE_OFF_COLOR). Un-cued segments use the "normal" toggle: false hides them
// (returns null → the segment isn't drawn, leaving just the outline). Omitted/
// undefined filters → everything coloured.
function buildTrackMapGeometry(recordedPath, zones, W, H, filters) {
  return buildMapGeometry(recordedPath, W, H, (p) => {
    const zone = zones.find(z => p.pct >= z.start && p.pct <= z.end);
    if (!zone) return filters?.normal === false ? null : ZONE_OFF_COLOR;
    const shown = !filters || filters[legendKeyFor(zone)] !== false;
    return shown ? zoneFill(zone) : ZONE_OFF_COLOR;
  });
}

// Colour a segment from a single lap's own telemetry sample (Compare maps). Honours
// the per-category filters; "normal" stretches stay neutral.
function lapSampleColor(sample, hasBrake, filters) {
  const z = classifySample(sample, hasBrake);
  if (z.type === "normal") return ZONE_OFF_COLOR;
  if (filters && filters[filterKeyForZone(z)] === false) return ZONE_OFF_COLOR;
  return zoneFill(z);
}

// Build a Compare-screen map for ONE lap, coloured by that lap's actual telemetry.
//   • Lap carries its own world positions (≥20 x/z samples) → draw its own outline,
//     colouring each segment from the sample at that point (direct 1:1).
//   • Otherwise (calibrator reference JSON, or a lap recorded before motion data) →
//     borrow `sessionPath`'s outline and colour each point by the nearest lap sample
//     aligned by FRACTION of the lap (lap lengths differ, so not absolute metres).
// Returns { proj, segs, outline, source } or null when no geometry is available.
function buildLapMapGeometry(lap, sessionPath, W, H, filters) {
  const samples = lap?.samples || [];
  if (samples.length < 2) return null;
  const hasBrake = samples.some(s => typeof s.brake === "number");
  const ownGeo = samples.filter(s => typeof s.x === "number" && typeof s.z === "number"
    && isFinite(s.x) && isFinite(s.z));

  if (ownGeo.length >= 20) {
    return { ...buildMapGeometry(ownGeo, W, H, (p) => lapSampleColor(p, hasBrake, filters)), source: "own" };
  }
  if (sessionPath && sessionPath.length >= 20) {
    const lapLen = samples.reduce((m, s) => Math.max(m, s.dist || 0), 0) || 1;
    const fracs = samples.map(s => (s.dist || 0) / lapLen);
    const nearest = (pct) => {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < fracs.length; i++) {
        const d = Math.abs(fracs[i] - pct);
        if (d < bestD) { bestD = d; best = i; }
      }
      return samples[best];
    };
    return { ...buildMapGeometry(sessionPath, W, H, (p) => lapSampleColor(nearest(p.pct ?? 0), hasBrake, filters)), source: "borrowed" };
  }
  return null;
}

// ─── DRIVING-LINE GEOMETRY (Driving Lines tab) ────────────────────────────────
// A lap is "drawable" as a racing line only when it carries its own world positions
// (≥20 finite x/z samples) — same bar as buildLapMapGeometry's "own" branch. Calibrator
// reference JSON has no x/z, so it has no spatial line and is skipped here.
function lapHasLine(lap) {
  const s = lap?.samples;
  if (!Array.isArray(s)) return false;
  let n = 0;
  for (const p of s) if (typeof p.x === "number" && typeof p.z === "number" && isFinite(p.x) && isFinite(p.z)) { if (++n >= 20) return true; }
  return false;
}

// Build per-lap racing lines for the 3D scene (Driving Lines tab). For each drawable lap
// (≥20 own x/z samples) returns its captured WORLD points plus the two addressing curves
// the timeline uses: distAt (lap-fraction → position-sync) and timeAt (a normalised
// Δdist÷speed time integral → pace-sync). The 3D scene (lib/trackScene3d.js) centres and
// renders these; the timeline reads distAt/timeAt to place its arrows. `laps` is an array
// of { id, label, lap, color }; undrawable laps are dropped. Returns [] when none qualify.
function buildLines3D(laps) {
  const out = [];
  for (const d of laps || []) {
    if (!lapHasLine(d.lap)) continue;
    const pts = d.lap.samples
      .filter(s => typeof s.x === "number" && typeof s.z === "number" && isFinite(s.x) && isFinite(s.z))
      .sort((a, b) => (a.dist || 0) - (b.dist || 0))
      .map(s => ({
        x: s.x, z: s.z,
        y: (typeof s.y === "number" && isFinite(s.y)) ? s.y : undefined,
        dist: s.dist || 0, speed: s.speed || 0, throttle: s.throttle || 0,
      }));
    const lapLen = pts.reduce((m, p) => Math.max(m, p.dist), 0) || 1;
    const distAt = pts.map(p => p.dist / lapLen);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      const dd = Math.max(0, pts[i].dist - pts[i - 1].dist);
      const v = Math.max(pts[i].speed / 3.6, 1); // km/h → m/s, floor 1
      cum[i] = cum[i - 1] + dd / v;
    }
    const total = cum[cum.length - 1] || 1;
    const timeAt = cum.map(t => t / total);
    out.push({ id: d.id, label: d.label, color: d.color, pts, distAt, timeAt, timeTotal: total });
  }
  attachPaceCurves(out);
  return out;
}

// Pace curves for the 3D scene's pace-sync mode. Playback runs on ONE shared clock — the
// anchor (driven) lap's track-distance fraction. Each other line gets an addressing array
// in that same anchor-distance space, holding the distance the line had reached at the SAME
// ELAPSED TIME as the anchor. Sampling every car at the shared clock then places them at a
// single wall-clock instant, so a faster car runs ahead and reaches the line first — the
// real time gap builds instead of both cars finishing together. The anchor maps to itself
// (identity). Mutates each line, adding `paceAt`.
function attachPaceCurves(lines) {
  const anchor = lines.find(l => l.id === "comp")
    || lines.reduce((b, l) => (!b || l.pts.length > b.pts.length ? l : b), null);
  if (!anchor) return;
  for (const l of lines) {
    if (l === anchor || !(anchor.timeTotal > 0)) { l.paceAt = l.distAt; continue; }
    // Line sample i is at elapsed time (timeAt[i]·timeTotal) s; find the anchor's distance
    // fraction at that same elapsed time. Monotonic in i → a valid addressing curve.
    l.paceAt = l.timeAt.map((tf) =>
      clamp(timeFracToDistFrac(anchor, (tf * l.timeTotal) / anchor.timeTotal), 0, 1));
  }
}

// Render outline + coloured segments + a colour legend to a 2×-scaled canvas and
// download it as PNG or JPG. Shared by the dashboard map and the Compare maps so the
// exported image matches what's on screen. Dark background is filled first, so JPG
// (no alpha) comes out opaque.
function exportMapImage({ segs, outline, filters, legend = MAP_LEGEND, name, format = "png", W = 240, H = 240 }) {
  if (!segs || !outline) return;
  const S = 2, legendH = 34;
  const canvas = document.createElement("canvas");
  canvas.width = W * S; canvas.height = (H + legendH) * S;
  const ctx = canvas.getContext("2d");
  ctx.scale(S, S);

  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, W, H + legendH);

  ctx.lineJoin = "round"; ctx.lineCap = "round";
  const path = new Path2D(outline);
  ctx.strokeStyle = "#111"; ctx.lineWidth = 10; ctx.stroke(path);

  ctx.globalAlpha = 0.9; ctx.lineWidth = 6;
  for (const s of segs) {
    if (!s.color) continue; // hidden segment (e.g. "None" toggled off)
    ctx.strokeStyle = s.color;
    ctx.beginPath(); ctx.moveTo(s.a[0], s.a[1]); ctx.lineTo(s.b[0], s.b[1]); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const items = legend.filter(([, , key]) => key == null || !filters || filters[key] !== false);
  ctx.font = "9px system-ui, sans-serif"; ctx.textBaseline = "middle";
  let lx = 8; const ly = H + legendH / 2;
  for (const [c, l] of items) {
    ctx.fillStyle = c; ctx.fillRect(lx, ly - 4, 8, 8);
    ctx.fillStyle = "#888"; ctx.fillText(l, lx + 11, ly);
    lx += 11 + ctx.measureText(l).width + 12;
  }

  const jpg = format === "jpg" || format === "jpeg";
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safe = (name || "live").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    a.href = url; a.download = `f1-trackmap-${safe}.${jpg ? "jpg" : "png"}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, jpg ? "image/jpeg" : "image/png", 0.92);
}

function TrackMap({ telemetry, zones, recordedPath, filters, corners=[], W=280, H=280, fill=false }) {
  // When we have enough world-position samples — either a saved outline or the
  // current drive's accumulated path — draw the ACTUAL circuit; otherwise show a
  // plain placeholder until the first lap maps the track.
  const useReal = recordedPath && recordedPath.length >= 20;

  // Geometry is memoised on bin COUNT (not array identity) so the expensive
  // outline/segment build only reruns when a new ~12 m bin lands — not on every
  // 30 Hz telemetry tick. The live car dot below stays at full rate (it reads
  // proj + telemetry.worldX outside the memo). Mirrors LapTrackMap's approach.
  const geo = useMemo(
    () => (useReal ? buildTrackMapGeometry(recordedPath, zones, W, H, filters) : null),
    [useReal, recordedPath?.length, zones, filters, W, H] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Real-world corner markers ("T1 – Abbey"), each placed at the recorded path
  // point nearest its apex fraction, then projected into screen space. Recomputed
  // only when the geometry rebuilds (not per telemetry tick).
  const cornerMarks = useMemo(() => {
    if (!geo || !recordedPath?.length || !corners?.length) return [];
    return corners.map((c) => {
      let best = recordedPath[0], bestD = Infinity;
      for (const p of recordedPath) {
        const d = Math.abs((p.pct ?? 0) - c.f);
        if (d < bestD) { bestD = d; best = p; }
      }
      const [x, y] = geo.proj(best.x, best.z);
      return { x, y, label: cornerLabel(c) };
    });
  }, [geo, recordedPath?.length, corners]); // eslint-disable-line react-hooks/exhaustive-deps

  if (useReal && geo) {
    const { proj, segs, outline } = geo;

    const car = (typeof telemetry.worldX === "number" && typeof telemetry.worldZ === "number")
      ? proj(telemetry.worldX, telemetry.worldZ) : null;

    return (
      <svg width={fill?"100%":W} height={fill?"100%":H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ display: "block", ...(fill?{width:"100%",height:"100%"}:null) }}>
        <path d={outline} fill="none" stroke="#111" strokeWidth={10} strokeLinejoin="round" strokeLinecap="round" />
        {segs.map((s, i) => (
          s.color ? (
            <line key={i} x1={s.a[0]} y1={s.a[1]} x2={s.b[0]} y2={s.b[1]}
              stroke={s.color} strokeWidth={6} strokeLinecap="round" opacity={0.9} />
          ) : null
        ))}
        {cornerMarks.map((m, i) => (
          <g key={i} pointerEvents="none">
            <circle cx={m.x} cy={m.y} r={4} fill="#0b0e14" stroke="#5b6b8c" strokeWidth={1.5} />
            <text x={m.x + 7} y={m.y + 3} fill="#aeb8cc" fontSize={11} fontWeight={700}
              style={{ fontFamily: "inherit" }}>{m.label}</text>
          </g>
        ))}
        {car && (
          <>
            <circle cx={car[0]} cy={car[1]} r={8} fill="#111" stroke={getThrottleColor(telemetry.throttle)} strokeWidth={3} />
            <circle cx={car[0]} cy={car[1]} r={3} fill="#fff" />
          </>
        )}
      </svg>
    );
  }

  // ── Placeholder: no saved outline yet and the first lap hasn't been mapped ──
  return (
    <svg width={fill?"100%":W} height={fill?"100%":H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ display: "block", ...(fill?{width:"100%",height:"100%"}:null) }}>
      <text x={W/2} y={H/2 - 10} textAnchor="middle" dominantBaseline="middle"
        fill="#2a2a2a" fontSize={16} letterSpacing={3}
        style={{ textTransform: "uppercase", fontFamily: "inherit", fontWeight: 700 }}>
        Track Map
      </text>
      <text x={W/2} y={H/2 + 14} textAnchor="middle" dominantBaseline="middle"
        fill="#222831" fontSize={11} letterSpacing={1}
        style={{ fontFamily: "inherit", fontWeight: 600 }}>
        Drive a lap to map this circuit
      </text>
    </svg>
  );
}

// ─── COMPARE TRACK MAPS ───────────────────────────────────────────────────────
// One lap drawn as a circuit map, colour-coded by THAT lap's own brake/lift-&-coast/
// ERS-mode telemetry (see buildLapMapGeometry). Used side-by-side on the Compare
// screen so the driver can see where their lap differs from the reference. Geometry
// is memoised on sample count (not identity) so a growing live lap only rebuilds when
// a new ~10 m bin lands, not on every telemetry tick.
const saveMapBtn = {
  marginLeft:"auto", display:"inline-flex", alignItems:"center", gap:6, padding:0, background:"none",
  border:"none", cursor:"pointer", fontSize:9, letterSpacing:1.5, textTransform:"uppercase", fontWeight:700,
  color:"#8b94a8", fontFamily:"inherit",
};

// One lap drawn as a full-width circuit map filling its card, coloured by that lap's
// own telemetry. Matches the cockpit ERS/Lico design: a dot+label header (with an
// optional "Save map" action), then a #0d1119 map body with the grey track base +
// per-channel coloured overlay + (on the driven side) the live car dot.
function LapTrackMap({ lap, sessionPath, filters, dotLabel, name, telemetry, onSave, W=1000, H=720 }) {
  const geo = useMemo(
    () => buildLapMapGeometry(lap, sessionPath, W, H, filters),
    [lap?.id, lap?.samples?.length, sessionPath, filters, W, H] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const car = (telemetry && geo && typeof telemetry.worldX === "number" && typeof telemetry.worldZ === "number")
    ? geo.proj(telemetry.worldX, telemetry.worldZ) : null;

  return (
    <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column"}}>
      <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:6,flex:"none"}}>
        <span style={{width:8,height:8,borderRadius:"50%",background:"#6b7488",flex:"none"}} />
        <span style={{fontSize:9,letterSpacing:1.5,color:"#8b94a8",textTransform:"uppercase",fontWeight:700,
          whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{dotLabel}</span>
        {onSave && geo && (
          <button onClick={()=>onSave(geo)} title="Save this map as a PNG" style={saveMapBtn}>
            <span style={{width:5,height:5,borderRadius:"50%",background:"#34c8ff",flex:"none"}} /> Save map
          </button>
        )}
      </div>
      <div style={{flex:1,minHeight:0,position:"relative",background:"var(--panel)",border:"1px solid var(--line)",borderRadius:9}}>
        {geo ? (
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{position:"absolute",inset:0,width:"100%",height:"100%"}}>
            <path d={geo.outline} fill="none" stroke="#1e2533" strokeWidth={26} strokeLinejoin="round" strokeLinecap="round" />
            <path d={geo.outline} fill="none" stroke="#10141c" strokeWidth={16} strokeLinejoin="round" strokeLinecap="round" />
            {geo.segs.map((s,i)=>(
              <line key={i} x1={s.a[0]} y1={s.a[1]} x2={s.b[0]} y2={s.b[1]}
                stroke={s.color} strokeWidth={10} strokeLinecap="round" />
            ))}
            {car && <circle cx={car[0]} cy={car[1]} r={14} fill="#3671C6" stroke="#fff" strokeWidth={4} />}
          </svg>
        ) : (
          <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",
            textAlign:"center",padding:16,color:"var(--text-faintest)",fontSize:11,lineHeight:1.5}}>
            No track shape yet — drive a lap on this circuit to build the map
          </div>
        )}
      </div>
    </div>
  );
}

// Side-by-side reference vs comparison maps, with shared colour-category toggles and a
// legend. Each map is coloured from its own lap's telemetry; the outline comes from a
// lap's own world positions when present, else the live session's recorded outline.
function CompareTrackMaps({ referenceLap, comparisonLap, referenceLabel, comparisonLabel,
  sessionPath, trackName, telemetry }) {
  const [mapFilters, setMapFilters] = useState({ brake:true, lico:true, ers:true });
  const safeTrack = (trackName || "live");
  const save = (geo) => exportMapImage({ segs:geo.segs, outline:geo.outline, filters:mapFilters,
    name:`you-${safeTrack}`, format:"png", W:1000, H:720 });

  return (
    <div style={{flex:1,minHeight:0,display:"flex",flexDirection:"column"}}>
      {/* Header: title + colour-category legend chips */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,marginBottom:10,flexWrap:"wrap"}}>
        <span style={{fontSize:10,letterSpacing:2,color:"#8b94a8",textTransform:"uppercase",fontWeight:600}}>ERS Deployment &amp; Lico Map</span>
        <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
          {MAP_FILTER_ITEMS.map(it => {
            const on = mapFilters[it.key];
            const c = ZONE_COLORS[it.key];
            return (
              <button key={it.key} onClick={()=>setMapFilters(f=>({...f,[it.key]:!f[it.key]}))}
                title={on?`Hide ${it.label} on maps`:`Show ${it.label} on maps`}
                style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",borderRadius:8,cursor:"pointer",fontFamily:"inherit",
                  background:on?"var(--panel)":"transparent",border:`1px solid ${on?c+"66":"var(--line)"}`,opacity:on?1:0.5,transition:"all .12s"}}>
                <span style={{width:12,height:12,borderRadius:3,flex:"none",background:on?c:"transparent",
                  border:`1.5px solid ${c}`,boxShadow:on?`0 0 7px ${c}88`:"none"}} />
                <span style={{fontSize:11,fontWeight:600,letterSpacing:.3,color:on?"#cfd6e6":"#6b7488"}}>{it.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* The two maps, side by side, filling the card */}
      <div style={{flex:1,minHeight:0,display:"flex",gap:14}}>
        <LapTrackMap lap={referenceLap} sessionPath={sessionPath} filters={mapFilters}
          dotLabel={`Reference · ${referenceLabel}`} name={`ref-${safeTrack}`} />
        <LapTrackMap lap={comparisonLap} sessionPath={sessionPath} filters={mapFilters}
          dotLabel={`Driven · ${comparisonLabel}`} name={`you-${safeTrack}`} telemetry={telemetry} onSave={save} />
      </div>
    </div>
  );
}

// ─── COMPARE DRIVING LINES ────────────────────────────────────────────────────
// Both laps' racing lines overlaid on one shared circuit map, with a car driven along
// each line. A scrubbable timeline above carries corner ticks; Play animates both cars.
// Only laps that carry their own world positions get a line + car (calibrator references
// have no x/z — their car is hidden with a note). Playback runs on one shared clock — the
// anchor (driven) lap's track-distance fraction:
//   • Position-sync — both cars sit at that same track-distance fraction → aligned in space
//     for line/apex comparison.
//   • Pace-sync — the other car is placed at the distance IT had reached at the same elapsed
//     time (via its pace curve), so the faster car runs ahead and reaches the line first —
//     the time gap builds instead of both cars finishing together.
const DL_COMP_COLOR = "#34c8ff";   // cyan — driven / comparison lap (cockpit token)
const DL_REF_COLOR  = "#b45bff";   // purple — reference / benchmark lap (cockpit token)

function CompareDrivingLines({ referenceLap, comparisonLap, referenceLabel, comparisonLabel,
  sessionPath, trackName, trackSlug = null, zones = [] }) {
  const [playhead, setPlayhead] = useState(0);     // 0–1 global clock
  const [playing, setPlaying]   = useState(false);
  const [syncMode, setSyncMode] = useState("pos"); // "pos" | "pace"
  const [speed, setSpeed]       = useState(1);
  const [loop, setLoop]         = useState(true);
  const [camMode, setCamMode]   = useState("chase");
  // Real-circuit track model: null = still resolving, false = no lines to fit,
  // else the model from trackGeometry (status "real" or "fallback").
  const [trackModel, setTrackModel] = useState(null);

  // Captured world-space racing lines for whichever selected laps have position data.
  const lines3D = useMemo(
    () => buildLines3D([
      { id: "comp", label: comparisonLabel, lap: comparisonLap, color: DL_COMP_COLOR },
      { id: "ref",  label: referenceLabel,  lap: referenceLap,  color: DL_REF_COLOR },
    ]),
    [comparisonLap?.id, comparisonLap?.samples?.length, referenceLap?.id,
     referenceLap?.samples?.length, comparisonLabel, referenceLabel] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const compLine = lines3D.find(l => l.id === "comp") || null;
  const refLine  = lines3D.find(l => l.id === "ref")  || null;

  // Which selected laps couldn't be drawn (chosen but no position data).
  const hidden = [];
  if (comparisonLap && !compLine) hidden.push(comparisonLabel);
  if (referenceLap && !refLine)   hidden.push(referenceLabel);

  // Sector bands for the timeline. Every lap has three sectors; use the lap's own splits
  // (game-native sector times) mapped onto track-distance fractions via its time→distance
  // curve, falling back to even thirds when a lap has no recorded splits.
  const sectors = useMemo(() => {
    // Each split is a TIME, mapped onto the timeline (a DISTANCE axis) through a lap's own
    // time→distance curve — so pair the split lap with ITS OWN line, not just whichever line
    // exists. Prefer a lap that has both splits and a drawable line; fall back gracefully.
    const cands = [{ lap: comparisonLap, line: compLine }, { lap: referenceLap, line: refLine }];
    const paired = cands.find(c => c.lap?.sectorTimes && c.line)
                || cands.find(c => c.lap?.sectorTimes);
    const splitLap = paired?.lap || null;
    const line = paired?.line || compLine || refLine;
    let b1 = 1 / 3, b2 = 2 / 3; // default: even thirds by distance
    if (splitLap && line) {
      const [s1, s2] = splitLap.sectorTimes;
      const total = splitLap.lapTime || splitLap.sectorTimes.reduce((a, b) => a + b, 0);
      if (total > 0 && s1 > 0 && s2 > 0) {
        b1 = timeFracToDistFrac(line, s1 / total);
        b2 = timeFracToDistFrac(line, (s1 + s2) / total);
      }
    }
    return [
      { name: "S1", start: 0,  end: b1 },
      { name: "S2", start: b1, end: b2 },
      { name: "S3", start: b2, end: 1 },
    ];
  }, [comparisonLap?.id, referenceLap?.id, lines3D]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lap duration for the clock — comparison lap's time, else reference, else ~90 s.
  const lapDur = (comparisonLap?.lapTime || referenceLap?.lapTime || 90);
  const axis = syncMode === "pace" ? "time" : "dist";

  // Corner ticks on the scrubber + the 3D corner-name overlay come from the brake
  // strategy zones, placed by their lap-distance fraction.
  const corners = useMemo(() =>
    (zones || []).filter((z) => z.type === "brake")
      .map((z) => ({ f: clamp((z.start + z.end) / 2, 0, 1), name: z.name }))
      .sort((a, b) => a.f - b.f), [zones]);
  const cornerName = corners.length
    ? corners.reduce((b, c) => (Math.abs(c.f - playhead) < Math.abs(b.f - playhead) ? c : b), corners[0]).name
    : "";

  // ── Track model: real circuit geometry fitted to the recorded lines ──────────
  // Resolved before the scene builds so the road is right on first render. The slug
  // comes from live telemetry (trackId) when available, else from the track name
  // (covers imported-trace sessions). loadTrackModel caches per slug + line set and
  // falls back to a curvature-heuristic road on any miss, so this resolves fast.
  const slug = trackSlug || resolveSlug(trackName);
  useEffect(() => {
    if (!lines3D.length) { setTrackModel(false); return; }
    let live = true;
    setTrackModel(null);
    import("./lib/trackGeometry.js")
      .then((m) => m.loadTrackModel(slug, lines3D))
      .then((model) => { if (live) setTrackModel(model || false); })
      .catch(() => { if (live) setTrackModel(false); });
    return () => { live = false; };
  }, [lines3D, slug]);

  // ── 3D scene lifecycle ──────────────────────────────────────────────────────
  const canvasRef = useRef(null);
  const sceneRef  = useRef(null);
  // (Re)build the scene whenever the drawable lines or the track model change; waits
  // for the model so the road appears fully formed. Stored laps have a stable sample
  // count so this runs once; a growing live lap rebuilds as it lengthens.
  useEffect(() => {
    if (!canvasRef.current || !lines3D.length || trackModel === null) { sceneRef.current = null; return; }
    let cancelled = false, ctrl = null, ro = null;
    // three.js is heavy and only needed on this tab — code-split it out of startup
    // via a dynamic import; build the scene once the module resolves.
    import("./lib/trackScene3d.js").then(({ createTrackScene }) => {
      if (cancelled || !canvasRef.current) return;
      ctrl = createTrackScene(canvasRef.current, lines3D, { camMode, track: trackModel || null });
      sceneRef.current = ctrl;
      ctrl.setPlayback(playhead, axis); // late-loaded scene starts at the current playhead
      ro = new ResizeObserver(() => ctrl.resize());
      ro.observe(canvasRef.current);
    });
    return () => {
      cancelled = true;
      if (ro) ro.disconnect();
      if (ctrl) ctrl.dispose();
      sceneRef.current = null;
    };
  }, [lines3D, trackModel]); // eslint-disable-line react-hooks/exhaustive-deps

  // Push the current playback fraction to the scene's own render loop.
  useEffect(() => { sceneRef.current?.setPlayback(playhead, axis); }, [playhead, axis]);

  // rAF playback loop — advance the global clock while playing.
  const rafRef = useRef(0);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const tick = (now) => {
      const dt = (now - last) / 1000; last = now;
      let ended = false;
      setPlayhead(p => {
        let next = p + (dt * speed) / lapDur;
        if (next >= 1) { if (loop) next = next % 1; else { next = 1; ended = true; } }
        return next;
      });
      // Stop OUTSIDE the updater (updaters must stay pure — StrictMode double-invokes them).
      // At the end without loop, park at 1 and don't reschedule.
      if (ended) { setPlaying(false); return; }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, speed, lapDur, loop]);

  // Timeline scrubbing — set the clock from a click/drag x-fraction (pauses playback).
  const barRef = useRef(null);
  const scrubEnd = useRef(null); // tears down an in-flight drag's window listeners
  const scrubFrom = (clientX) => {
    const el = barRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setPlayhead(clamp((clientX - r.left) / r.width, 0, 1));
  };
  const onBarDown = (e) => { setPlaying(false); scrubFrom(e.clientX);
    const move = ev => scrubFrom(ev.clientX);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); scrubEnd.current = null; };
    scrubEnd.current = up;
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); };
  // Drop a drag still in progress if the panel unmounts (listeners live on window).
  useEffect(() => () => { scrubEnd.current?.(); }, []);

  const pill = (active) => ({
    background: active ? "var(--elevated)" : "transparent",
    color: active ? "var(--text)" : "var(--text-faint)",
    border: `1px solid ${active ? "var(--border-strong)" : "transparent"}`,
    borderRadius: 6, padding: "4px 12px", fontSize: 10, fontWeight: active ? 700 : 400,
    cursor: "pointer", letterSpacing: 1, textTransform: "uppercase", fontFamily: "inherit",
  });
  const camBtn = {
    width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center",
    background: "rgba(10,14,22,0.7)", color: "var(--text)", border: "1px solid var(--border-strong)",
    borderRadius: 6, cursor: "pointer", fontSize: 15, fontFamily: "inherit", backdropFilter: "blur(4px)",
  };

  if (!lines3D.length) {
    return (
      <div style={{flex:1,minHeight:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
        textAlign:"center",padding:24,color:"var(--text-faintest)",fontSize:12,lineHeight:1.6}}>
        No racing line to draw yet.<br />
        Drive a lap live on this circuit (so the car's track positions are captured),
        then pick two such laps to compare their lines in 3D.
      </div>
    );
  }

  return (
    <div style={{flex:1,minHeight:0,display:"flex",flexDirection:"column",gap:10,overflow:"hidden"}}>
      {/* Header: title + line legend swatches */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexWrap:"wrap"}}>
        <span style={{fontSize:10,letterSpacing:2,color:"#8b94a8",textTransform:"uppercase",fontWeight:600}}>Racing Lines · 3D View</span>
        <div style={{display:"flex",gap:14}}>
          <span style={{display:"flex",alignItems:"center",gap:5,fontSize:9,color:"#8b94a8"}}>
            <span style={{width:10,height:10,borderRadius:3,background:DL_COMP_COLOR}} />Driven</span>
          <span style={{display:"flex",alignItems:"center",gap:5,fontSize:9,color:"#8b94a8"}}>
            <span style={{width:10,height:10,borderRadius:3,background:DL_REF_COLOR}} />Reference</span>
        </div>
      </div>

      {hidden.length > 0 && (
        <div style={{fontSize:10,color:"var(--text-faintest)",textAlign:"center",lineHeight:1.5}}>
          {hidden.join(" · ")} — no position data, car hidden. Drive this lap live to capture its line.
        </div>
      )}

      {/* The 3D scene — chase camera over both racing lines */}
      <div style={{position:"relative",flex:"1 1 auto",minHeight:300,borderRadius:10,overflow:"hidden",
        border:"1px solid var(--line)",background:"radial-gradient(120% 120% at 50% 0%, #131a26 0%, #0a0d14 70%)"}}>
        <canvas ref={canvasRef}
          style={{width:"100%",height:"100%",display:"block",touchAction:"none",cursor:"grab"}} />
        {/* Drag hint (top-left) */}
        <div style={{position:"absolute",left:12,top:11,zIndex:3,pointerEvents:"none",
          fontFamily:"'JetBrains Mono',monospace",fontSize:9,letterSpacing:1.5,color:"#5b6478",textTransform:"uppercase"}}>
          {trackName || "Track"} · drag to orbit · scroll to zoom
          {trackModel && trackModel.status === "fallback" ? " · approximate track" : ""}
        </div>
        {trackModel === null && (
          <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",zIndex:2,
            pointerEvents:"none",fontFamily:"'JetBrains Mono',monospace",fontSize:11,letterSpacing:1.5,
            color:"#5b6478",textTransform:"uppercase"}}>Aligning circuit…</div>
        )}
        {/* Nearest corner (top-right) */}
        <div style={{position:"absolute",right:12,top:11,zIndex:3,pointerEvents:"none",
          fontFamily:"'JetBrains Mono',monospace",fontSize:11,fontWeight:700,color:"#34c8ff"}}>{cornerName}</div>
        {/* Camera overlay controls (bottom-right) */}
        <div style={{position:"absolute",bottom:8,right:8,display:"flex",flexDirection:"column",gap:6,zIndex:3}}>
          <button title="Zoom in" style={camBtn} onClick={()=>sceneRef.current?.zoomBy(0.8)}>＋</button>
          <button title="Zoom out" style={camBtn} onClick={()=>sceneRef.current?.zoomBy(1.25)}>－</button>
          <button title="Change camera angle" style={camBtn}
            onClick={()=>setCamMode(sceneRef.current?.cycleCamMode() || "chase")}>🎥</button>
          <button title="Reset view" style={{...camBtn,fontSize:12}}
            onClick={()=>{ sceneRef.current?.resetView(); }}>⟲</button>
        </div>
      </div>

      {/* Scrubber: play + knobbed timeline + corner readout */}
      <div style={{flex:"none",height:48,display:"flex",alignItems:"center",gap:16}}>
        <button onClick={()=>setPlaying(p=>!p)} title={playing?"Pause":"Play"}
          style={{width:38,height:34,borderRadius:8,border:"1px solid #2b3346",background:"#1a2030",color:"#cfd6e6",
            fontSize:13,cursor:"pointer",flex:"none"}}>{playing?"❚❚":"▶"}</button>
        <div ref={barRef} onPointerDown={onBarDown} style={{flex:1,position:"relative",height:34,display:"flex",alignItems:"center",cursor:"pointer"}}>
          <div style={{position:"absolute",left:0,right:0,height:6,borderRadius:3,background:"#1c2230"}} />
          <div style={{position:"absolute",left:0,height:6,borderRadius:3,background:DL_COMP_COLOR,width:`${playhead*100}%`}} />
          {/* Sector dividers */}
          {sectors.slice(1).map((s,i)=>(
            <div key={`sec-${i}`} style={{position:"absolute",left:`${s.start*100}%`,top:"50%",transform:"translate(-50%,-50%)",width:1,height:16,background:"#2b3346"}} />
          ))}
          {/* Corner ticks */}
          {corners.map((c,i)=>(
            <div key={i} style={{position:"absolute",left:`${c.f*100}%`,top:"50%",transform:"translate(-50%,-50%)",width:2,height:11,background:"#2b3346"}} />
          ))}
          {/* Reference car position (diverges from the knob in pace-sync) */}
          {refLine && compLine && syncMode==="pace" && (
            <div title="Reference car" style={{position:"absolute",left:`${refDistForCompDist(refLine,playhead)*100}%`,top:"50%",
              transform:"translate(-50%,-50%)",width:9,height:9,borderRadius:"50%",background:"transparent",border:`2px solid ${DL_REF_COLOR}`}} />
          )}
          {/* Knob */}
          <div style={{position:"absolute",left:`${playhead*100}%`,top:"50%",transform:"translate(-50%,-50%)",width:16,height:16,borderRadius:"50%",
            background:DL_COMP_COLOR,border:"3px solid #0b0e14",boxShadow:`0 0 9px ${DL_COMP_COLOR}aa`}} />
        </div>
        <div style={{flex:"none",fontFamily:"'JetBrains Mono',monospace",fontSize:13,color:"#8b94a8",minWidth:84,textAlign:"right"}}>{cornerName}</div>
      </div>

      {/* Transport controls (app extras): sync mode · speed · loop */}
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",justifyContent:"center"}}>
        <div style={{display:"flex",gap:3,background:"var(--line)",borderRadius:8,padding:3}}>
          {[["pos","Position-sync"],["pace","Pace-sync"]].map(([m,l])=>(
            <button key={m} onClick={()=>setSyncMode(m)} style={pill(syncMode===m)}>{l}</button>
          ))}
        </div>
        <div style={{display:"flex",gap:3,background:"var(--line)",borderRadius:8,padding:3}}>
          {[0.5,1,2].map(s=>(
            <button key={s} onClick={()=>setSpeed(s)} style={pill(speed===s)}>{s}×</button>
          ))}
        </div>
        <button onClick={()=>setLoop(l=>!l)} style={pill(loop)}>Loop</button>
        {trackModel && trackModel.status === "real" && (
          <span style={{fontSize:9,color:"var(--text-faintest)",letterSpacing:0.5}}>
            Track geometry: TUMFTM racetrack-database
          </span>
        )}
      </div>
    </div>
  );
}

// Map a lap-time fraction (0..1) to the matching track-distance fraction using a line's
// own time/distance curves — used to place sector splits (recorded as times) on the
// distance-based timeline.
function timeFracToDistFrac(line, ft) {
  if (!line) return ft;
  const { timeAt, distAt } = line;
  const f = Math.max(0, Math.min(1, ft));
  let i = 1; while (i < timeAt.length && timeAt[i] < f) i++;
  const lo = timeAt[i - 1] ?? 0, hi = timeAt[i] ?? 1;
  const t = hi > lo ? (f - lo) / (hi - lo) : 0;
  return (distAt[i - 1] ?? 0) + ((distAt[i] ?? 1) - (distAt[i - 1] ?? 0)) * t;
}

// The reference car's track-distance fraction when the shared clock (the comparison/anchor
// car's distance fraction) is at `compDistFrac`. Reads the reference line's pace curve
// (anchor-distance space) against its own distAt, so the timeline marker sits where the
// reference car really is on track — diverging from the knob by the spatial gap the time
// delta has opened. Falls back to the clock itself when pace data is unavailable.
function refDistForCompDist(refLine, compDistFrac) {
  const paceAt = refLine?.paceAt, distAt = refLine?.distAt;
  if (!paceAt || !distAt) return compDistFrac;
  const f = clamp(compDistFrac, 0, 1);
  let i = 1; while (i < paceAt.length && paceAt[i] < f) i++;
  i = Math.min(i, paceAt.length - 1);
  const lo = paceAt[i - 1], hi = paceAt[i];
  const t = hi > lo ? (f - lo) / (hi - lo) : 0;
  return (distAt[i - 1] ?? 0) + ((distAt[i] ?? 1) - (distAt[i - 1] ?? 0)) * t;
}

function lapSourceLabel(s) {
  if (s.lapNumber) return `Lap ${s.lapNumber} · ${s.lapTime ? fmtTime(s.lapTime) : "—"}${s.invalid ? " · ⚠ INVALIDATED" : ""}`;
  const m = s.meta || {};
  const parts = [m.driver || "?", m.track || "?"];
  if (m.session) parts.push(m.session);
  if (m.tyres)   parts.push(m.tyres);
  if (m.lapTime) parts.push(fmtTime(m.lapTime));
  return `Ref · ${parts.join(" · ")}`;
}

// ─── SMALL SHARED COMPONENTS ──────────────────────────────────────────────────
const inputStyle = { width:"100%", background:"var(--bg)", border:"1px solid var(--border-input)", borderRadius:5,
  color:"var(--text-dim)", padding:"6px 8px", fontSize:11, fontFamily:"inherit", boxSizing:"border-box" };
const btnStyle = (bg,color,border) => ({
  background:bg, color, border:`1px solid ${border}`, borderRadius:6,
  padding:"6px 14px", fontSize:11, cursor:"pointer", fontFamily:"inherit", fontWeight:600,
});

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function BoxBoxApp({ onOpenCalibrator }) {
  // UI state
  const [tab,        setTab]        = useState("dashboard");
  const [audioOn,    setAudioOn]    = useState(true);
  // Independent of the track audio cues: when on, the AI's per-lap "Next Lap
  // Focus" tip is read through the headset. Toggled from the focus panel itself.
  const [focusAudioOn, setFocusAudioOn] = useState(true);
  // Switch-Driver modal (the Shell driver chip + the Dashboard "Switch Driver"
  // button open it). Car-Setup modal holds the chosen lap's setup snapshot or null.
  const [switchDriverOpen, setSwitchDriverOpen] = useState(false);
  const [carSetup, setCarSetup] = useState(null); // { track, time, date, color, setup } | null
  const [traceOpen, setTraceOpen] = useState(false); // Trace Configurator modal
  // Which telemetry channels the trace pipeline records (display/config only — the
  // bridge forwards what the game sends). Persisted so the choice sticks.
  const [traceChannels, setTraceChannels] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem("f1coach.traceChannels") || "null"); if (s) return s; } catch {}
    return { throttle:true, brake:true, steering:true, gear:true, speed:true, rpm:false, ers:true, drs:true, tyreTemp:false, gforce:true };
  });
  useEffect(() => { localStorage.setItem("f1coach.traceChannels", JSON.stringify(traceChannels)); }, [traceChannels]);
  // Which trace panels the Telemetry studio shows (ids match its PANELS registry).
  // Persisted per install; merged over the defaults so future panel ids appear
  // enabled instead of vanishing for drivers with an older saved selection.
  const [visibleTraces, setVisibleTraces] = useState(() => {
    const defaults = { inputs: true, speed: true, steer: true, gear: true, ers: true, tyres: true };
    try {
      const s = JSON.parse(localStorage.getItem("f1coach.visibleTraces") || "null");
      if (s) return { ...defaults, ...s };
    } catch {}
    return defaults;
  });
  useEffect(() => { localStorage.setItem("f1coach.visibleTraces", JSON.stringify(visibleTraces)); }, [visibleTraces]);
  // Refuse to hide the last visible trace — an all-empty studio is never useful.
  const toggleTrace = (id) => setVisibleTraces((v) => {
    const on = v[id] !== false;
    if (on && Object.values(v).filter(Boolean).length <= 1) return v;
    return { ...v, [id]: !on };
  });
  const [cues,       setCues]       = useState([]);

  // How many seconds ahead of the reference's mark each call fires.
  const [leadSeconds, setLeadSeconds] = useState(1.5);

  // Live screen per-category toggles, driven by the track-map legend chips. Each key
  // (legendKeyFor categories) governs BOTH whether that category is colour-coded on
  // the live track map AND whether its voice cue fires — toggle a chip off and that
  // skill goes dark on the map and silent over the headset. "normal" hides un-cued
  // track segments AND gates the ERS-off "None" cue (see legendKeyFor). (The Compare
  // maps keep their own coarser mapFilters.)
  const [liveCues, setLiveCues] = useState({
    brake:true, lico:true, lift:true, ers1:true, ers2:true, ers3:true, normal:true,
  });

  // Config
  // UDP port the in-process telemetry core listens on for the game's telemetry.
  // Default 20777 (the game's default), but some users run a tool that receives
  // that stream and rebroadcasts it on another port — so this is configurable. The
  // number is pushed to the native core via the `set_udp_port` command (it rebinds
  // its listener live).
  const [udpPort, setUdpPort] = useState(() => {
    const n = parseInt(localStorage.getItem("f1coach.udpPort"), 10);
    return n >= 1 && n <= 65535 ? n : 20777;
  });
  useEffect(() => { localStorage.setItem("f1coach.udpPort", String(udpPort)); }, [udpPort]);

  // LLM backend — OpenRouter cloud. Persisted so the user doesn't re-enter their
  // key/model each session.
  const [openRouterKey,   setOpenRouterKey]   = useState(() => localStorage.getItem("f1coach.openRouterKey") || "");
  const [openRouterModel, setOpenRouterModel] = useState(() => localStorage.getItem("f1coach.openRouterModel") || DEFAULT_OPENROUTER_MODEL);
  useEffect(() => { localStorage.setItem("f1coach.openRouterKey", openRouterKey); }, [openRouterKey]);
  useEffect(() => { localStorage.setItem("f1coach.openRouterModel", openRouterModel); }, [openRouterModel]);

  // One config object threaded to both LLM call sites (tips + chat).
  const llmConfig = useMemo(
    () => ({ openRouterKey, openRouterModel }),
    [openRouterKey, openRouterModel]
  );
  const activeModelLabel = openRouterModel;

  // Live reachability of the LLM backend — polls on mount, on config change, and on
  // a slow interval. This drives the header
  // AI pill and the "auto" coach gate so they reflect whether the model can actually
  // be reached, not just that one is configured (previously these only flipped on
  // after a manual "Test" click, so auto-coaching never started on its own).
  const llmHealth = useLlmHealth(llmConfig);
  const llmOnline = llmHealth === "online";

  // One-shot check on boot for a newer GitHub release; surfaced as a banner on
  // the dashboard. null until (and unless) a newer version is published.
  const appUpdate = useUpdateCheck();

  // Speed units — the bridge always reports km/h; the driver can read km/h or
  // mph across the Live KPIs, Telemetry readouts and Corner table. Persisted.
  const [units, setUnits] = useState(() => localStorage.getItem("f1coach.units") || "km/h");
  useEffect(() => { localStorage.setItem("f1coach.units", units); }, [units]);

  // Tyre temp units — the bridge always reports °C; the driver can read °C or °F
  // in the Telemetry Studio's Tyre Temps panel. Persisted.
  const [tempUnits, setTempUnits] = useState(() => localStorage.getItem("f1coach.tempUnits") || "°C");
  useEffect(() => { localStorage.setItem("f1coach.tempUnits", tempUnits); }, [tempUnits]);

  // Voice preferences — persisted across sessions
  const [voicePrefs, setVoicePrefs] = useState(() => {
    try { return JSON.parse(localStorage.getItem("f1coach.voicePrefs") || "{}"); }
    catch { return {}; }
  });
  useEffect(() => {
    localStorage.setItem("f1coach.voicePrefs", JSON.stringify(voicePrefs));
  }, [voicePrefs]);

  // Active team skin — recolours the whole app by swapping CSS custom properties
  // on <html> (see lib/ui/skins.js). "default" is the original dark navy palette.
  // The global key is the seed default; the choice is also remembered per driver
  // (in .prefs) alongside units/voicePrefs below.
  const [activeSkin, setActiveSkin] = useState(() => {
    const s = localStorage.getItem("f1coach.skin");
    return isSkin(s) ? s : DEFAULT_SKIN;
  });
  useEffect(() => {
    localStorage.setItem("f1coach.skin", activeSkin);
    applySkin(activeSkin);
  }, [activeSkin]);

  // Driver profiles — more than one person can use the app and keep their laps
  // (and therefore their dashboard stats) separate. Simple name-based profiles: a
  // persisted list of names + the active one. Laps are scoped by meta.driver in
  // IndexedDB (see useLapRecorder + lapStore), so switching driver swaps history.
  // Profiles are rich objects { name, number, team, color }; `activeDriver` stays
  // the NAME (the key laps are scoped by in IndexedDB). Old string[] rosters are
  // migrated on read so existing users keep their drivers + laps.
  const [drivers, setDrivers] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("f1coach.drivers") || "null");
      if (Array.isArray(saved) && saved.length) {
        return saved.map((d, i) => typeof d === "string"
          ? { name: d, number: "", team: "", color: LIVERY_COLORS[i % LIVERY_COLORS.length] }
          : { number: "", team: "", color: LIVERY_COLORS[i % LIVERY_COLORS.length], ...d });
      }
    } catch { /* fall through to default */ }
    return [{ name: "You", number: "", team: "", color: LIVERY_COLORS[0] }];
  });
  const [activeDriver, setActiveDriver] = useState(() => localStorage.getItem("f1coach.activeDriver") || null);
  useEffect(() => { localStorage.setItem("f1coach.drivers", JSON.stringify(drivers)); }, [drivers]);
  useEffect(() => { if (activeDriver) localStorage.setItem("f1coach.activeDriver", activeDriver); }, [activeDriver]);
  const driverNames = useMemo(() => drivers.map(d => d.name), [drivers]);
  const driverKey = driverNames.join("\u0000"); // stable dep: changes only when the roster's names do (NUL-joined so names can't collide)
  const activeDriverObj = useMemo(
    () => drivers.find(d => d.name === activeDriver) || drivers[0] || null, [drivers, activeDriver]);
  // Latest roster, read inside effects/callbacks that shouldn't re-run on every edit.
  const driversRef = useRef(drivers);
  driversRef.current = drivers;
  // Keep activeDriver valid — default to the first profile if unset or removed.
  useEffect(() => {
    if (!activeDriver || !driverNames.includes(activeDriver)) setActiveDriver(driverNames[0] || null);
  }, [driverNames, activeDriver]);

  // Per-driver profile photos. The image itself lives in IndexedDB (lapStore,
  // keyed by name); here we keep a lightweight name → dataUrl map for rendering.
  const [avatars, setAvatars] = useState({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out = {};
      for (const nm of driverNames) {
        const a = await lapStore.getAvatar(nm);
        if (a) out[nm] = a;
      }
      if (!cancelled) setAvatars(out);
    })();
    return () => { cancelled = true; };
  }, [driverKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-driver settings: each profile remembers its own speed units, voice + team
  // skin. The live `units`/`voicePrefs`/`activeSkin` state is hydrated from the
  // active driver on switch and written back on edit. The global f1coach.* keys
  // remain the seed default a brand-new (or migrated, prefs-less) profile inherits.
  const lastPrefsDriver = useRef(activeDriver);
  // Hydrate the active driver's saved prefs into the live state when switching.
  useEffect(() => {
    if (!activeDriver) return;
    const p = driversRef.current.find(d => d.name === activeDriver)?.prefs;
    if (p) {
      if (p.units != null) setUnits(p.units);
      if (p.tempUnits != null) setTempUnits(p.tempUnits);
      if (p.voicePrefs != null) setVoicePrefs(p.voicePrefs);
      if (isSkin(p.skin)) setActiveSkin(p.skin);
    }
  }, [activeDriver]);
  // Persist live units/voicePrefs/skin back onto the active driver — but skip the
  // switch tick, where they still hold the previous driver's values.
  useEffect(() => {
    if (lastPrefsDriver.current !== activeDriver) { lastPrefsDriver.current = activeDriver; return; }
    setDrivers(prev => {
      const idx = prev.findIndex(d => d.name === activeDriver);
      if (idx < 0) return prev;
      const cur = prev[idx], pp = cur.prefs;
      if (pp && pp.units === units && pp.tempUnits === tempUnits && pp.skin === activeSkin && JSON.stringify(pp.voicePrefs || {}) === JSON.stringify(voicePrefs || {})) return prev;
      const next = prev.slice();
      next[idx] = { ...cur, prefs: { units, tempUnits, voicePrefs, skin: activeSkin } };
      return next;
    });
  }, [units, tempUnits, voicePrefs, activeSkin, activeDriver]);

  // Sign a new driver from the Settings roster form (name + optional number/team/livery/photo).
  const signDriver = useCallback(({ name, number, team, color, avatar } = {}) => {
    const nm = (name || "").trim();
    if (!nm) return;
    setDrivers(prev => prev.some(d => d.name === nm) ? prev
      : [...prev, { name: nm, number: (number || "").trim(), team: (team || "").trim(),
          color: color || LIVERY_COLORS[prev.length % LIVERY_COLORS.length] }]);
    setActiveDriver(nm);
    if (avatar) { setAvatars(prev => ({ ...prev, [nm]: avatar })); lapStore.putAvatar(nm, avatar); }
  }, []);
  // Remove a driver (and their laps + photo). Guarded so the roster is never empty.
  const deleteDriver = useCallback((name) => {
    const nm = (name || "").trim();
    const list = driversRef.current;
    if (!nm || list.length <= 1 || !list.some(d => d.name === nm)) return;
    setDrivers(prev => prev.filter(d => d.name !== nm));
    setAvatars(prev => { const next = { ...prev }; delete next[nm]; return next; });
    lapStore.clearLaps(nm);
    lapStore.deleteAvatar(nm);
  }, []);
  // Edit an existing driver profile from the Settings roster. Name, number, team,
  // livery and photo are all editable. Renaming re-files the driver's laps, photo
  // and track maps in IndexedDB (lapStore.renameDriver) and follows the active
  // selection so the cockpit stays on the same person. `avatar` is a data URL (new
  // photo), null (removed) or undefined (left unchanged). Resolves true on success,
  // false if the profile is gone or the new name collides with another one.
  const editDriver = useCallback(async (originalName, { name, number, team, color, avatar } = {}) => {
    const on = (originalName || "").trim();
    const nm = (name || "").trim();
    if (!on || !nm) return false;
    const list = driversRef.current;
    if (!list.some(d => d.name === on)) return false;
    const renamed = nm !== on;
    if (renamed && list.some(d => d.name === nm)) return false;

    // Migrate stored data BEFORE touching React state, so the avatar-reload effect
    // (which re-reads IndexedDB when the roster's names change) sees the new keys.
    if (renamed) await lapStore.renameDriver(on, nm);

    setDrivers(prev => {
      const i = prev.findIndex(d => d.name === on);
      if (i < 0) return prev;
      const next = prev.slice();
      next[i] = { ...prev[i], name: nm, number: (number || "").trim(), team: (team || "").trim(), color: color || prev[i].color };
      return next;
    });
    if (renamed) {
      if (activeDriver === on) setActiveDriver(nm);
      setAvatars(prev => { const n = { ...prev }; if (n[on] != null) { n[nm] = n[on]; delete n[on]; } return n; });
    }
    // Apply an explicit photo change (against the final name). Untouched photos are
    // left alone — a rename already moved them via renameDriver above.
    if (avatar !== undefined) {
      if (avatar) { setAvatars(prev => ({ ...prev, [nm]: avatar })); await lapStore.putAvatar(nm, avatar); }
      else { setAvatars(prev => { const n = { ...prev }; delete n[nm]; return n; }); await lapStore.deleteAvatar(nm); }
    }
    return true;
  }, [activeDriver]);

  // Connection state
  const [wsConnected,  setWsConnected]  = useState(false);
  const [liveTel,      setLiveTel]      = useState(null);
  // A drive "session": a fresh id minted each time the live bridge connects, so
  // laps recorded during one connection share it and the dashboard can count
  // distinct sessions per driver.
  const [sessionId,    setSessionId]    = useState(null);

  // Reference traces. The active reference can be a loaded trace OR a lap driven
  // this session; it drives both the Compare overlay and the live coaching zones.
  const [refTraces,     setRefTraces]     = useState([]);
  const [activeTraceId, setActiveTraceId] = useState(null);

  // The loaded reference trace (if any) supplies a track-name fallback before any
  // live telemetry has identified the circuit. Resolved from refTraces only, so it
  // doesn't depend on storedLaps (which comes out of the recorder downstream).
  const loadedRefTrace = useMemo(() => refTraces.find(t=>t.id===activeTraceId)||null, [refTraces,activeTraceId]);

  // Telemetry comes solely from the live UDP bridge. Until a connection delivers a
  // snapshot, fall back to a zeroed reading so the UI renders an idle state.
  const rawTel = liveTel || EMPTY_TEL;

  // Identify the circuit from the m_trackId the bridge forwards in each snapshot.
  const trackInfo = useMemo(() => getTrack(rawTel.trackId ?? -1), [rawTel.trackId]);

  // Coarse game mode (Time Trial / Qualifying / …) from the bridge's sessionType,
  // tagged onto each recorded lap so the dashboard can split fastest laps by mode.
  const sessionTypeLabel = useMemo(() => sessionTypeName(rawTel.sessionType), [rawTel.sessionType]);

  // Lap recording runs on RAW telemetry — it only reads the channels + lap
  // position (not currentZone), so storedLaps is available to resolve the
  // reference and comparison laps below. Laps are saved under the active driver.
  const { currentLap, liveMini, storedLaps, deleteLap, archiveSessionLaps, loadSessionLaps, reloadLaps } =
    useLapRecorder(rawTel, trackInfo?.name || loadedRefTrace?.meta?.track || null,
      activeDriver, sessionId, sessionTypeLabel);

  // "Reset" the Session Laps panel. Archiving the current laps hides them from the
  // live Session-Laps / Analytics views permanently (the flag is persisted in
  // IndexedDB, so they don't reappear on the next launch) while every lap stays in
  // history — PBs, dashboard stats and trends read all laps and are untouched. A
  // fresh sessionId then scopes the panel to whatever is driven next. Used by both
  // the manual button and the auto-reset effect below.
  const resetSessionLaps = useCallback(() => {
    archiveSessionLaps();
    setSessionId(`s-${Date.now()}`);
    // Also clear the Analytics reference selection — the old reference belongs to
    // the session/track being left behind. Loaded trace files stay in the dropdown
    // to re-pick; a pre-connect reference survives because connecting mints the
    // sessionId directly, not through this handler.
    setActiveTraceId(null);
  }, [archiveSessionLaps]);

  // ─── PROFILE BACKUP / IMPORT ───────────────────────────────────────────────
  // Save the ACTIVE driver's whole profile (roster entry + prefs + photo + every
  // lap with telemetry + saved track maps) to one .json file. Returns the counts
  // so Settings can report what was written. See lib/profileBackup.js.
  const exportProfile = useCallback(async () => {
    const d = driversRef.current.find(x => x.name === activeDriver) || driversRef.current[0];
    if (!d) throw new Error("No driver to export.");
    return exportProfileFile(d);
  }, [activeDriver]);

  // Bring a parsed profile payload back into storage under `name`. `overwrite`
  // wipes that driver's existing laps + track maps first (a clean restore);
  // otherwise the profile is added as a new roster entry (a copy). After writing
  // storage we merge the roster entry into React state, load the photo, make the
  // profile active and re-read its laps (covers overwriting the current driver,
  // where the recorder's driver-change effect wouldn't fire).
  const importProfile = useCallback(async (payload, { name, overwrite } = {}) => {
    const target = (name || payload?.driver?.name || "").trim();
    if (!target) throw new Error("No driver name to import under.");
    if (overwrite) {
      await lapStore.clearLaps(target);
      await lapStore.clearTrackMaps(target);
      await lapStore.deleteAvatar(target);
    }
    const entry = await importProfileData(payload, { name: target });
    setDrivers(prev => {
      const i = prev.findIndex(d => d.name === target);
      const base = {
        name: target,
        number: entry.number,
        team: entry.team,
        color: entry.color || (i >= 0 ? prev[i].color : LIVERY_COLORS[prev.length % LIVERY_COLORS.length]),
        ...(entry.prefs ? { prefs: entry.prefs } : {}),
      };
      if (i >= 0) { const next = prev.slice(); next[i] = { ...prev[i], ...base }; return next; }
      return [...prev, base];
    });
    if (entry.avatar) setAvatars(prev => ({ ...prev, [target]: entry.avatar }));
    else if (overwrite) setAvatars(prev => { const n = { ...prev }; delete n[target]; return n; });
    setActiveDriver(target);
    reloadLaps();
    return entry;
  }, [reloadLaps]);

  // Auto-reset the Session Laps panel only when the drive moves to a different
  // circuit. Session type is deliberately NOT a trigger: staying on the same
  // track across multiple sessions (e.g. several practice sessions) keeps all
  // laps together so they aggregate for more intensive practice. The user can
  // still reset manually for a fresh start. Only a known→different-known track
  // change resets, so the first telemetry after connect (unknown → real) and
  // menu blips (real → -1 → same real) never fire a spurious reset.
  const prevTrackRef = useRef(null);
  useEffect(() => {
    const trackId = rawTel.trackId;
    const tValid = typeof trackId === "number" && trackId >= 0; // -1/undefined = no session
    if (tValid) {
      if (prevTrackRef.current != null && prevTrackRef.current !== trackId) resetSessionLaps();
      prevTrackRef.current = trackId;
    }
  }, [rawTel.trackId, resetSessionLaps]);

  // Laps belonging to the current drive, scoped by sessionId exactly like the Live
  // screen's Session Laps panel (both go through visibleSessionLaps). The Analytics
  // screen renders its lap-data panels + the reference/driven dropdowns from this —
  // not the full history — so they reset in lock-step: a fresh sessionId, from the
  // reset button or the auto-reset above, empties it. With no live session (idle /
  // pre-connect) it scopes to the LAST driven session, not every saved lap.
  const sessionLaps = useMemo(
    () => visibleSessionLaps(storedLaps, sessionId),
    [storedLaps, sessionId]);

  // Open the Live view automatically the moment telemetry first connects — but not
  // while the user is mid-analysis on Compare (or already on Live), so we never yank
  // them away. Connecting usually happens from Setup, so that tab DOES hand off.
  // FIRST connect only: "receiving" also flaps on a game pause (packets stop), and
  // re-switching on every resume would pull the user off whatever tab they're on.
  const autoTabDoneRef = useRef(false);
  useEffect(() => {
    if (wsConnected && !autoTabDoneRef.current) {
      autoTabDoneRef.current = true;
      if (tab !== "compare" && tab !== "live") setTab("live");
    }
  }, [wsConnected, tab]);

  // Resolve the active reference from loaded traces + this session's driven laps.
  const activeTrace = useMemo(
    () => [...refTraces, ...storedLaps].find(t=>t.id===activeTraceId)||null,
    [refTraces, storedLaps, activeTraceId]);

  // Strategy zones are DERIVED FROM the active reference — braking, lift-and-coast,
  // and ERS-mode (by-mode) zones detected from its throttle, brake + ERS channels.
  // Select a different reference and the zones (and coaching calls) change. No
  // reference → generic defaults.
  const zones = useMemo(
    () => (activeTrace ? deriveZonesFromTrace(activeTrace) : []),
    [activeTrace]
  );

  // Flatten the zones into the list the announcement engine walks. Each entry
  // knows the lap-fraction of its action point (`atPct`), what to speak, and
  // what to log. An ERS zone's call IS the ERS mode. Toggles + lead time are
  // applied at fire time.
  const announceCalls = useMemo(() => zones.map(z => ({
    key: `z${z.id}`, type: z.type, atPct: z.start, name: z.name, ersMode: z.ersMode,
    // Granular per-category key so each legend chip mutes exactly its own cue
    // (ERS split by mode; lift distinct from lico). See legendKeyFor.
    toggleKey: legendKeyFor(z),
    beep: z.type === "ers" ? [880,0.1,"sine"]
        : z.type === "lico" ? [520,0.13,"triangle"]
        : z.type === "lift" ? [620,0.11,"triangle"]
        : [440,0.15,"square"],
    speak: z.type === "brake" ? `Brake — ${z.name}`
         : z.type === "lico"  ? `Lift and coast — ${z.name}`
         : z.type === "lift"  ? `Lift — ${z.name}`
         : `${ERS_MODES[z.ersMode]}`,
    cue: z.type === "brake" ? `🛑 BRAKE: ${z.name}${z.note ? " — " + z.note : ""}`
       : z.type === "lico"  ? `〰️ LIFT & COAST: ${z.name}`
       : z.type === "lift"  ? `↘️ LIFT: ${z.name}`
       : `🔋 ERS ${ERS_MODES[z.ersMode]?.toUpperCase()}: ${z.name}`,
  })), [zones]);

  // Internals
  // Announcement engine state: which call keys have fired this lap + a remembered
  // track length so seconds-of-lead can be converted to a lap-fraction.
  const announcedRef    = useRef({ set: new Set(), lastPct: 0 });
  const lastTrackLenRef = useRef(5000);
  const lastBatteryCallRef = useRef(0);
  const coachCtxRef = useRef(null);
  // Live track map: world positions accumulated into ~12 m distance bins as you
  // drive, so the map draws the actual circuit. mapVersion bumps re-render on reset.
  const trackPathRef = useRef({ bins: new Map(), lastX: null, lastZ: null });
  const [mapVersion, setMapVersion] = useState(0);

  const { speak, beep, preview, kokoro } = useAudio(voicePrefs);

  // When Kokoro is the engine, pre-synthesise the known corner-call phrases so
  // they fire instantly on the mark. Re-runs when the voice/speed or the set of
  // calls (i.e. the loaded trace) changes. Novel text (AI tips) synths on demand.
  useEffect(() => {
    if (voicePrefs.engine !== "kokoro" || kokoro.status !== "ready") return;
    const phrases = announceCalls.map(c => c.speak);
    phrases.push("Battery critical — conserve ERS");
    kokoro.prewarm(phrases);
  }, [voicePrefs.engine, voicePrefs.kokoroVoice, voicePrefs.rate, kokoro.status, announceCalls]);

  const trackName = trackInfo?.name || activeTrace?.meta?.track || null;

  // Derive the active strategy zone from lap position here (not in the source):
  // live packets off the UDP bridge only carry lapPct, not the zone.
  const currentZone = useMemo(
    () => zones.find(z => rawTel.lapPct >= z.start && rawTel.lapPct <= z.end) || null,
    [rawTel.lapPct, zones]
  );
  const tel = useMemo(() => ({ ...rawTel, currentZone }), [rawTel, currentZone]);

  // Accumulate world positions into ~12 m bins to trace the real circuit.
  useEffect(() => {
    const { worldX, worldZ, lapDistance, lapPct } = tel;
    if (typeof worldX !== "number" || typeof worldZ !== "number") return; // no world data yet
    if (!isFinite(worldX) || !isFinite(worldZ)) return;
    const rec = trackPathRef.current;
    if (rec.lastX != null) {
      const jump = Math.hypot(worldX - rec.lastX, worldZ - rec.lastZ);
      if (jump > 800) rec.bins.clear(); // big teleport → new track / flashback → restart
    }
    rec.lastX = worldX; rec.lastZ = worldZ;
    const bin = { dist: lapDistance || 0, pct: lapPct || 0, x: worldX, z: worldZ };
    if (typeof tel.worldY === "number" && isFinite(tel.worldY)) bin.y = tel.worldY;
    rec.bins.set(Math.round((lapDistance || 0) / 12), bin);
  }, [tel.worldX, tel.worldZ]);

  const recordedPath = useMemo(() => {
    const bins = trackPathRef.current.bins;
    if (bins.size < 20) return null;
    return [...bins.values()].sort((a, b) => a.dist - b.dist);
  }, [tel.worldX, tel.worldZ, mapVersion]);

  const resetMap = () => {
    const rec = trackPathRef.current;
    rec.bins.clear(); rec.lastX = null; rec.lastZ = null;
    setMapVersion(v => v + 1);
  };

  // The circuit outline previously saved for this driver + track, loaded from
  // IndexedDB so the Live map can draw the full track the instant a known circuit
  // is identified — no waiting for a lap, no progressive redraw. Reloaded whenever
  // the driver or track changes.
  const [savedMapPath, setSavedMapPath] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setSavedMapPath(null);
    if (!activeDriver || !trackInfo?.slug) return;
    lapStore.getTrackMap(activeDriver, trackInfo.slug).then(p => {
      if (!cancelled) setSavedMapPath(p);
    });
    return () => { cancelled = true; };
  }, [activeDriver, trackInfo?.slug]);

  // The outline actually drawn: prefer the saved (complete, stable) path so the map
  // never redraws mid-lap. The live recordedPath only feeds the save below and is
  // the fallback for a never-driven track (draws progressively that first lap).
  const mapPath = savedMapPath || recordedPath;

  // Save / refresh the saved track map whenever a clean lap completes. The recorder
  // only appends CLEAN laps to storedLaps (ghost/out/in/invalid laps are dropped),
  // so any append here is a real timed lap. A driver switch replaces storedLaps in
  // bulk — we rebaseline on that without saving, so only a freshly driven lap fires.
  const mapSaveRef = useRef({ driver: null, len: 0 });
  useEffect(() => {
    const base = mapSaveRef.current;
    if (base.driver !== activeDriver) {
      mapSaveRef.current = { driver: activeDriver, len: storedLaps.length };
      return;
    }
    if (storedLaps.length <= base.len) return;
    base.len = storedLaps.length;
    const newest = storedLaps[storedLaps.length - 1];
    if (!trackInfo?.slug || !activeDriver) return;
    if (newest?.meta?.track !== trackName) return;       // lap belongs to another circuit
    if (!recordedPath || recordedPath.length < 20) return; // outline not complete yet
    const snapshot = recordedPath;
    lapStore.putTrackMap(activeDriver, trackInfo.slug, trackName, snapshot);
    setSavedMapPath(snapshot); // refresh the displayed outline at the lap boundary
  }, [storedLaps, activeDriver, trackInfo?.slug, trackName, recordedPath]);

  // Export a clean, shareable strategy map as a PNG: track outline + the
  // currently-selected colour-coded zones (honouring the live legend toggles) + a
  // colour legend, on a dark background. Reuses the shared exportMapImage canvas
  // pipeline so the dashboard and Compare maps render identically.
  // Reads mapPath — the outline actually on screen (saved circuit, else the live
  // recording) — so the export always matches what the Live map shows.
  const exportTrackMapPng = () => {
    if (!mapPath || mapPath.length < 20) return;
    const { segs, outline } = buildTrackMapGeometry(mapPath, zones, 240, 240, liveCues);
    exportMapImage({ segs, outline, filters: liveCues, legend: LIVE_LEGEND, name: trackName || "live", format: "png" });
  };

  // Reference sample at the driver's current track position
  const refSample   = useMemo(() => {
    if (!activeTrace) return null;
    return findRefSample(activeTrace.samples, tel.lapDistance);
  }, [activeTrace, tel.lapDistance]);

  // Comparison lap for the Compare screen — defaults to the live lap; can also be
  // any lap driven this session. (The reference/benchmark side is activeTrace.)
  const [comparisonLapId, setComparisonLapId] = useState("live");
  const comparisonLap = useMemo(
    () => comparisonLapId === "live" ? currentLap : (storedLaps.find(s => s.id === comparisonLapId) || null),
    [comparisonLapId, currentLap, storedLaps]);
  // Return the Analytics "Driven Lap" selector to the live lap whenever the session
  // resets (button / track / session-type change), so it isn't left pointing at a
  // previous session's lap that's no longer in the now session-scoped list.
  useEffect(() => { setComparisonLapId("live"); }, [sessionId]);

  // Lap-wide evidence for the coach: your most recent COMPLETED lap vs the loaded
  // reference. Recomputed only when a lap finishes or the reference changes (not
  // per telemetry tick), so it's cheap. Falls back to null → coach uses the
  // instantaneous at-this-point comparison.
  // One labeler the coach uses everywhere a track distance would otherwise be
  // read out: corner/zone name inside a named zone, else the sector. Bound to the
  // active zones + the trace's sector boundaries (meta.sectors) when present.
  // Real-world corner names for the active circuit (live track id, else the
  // reference trace's track name). Drives the labeler, the timeline ticks and
  // the track-map markers; empty for unknown tracks → callers fall back to zones.
  const trackCorners = useMemo(
    () => getCorners(trackInfo?.slug || trackName),
    [trackInfo, trackName]
  );
  const trackLabeler = useMemo(
    () => makeTrackLabeler({ zones, sectors: activeTrace?.meta?.sectors, corners: trackCorners }),
    [zones, activeTrace, trackCorners]
  );

  // The circuit the driver's current laps belong to — the anchor for scoping every
  // coaching input to ONE track (compare apples with apples). Prefer the live-
  // identified circuit; fall back to the newest saved lap's own track. Deliberately
  // NOT trackName, which falls back to the reference's track — that would let a
  // wrong-track reference redefine "the driven track" and hide a real mismatch.
  const drivenTrackName = trackInfo?.name
    || storedLaps[storedLaps.length - 1]?.meta?.track
    || null;

  // Does the loaded reference actually belong to the track being driven? Only counts
  // as a mismatch when BOTH tracks are positively known and different — a reference
  // loaded for another circuit by mistake. Unknown / "Live" tracks fail open (we
  // can't confirm a mismatch, so we don't block coaching). Comparing across circuits
  // produces nonsense advice, so on a mismatch the coach withholds it and says so.
  const refTrackName = activeTrace?.meta?.track || null;
  const tracksMismatch = !!activeTrace
    && isKnownTrackName(drivenTrackName) && isKnownTrackName(refTrackName)
    && !sameTrack(drivenTrackName, refTrackName);

  // Laps the coach is allowed to reason about, partitioned so "lap N" is never
  // ambiguous (lap numbers restart every session, so an all-time list shows the
  // model several identical "Lap 2" rows):
  //   • THIS circuit only — a lap at Silverstone is never analysed against laps from
  //     another track (that mixed history is what made the log claim "55 laps");
  //   • game-valid only (isRankable drops track-limits/corner-cut deleted laps);
  //   • split into the AUTHORITATIVE session (live session, else the most recent
  //     session on this track when the app is opened offline to review data) and a
  //     short, clearly-labelled tail of older-session laps (trends/progress only).
  // Partitioning happens BEFORE any windowing so a long current session is never
  // truncated in favour of stale laps.
  const trackLaps = useMemo(
    () => storedLaps.filter((l) => isRankable(l) && sameTrack(l.meta?.track, drivenTrackName)),
    [storedLaps, drivenTrackName]);

  // The session whose laps answer bare "lap N" questions: the live game session
  // when UDP is flowing, else the session of the newest recorded lap on this track
  // (same fallback as visibleSessionLaps in driverStats.js). Null when no lap
  // carries a sessionId at all (legacy history) — then there is no authoritative
  // block and everything is presented as older material.
  const coachSessionId = useMemo(() => {
    if (sessionId) return sessionId;
    let latest = null;
    for (const l of trackLaps) {
      if (!l.meta?.sessionId) continue;
      if (!latest || (l.recordedAt || 0) > (latest.recordedAt || 0)) latest = l;
    }
    return latest?.meta?.sessionId ?? null;
  }, [trackLaps, sessionId]);

  const currentSessionLaps = useMemo(
    () => coachSessionId
      ? trackLaps.filter((l) => l.meta?.sessionId === coachSessionId).slice(-COACH_LAP_WINDOW)
      : [],
    [trackLaps, coachSessionId]);

  // Older-session laps on this track (includes legacy laps without a sessionId).
  const previousSessionLaps = useMemo(() => {
    const cur = new Set(currentSessionLaps.map((l) => l.id));
    return trackLaps.filter((l) => !cur.has(l.id)).slice(-COACH_PREV_LAP_WINDOW);
  }, [trackLaps, currentSessionLaps]);

  // Aggregate window for inputs that don't cite lap numbers (evidence, trends,
  // structured log) — the most recent laps on this track regardless of session.
  const coachableLaps = useMemo(
    () => trackLaps.slice(-COACH_LAP_WINDOW),
    [trackLaps]);

  const lapEvidence = useMemo(() => {
    if (!activeTrace || tracksMismatch || !coachableLaps.length) return null;
    const lap = coachableLaps[coachableLaps.length - 1];
    const refLapTime = activeTrace.lapTime ?? activeTrace.meta?.lapTime ?? null;
    return buildLapEvidence(lap.samples, activeTrace.samples,
      { labelAt: trackLabeler, userLapTime: lap.lapTime, refLapTime });
  }, [coachableLaps, activeTrace, trackLabeler, tracksMismatch]);

  // Structured per-channel breakdown for the Coach Log screen — the most recent
  // completed lap vs the reference, with the real time-on-table distributed across
  // channels. Recomputed only on lap finish / reference change (cheap), like the
  // evidence above. Null until there's a completed lap + a reference, and while the
  // reference belongs to a different circuit (the screen shows a mismatch notice).
  const coachLog = useMemo(() => {
    if (!activeTrace || tracksMismatch || !coachableLaps.length) return null;
    const lap = coachableLaps[coachableLaps.length - 1];
    const refLapTime = activeTrace.lapTime ?? activeTrace.meta?.lapTime ?? null;
    return buildCoachLog(lap, activeTrace.samples, refLapTime,
      { labelAt: trackLabeler, setup: lap.setup, lapsAnalysed: coachableLaps.length });
  }, [coachableLaps, activeTrace, trackLabeler, tracksMismatch]);

  // History views for the conversational coach, all scoped to the current circuit:
  // a session-partitioned per-lap log (bare "lap N" questions resolve against the
  // current/last session; older sessions are listed separately for trends) and
  // cross-lap trends (recurring corner issues on this track).
  // Recomputed only when a lap completes or the reference/zones change.
  const lapLog = useMemo(
    () => buildLapLog(currentSessionLaps, previousSessionLaps,
      { live: !!sessionId, max: COACH_LAP_WINDOW }),
    [currentSessionLaps, previousSessionLaps, sessionId]);
  const sessionTrends = useMemo(() => {
    if (coachableLaps.length < 2) return null;
    // A wrong-track reference must not seed the "vs reference" trend lines — pass no
    // reference on a mismatch so trends stay pure same-track self-consistency.
    const ref = tracksMismatch ? null : (activeTrace?.samples || null);
    return buildTrends(coachableLaps, ref, { labelAt: trackLabeler });
  }, [coachableLaps, activeTrace, trackLabeler, tracksMismatch]);
  // Per-corner profile history (current/last session only — it cites lap numbers,
  // which restart every session) — speed/gear/throttle/brake/steer carried through
  // each corner — so the coach can field specific "what did I do at T# on lap N"
  // recall. Null for unknown tracks (no corner DB).
  const cornerProfiles = useMemo(
    () => buildCornerProfiles(currentSessionLaps, { corners: trackCorners, max: COACH_LAP_WINDOW }),
    [currentSessionLaps, trackCorners]
  );

  // The driver's current position as a corner/sector name, for the live coach
  // context. Lap length comes from the reference trace, else from lapPct.
  const liveLapLen = useMemo(() => {
    const s = activeTrace?.samples;
    if (Array.isArray(s) && s.length) return s[s.length - 1].dist || 0;
    return (tel.lapPct > 0.02 && tel.lapDistance) ? tel.lapDistance / tel.lapPct : 0;
  }, [activeTrace, tel.lapDistance, tel.lapPct]);
  const posLabel = trackLabeler(tel.lapDistance, liveLapLen);

  // LLM
  const { ask, askLap, thinking, lastAdvice } = useLLM(llmConfig);

  // Is the AI between-lap coach active right now? Insights always generate as
  // long as the LLM backend is actually reachable (live health probe); the
  // real-time call engine runs regardless of this.
  const aiActive = llmOnline;

  // ── Telemetry (in-process native core) ────────────────────────────────────
  // The native core owns the single UDP listener and is always running, so there's
  // no connect/disconnect: we just subscribe to its Tauri events. `wsConnected`
  // now means "the game is actively sending packets"; a fresh drive session id is
  // minted on each rising edge (as the old WebSocket onopen used to do).
  useTelemetry({
    onSnapshot: setLiveTel,
    onReceivingChange: setWsConnected,
  });

  // Drive-session identity comes from the GAME's per-session UID (in every UDP
  // header), not from the receiving on/off edge — the game stops sending packets
  // while paused, so an edge-based session id reset the Session Laps panel and lap
  // numbering after any pause longer than the receive timeout. A manual "Reset
  // Session Laps" still mints its own id (resetSessionLaps), which sticks until
  // the game starts a genuinely new session (new UID).
  useEffect(() => {
    const uid = rawTel.sessionUid;
    if (uid && uid !== "0") setSessionId(`s-${uid}`);
  }, [rawTel.sessionUid]);

  // Push a UDP-port change to the native core; it rebinds its listener live.
  useEffect(() => { coreInvoke("set_udp_port", { port: udpPort }); }, [udpPort]);

  // Native force-feedback engine (device control, live gauges, tuning + profiles).
  const ffb = useFfbEngine();

  // ── Load trace JSON ─────────────────────────────────────────────────────
  const loadTrace = (file) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const json = JSON.parse(e.target.result);
        if (!json.meta || !json.samples) { alert("Invalid trace JSON — use the Trace Calibrator to export."); return; }
        json.samples = sanitizeTraceSamples(json.samples); // clamp/round any out-of-range readings (gear 5.5, throttle -1)
        const id = crypto.randomUUID(); // UUID, not Date.now(): importing several traces at once would collide on ms
        setRefTraces(prev => [...prev, { ...json, id }]);
        setActiveTraceId(id);
        const zoneCount = deriveZonesFromTrace(json).length;
        addCue(`📂 Loaded ${json.meta.driver} @ ${json.meta.track} — ${zoneCount} strategy zones generated`, "info");
      } catch { alert("Could not parse JSON file."); }
    };
    reader.readAsText(file);
  };

  const removeTrace = id => {
    setRefTraces(prev => prev.filter(t=>t.id!==id));
    if (activeTraceId===id) setActiveTraceId(null);
  };

  // ── Save / load a whole session of laps ──────────────────────────────────
  // Save writes every lap currently in the Session Laps panel to one file. Load
  // reads such a file back and drops it INTO the panel for review: the laps are
  // re-tagged with a fresh session id (which becomes the active one) so the panel
  // shows exactly the loaded race, and a fresh lap id each so they never clobber
  // an existing lap. In-memory only — reviewing a saved session doesn't touch the
  // driver's persisted history; the file stays the durable copy.
  const saveSession = () => {
    const ok = exportSessionToFile(sessionLaps, {
      driver: activeDriver, track: trackName, sessionType: sessionTypeLabel,
    });
    if (ok) addCue(`💾 Saved ${sessionLaps.length} laps to file`, "info");
  };
  const loadSession = (file) => {
    const reader = new FileReader();
    reader.onload = e => {
      let laps;
      try { laps = parseSessionLaps(e.target.result); }
      catch (err) { alert(err.message || "Could not load the session file."); return; }
      const newSid = `loaded-${Date.now()}`;
      const retagged = laps.map(l => ({
        ...l,
        id: `lap-${crypto.randomUUID()}`,
        archived: false,
        meta: { ...(l.meta || {}), driver: activeDriver || "You", sessionId: newSid },
      }));
      loadSessionLaps(retagged);
      setSessionId(newSid);       // scope the panel to the loaded session
      setActiveTraceId(null);     // the old reference belonged to a different drive
      addCue(`📂 Loaded ${retagged.length} laps from file`, "info");
    };
    reader.readAsText(file);
  };

  // ── Real-time call engine (lead-time aware) ──────────────────────────────
  // Each enabled call fires once per lap, `leadSeconds` of track ahead of its
  // action point. Seconds → lap-fraction uses current speed and the lap length.
  useEffect(() => {
    if (!audioOn) return;
    const a = announcedRef.current;
    // New lap (lapPct wrapped back to ~0) → let every call fire again.
    if (tel.lapPct < a.lastPct - 0.5) a.set.clear();
    // Smaller backward jump = a flashback within the lap: re-arm only the calls
    // whose mark is now ahead again (already-passed calls must not instantly refire).
    else if (tel.lapPct < a.lastPct - 0.02) {
      for (const call of announceCalls) if (tel.lapPct < call.atPct) a.set.delete(call.key);
    }
    a.lastPct = tel.lapPct;

    // Only fire cues when the car is genuinely driving on track. Paused, in the
    // garage, or in the pit lane, the game resets/freezes lap distance — which
    // would otherwise replay cues as the mark sweeps back past its trigger. The
    // re-arm bookkeeping above still runs, so the next real lap fires cleanly.
    // (gamePaused is undefined on older cores/idle telemetry — treated as "not
    // paused" so behaviour is unchanged until the Rust snapshot ships it.)
    const driving = !tel.gamePaused &&
      tel.driverStatus !== 0 &&                       // 0 = in garage
      (tel.pitStatus == null || tel.pitStatus === 0); // != 0 = pit lane / pit area
    if (!driving) return;

    // Track length (m) from live telemetry, so lead seconds → distance.
    const trackLen = (tel.lapPct > 0.002 && tel.lapDistance > 0)
      ? tel.lapDistance / tel.lapPct : lastTrackLenRef.current;
    if (trackLen > 500) lastTrackLenRef.current = trackLen;
    const leadDist = Math.max(0, tel.speed / 3.6) * leadSeconds;       // m ahead
    const leadPct  = clamp(leadDist / trackLen, 0, 0.25);              // lap fraction

    for (const call of announceCalls) {
      if (!liveCues[call.toggleKey]) continue;
      if (a.set.has(call.key)) continue;
      const trig = call.atPct - leadPct;
      // Fire once we're within lead distance of the mark. When the trigger wraps
      // before the start/finish line, fire near the end of the previous lap.
      const due = trig >= 0 ? tel.lapPct >= trig : tel.lapPct >= trig + 1;
      if (!due) continue;
      a.set.add(call.key);
      const [f,d,t] = call.beep;
      beep(f, d, t);
      speak(call.speak, call.type === "ers" ? "normal" : "urgent");
      addCue(call.cue, call.type);
    }

    // Battery warning: only while actually driving a timed lap (the idle EMPTY_TEL
    // reads 0% battery), at most once per 30 s.
    if (wsConnected && tel.lapTime > 0 && tel.ersBattery < 15 &&
        Date.now() - lastBatteryCallRef.current > 30000) {
      lastBatteryCallRef.current = Date.now();
      speak("Battery critical — conserve ERS", "urgent");
      addCue("⚠️ Battery critical", "info");
    }
  }, [tel.lapPct, audioOn, announceCalls, liveCues, leadSeconds]);

  // ── AI between-lap coach: one improvement tip when a lap completes ───────
  // Fires once per freshly-completed lap (at the start/finish line), grounded in
  // the just-finished lap vs the reference. The real-time engine owns in-corner
  // calls; this never speaks mid-corner, so the two no longer compete.
  const lastSummarisedLap = useRef(null);
  useEffect(() => {
    if (!aiActive || !activeTrace || !coachableLaps.length) return;
    const lap = coachableLaps[coachableLaps.length - 1];
    if (lastSummarisedLap.current === lap.id) return;
    // Skip a stale lap (e.g. one finished before the AI was switched on).
    if (Date.now() - lap.recordedAt > 20000) { lastSummarisedLap.current = lap.id; return; }
    lastSummarisedLap.current = lap.id;
    if (!lapEvidence) return;
    (async () => {
      const tip = await askLap(lapEvidence, activeTrace.meta, lap.setup);
      if (tip && focusAudioOn) speak(tip, "low");
      if (tip) addCue(`🤖 ${tip}`, "llm");
    })();
  }, [coachableLaps, aiActive, activeTrace, lapEvidence, focusAudioOn]);

  // ── Manual LLM ask ──────────────────────────────────────────────────────
  const askNow = async () => {
    const advice = await ask(tel, refSample, tel.currentZone, activeTrace?.meta, lapEvidence);
    if (advice && audioOn) speak(advice, "low");
    if (advice) addCue(`🤖 ${advice}`, "llm");
  };

  // Open the Car Setup modal for a lap/trace (Dashboard, Live, Analytics).
  const openSetupForLap = (lap) => setCarSetup({
    track: lap?.meta?.track || trackName || "—",
    time: lap?.lapTime ? fmtTime(lap.lapTime) : (lap?.meta?.lapTime ? fmtTime(lap.meta.lapTime) : ""),
    date: lap?.recordedAt ? new Date(lap.recordedAt).toLocaleDateString(undefined,{month:"short",day:"numeric"}) : "",
    color: activeDriverObj?.color || "#3671C6", setup: lap?.setup || null,
  });

  const addCue = (text, type="info") => {
    const t = new Date();
    const time = `${t.getMinutes().toString().padStart(2,"0")}:${t.getSeconds().toString().padStart(2,"0")}`;
    setCues(prev => [...prev.slice(-59), { text, time, type }]);
  };

  // ── Tab button style ────────────────────────────────────────────────────
  const tabBtn = (t) => ({
    background: tab===t?"var(--elevated)":"transparent",
    color:      tab===t?"var(--text)":"var(--text-faint)",
    border:`1px solid ${tab===t?"var(--border-strong)":"transparent"}`,
    borderRadius:6, padding:"5px 14px", fontSize:11,
    fontWeight: tab===t?700:400, cursor:"pointer",
    letterSpacing:1, fontFamily:"inherit",
  });

  // ── Zone alert colours ──────────────────────────────────────────────────
  const zone = tel.currentZone;
  const zoneBg     = zone?.type==="brake"?"#1a0606":zone?.type==="lico"?"#1a1100":zone?.type==="ers"?"#00102a":"var(--surface)";
  const zoneBorder  = zone ? zoneFill(zone) : "var(--border)";
  const zoneLabel   = zone?.type==="brake"?"BRAKE":zone?.type==="lico"?"LIFT AND COAST":zone?.type==="ers"?`ERS — ${ERS_MODES[zone.ersMode]?.toUpperCase()}`:"CLEAR";
  const zoneColor   = zone ? zoneFill(zone) : "var(--text-faintest)";

  // Live snapshot for the Voice Coach — keeps telemetry context current even
  // when a question arrives via an async speech-recognition callback.
  coachCtxRef.current = { tel, refSample, zone, trace: activeTrace?.meta || null, evidence: lapEvidence, lapLog, trends: sessionTrends, cornerProfiles, posLabel,
    trackMismatch: tracksMismatch ? { refTrack: refTrackName, drivenTrack: drivenTrackName } : null };

  return (
    <Shell
      tab={tab} onTab={setTab} onSettings={()=>setTab("setup")}
      wsConnected={wsConnected}
      llmConnected={llmOnline}
      ffbConnected={ffb.connected}
      activeDriver={activeDriver} driverColor={activeDriverObj?.color || "#3671C6"} driverCount={drivers.length}
      onDriverChip={()=>setSwitchDriverOpen(true)}
    >
      {/* ── DASHBOARD (full-bleed redesigned screen) ── */}
      {tab==="dashboard" && (
        <DashboardScreen
          driver={activeDriverObj}
          avatar={activeDriverObj ? avatars[activeDriverObj.name] : null}
          update={appUpdate}
          laps={storedLaps}
          driverCount={drivers.length}
          units={units}
          activeSkin={activeSkin}
          onEnterCockpit={()=>setTab("live")}
          onSwitchDriver={()=>setSwitchDriverOpen(true)}
          onSelectLap={(id)=>{ setComparisonLapId(id); setTab("compare"); }}
          onOpenSetup={openSetupForLap}
          onDeleteLap={deleteLap}
        />
      )}

      {/* ── LIVE (full-bleed redesigned screen) ── */}
      {tab==="live" && (
        <LiveScreen
          tel={tel} units={units}
          trackName={trackName}
          sessionLabel={sessionTypeLabel}
          liveLapNumber={storedLaps.reduce((m,l)=>(l.meta?.sessionId===sessionId?Math.max(m,l.lapNumber||0):m),0)+1}
          laps={storedLaps} sessionId={sessionId} liveMini={liveMini}
          activeTrace={activeTrace} lastAdvice={lastAdvice}
          audioOn={audioOn} onToggleAudio={()=>setAudioOn(a=>!a)}
          focusAudioOn={focusAudioOn} onToggleFocusAudio={()=>setFocusAudioOn(a=>!a)}
          onOpenSetup={openSetupForLap} onResetSessionLaps={resetSessionLaps}
          onSaveSession={saveSession} onLoadSession={loadSession}
          onSaveMap={mapPath && mapPath.length >= 20 ? exportTrackMapPng : null}
          legendChips={LIVE_LEGEND.map(([color,label,key])=>({ color, label,
            on: liveCues[key]!==false,
            onToggle: ()=>setLiveCues(f=>({...f,[key]:!f[key]})) }))}
          mapSlot={<TrackMap telemetry={tel} zones={zones} recordedPath={mapPath}
            filters={liveCues} corners={trackCorners} W={1000} H={720} fill />}
        />
      )}

      {/* ── ANALYTICS (full-bleed redesigned screen) ── */}
      {tab==="compare" && (() => {
        const cs = comparisonLap?.samples || [];
        const rs = activeTrace?.samples || [];
        const lapLen = Math.max(
          cs.reduce((m,s)=>Math.max(m,s.dist||0),0),
          rs.reduce((m,s)=>Math.max(m,s.dist||0),0)
        ) || ((tel.lapPct>0.02 && tel.lapDistance) ? tel.lapDistance/tel.lapPct : 0);
        const comparisonLabel = comparisonLapId==="live" ? "Live lap" : (comparisonLap ? lapSourceLabel(comparisonLap) : "—");
        const referenceLabel  = activeTrace ? lapSourceLabel(activeTrace) : "ref";
        return (
        <AnalyticsScreen
          trackName={trackName} sessionLabel={sessionTypeLabel}
          laps={sessionLaps} units={units} zones={zones}
          activeTrace={activeTrace} comparisonLap={comparisonLap}
          telemetry={tel} refSample={refSample}
          referenceSources={[...refTraces, ...sessionLaps]}
          referenceId={activeTraceId} onSelectReference={setActiveTraceId}
          comparisonSources={sessionLaps}
          comparisonId={comparisonLapId} onSelectComparison={setComparisonLapId}
          onResetSessionLaps={resetSessionLaps}
          onLoadTrace={loadTrace} onRemoveTrace={removeTrace}
          onDeleteLap={deleteLap} onExportLap={exportLapToFile}
          labelFor={lapSourceLabel} onOpenSetup={openSetupForLap}
          tracesSlot={<TelemetryStudio compareSamples={cs} referenceSamples={rs} lapLength={lapLen}
            zones={zones} sectorDists={activeTrace?.meta?.sectors||[]} units={units} tempUnits={tempUnits} corners={trackCorners}
            visibleTraces={visibleTraces} onToggleTrace={toggleTrace} />}
          ersSlot={<CompareTrackMaps referenceLap={activeTrace} comparisonLap={comparisonLap}
            referenceLabel={referenceLabel} comparisonLabel={comparisonLabel}
            sessionPath={recordedPath} trackName={trackName} telemetry={tel} />}
          linesSlot={<CompareDrivingLines referenceLap={activeTrace} comparisonLap={comparisonLap}
            referenceLabel={referenceLabel} comparisonLabel={comparisonLabel}
            sessionPath={recordedPath} trackName={trackName} trackSlug={trackInfo?.slug || null}
            zones={zones} />}
          chatSlot={<CoachChat llmConfig={llmConfig} modelLabel={activeModelLabel}
            contextRef={coachCtxRef} speak={speak} health={llmHealth} />}
        />
        );
      })()}

      {/* ── SETTINGS (full-bleed redesigned screen) ── */}
      {tab==="setup" && (
        <SettingsScreen
          openRouterKey={openRouterKey} setOpenRouterKey={setOpenRouterKey}
          openRouterModel={openRouterModel} setOpenRouterModel={setOpenRouterModel}
          wsConnected={wsConnected}
          udpPort={udpPort} setUdpPort={setUdpPort}
          units={units} setUnits={setUnits}
          tempUnits={tempUnits} setTempUnits={setTempUnits}
          activeSkin={activeSkin} setActiveSkin={setActiveSkin}
          voicePrefs={voicePrefs} setVoicePrefs={setVoicePrefs} kokoro={kokoro} onTestVoice={preview}
          drivers={drivers} activeDriver={activeDriver} onSignDriver={signDriver}
          avatars={avatars} onDeleteDriver={deleteDriver} onEditDriver={editDriver}
          onExportProfile={exportProfile} onImportProfile={importProfile}
          onOpenTrace={()=>setTraceOpen(true)} onOpenCalibrator={onOpenCalibrator}
        />
      )}


      {/* ── COACH LOG (full-bleed redesigned screen) ── */}
      {tab==="coach" && (
        <CoachLogScreen
          coachLog={coachLog} trackName={trackName} sessionLabel={sessionTypeLabel}
          trends={sessionTrends}
          trackMismatch={tracksMismatch ? { refTrack: refTrackName, drivenTrack: drivenTrackName } : null}
          llmFocus={lastAdvice && lastAdvice.lap && !lastAdvice.error ? lastAdvice.text : null}
          llmSummary={lastAdvice && lastAdvice.lap && !lastAdvice.error ? lastAdvice.summary : null}
        />
      )}

      {/* ── FORCE FEEDBACK (native FFB engine control) ── */}
      {tab==="ffb" && <FfbScreen ffb={ffb} />}

      {/* ── Modals ── */}
      {switchDriverOpen && (
        <SwitchDriverModal
          drivers={drivers} activeDriver={activeDriver} avatars={avatars}
          onPick={setActiveDriver}
          onClose={()=>setSwitchDriverOpen(false)}
          onSignUp={()=>setTab("setup")}
        />
      )}
      {carSetup && <CarSetupModal pb={carSetup} onClose={()=>setCarSetup(null)} />}
      {traceOpen && <TraceConfiguratorModal channels={traceChannels} setChannels={setTraceChannels} onClose={()=>setTraceOpen(false)} />}
    </Shell>
  );
}
