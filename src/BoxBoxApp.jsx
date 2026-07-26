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
import TelemetryStudio from "./components/TelemetryStudio.jsx";
import { exportLapToFile, exportSessionToFile, parseSessionLaps } from "./lib/lapExport.js";
import * as lapStore from "./lib/lapStore.js";
import { exportProfile as exportProfileFile, importProfile as importProfileData } from "./lib/profileBackup.js";
import { buildLapEvidence } from "./lib/lapEvidence.js";
import { buildTrends } from "./lib/lapHistory.js";
import { buildCoachingSet, lapBucket, buildPaceBuckets, buildPaceBlock } from "./lib/lapBuckets.js";
import { makeTrackLabeler } from "./lib/trackLabels.js";
// The Analytics Overview's top-down driving-lines panel. It owns the shared
// playback clock that also drives the TelemetryStudio trace cursor (state for
// both lives here in BoxBoxApp — see anaPlayhead/anaPlaying).
import DrivingLinesView from "./components/DrivingLinesView.jsx";
import { getTrack, sameTrack } from "./lib/trackData.js";
import { cornerLabel } from "./lib/cornerData.js";
import { useTrackCorners } from "./hooks/useTrackCorners.js";
import { synthesize, loadKokoro, isKokoroLoaded, DEFAULT_KOKORO_VOICE } from "./lib/kokoroTTS.js";
import { buildCoachLog } from "./lib/coach/coachLog.js";
import { matchReference, profileLabel } from "./lib/coach/refMatch.js";
import { buildDebriefPrompt } from "./lib/coach/prompts.js";
import { DEBRIEF_SCHEMA, validateTip, repairTip, cleanSummary } from "./lib/coach/schema.js";
import { collectAllowedNumbers, enforceGrounding } from "./lib/coach/guardrails.js";
import { createProvider } from "./lib/coach/provider.js";
import { PARAMS, ERS_MODES, DEFAULT_OPENROUTER_MODEL } from "./lib/coach/config.js";
import { formatLapTime, sessionTypeName, speakable, clamp, MINI_SECTORS, MINI_PER_SECTOR } from "./lib/format.js";
import { isRankable, visibleSessionLaps, lapRunKey } from "./lib/driverStats.js";
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

// How many recent comparable same-track laps the coach reasons over. Scopes every
// coaching input (evidence, structured log, trends, corner profiles) to the current
// form on THIS circuit rather than the driver's entire back-catalogue across all
// tracks — and, within that, to the current lap's BUCKET (see lib/lapBuckets.js):
// qualifying laps and race laps on each compound are never pooled, because the
// seconds between them swamped every cross-lap average and produced erratic advice.
const COACH_LAP_WINDOW = 20;

// Colour per call/zone type. ERS zones colour by their ERS mode (see zoneFill).
const ZONE_COLORS = { brake:"#ff5252", lico:"#ffab00", lift:"#ffd54f", ers:"#2979ff" };
const zoneFill = (z) => z?.type === "ers" ? (ERS_COLORS[z.ersMode] || "#2979ff") : (ZONE_COLORS[z?.type] || "#1e1e1e");
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

// Thresholds for turning one telemetry sample into a call/zone type, used by the
// reference zone-derivation (deriveZonesFromTrace) so the dashboard map and voice
// calls classify identically.
const BRAKE_ON = 12, COAST_THR = 15, LIFT_HI = 85, ERS_THR = 85;
// Classify a single sample into a pseudo-zone { type, ersMode } consumable by
// zoneFill(). hasBrake=false (trace with no brake channel) treats
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
  // Classify on the SMOOTHED throttle/brake but the raw ERS mode (via
  // classifySample, defined near zoneFill).
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
// 0 = neutral are kept legal to match the live telemetry's gear range.)
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

// The between-lap debrief is the ONLY LLM call the app makes. There used to be a
// second one — an on-track one-shot tip grounded in the live telemetry point vs the
// reference sample — but its only entry point was the Race Engineer chat panel, so
// it was orphaned when that was removed. The deterministic rule engine owns
// everything that happens mid-corner; the LLM only ever speaks between laps.
function useLLM(llmConfig) {
  const [lastAdvice, setLastAdvice] = useState(null);
  // A debrief is in flight — the Coach Log's "Ask the coach" button reads this so
  // reviewing an older lap can't queue three calls with three clicks.
  const [asking, setAsking] = useState(false);
  const abortRef = useRef(null);

  // Between-lap debrief: one improvement tip grounded ONLY in the completed-lap
  // vs reference evidence (the instantaneous point at the line is irrelevant).
  // Pipeline: prompt → provider (JSON) → validate/repair → strip ungrounded figures.
  const askLap = useCallback(async (evidence, refMeta, context = {}) => {
    if (!evidence) return null;
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setAsking(true);

    try {
      const { pace, bucket, trends, lapId } = context;
      const provider = createProvider(llmConfig);
      const { text, json } = await provider.complete({
        prompt: buildDebriefPrompt({ evidence, refMeta, pace, bucket, trends }),
        params: PARAMS.debrief,
        schema: DEBRIEF_SCHEMA,
        signal: ctrl.signal,
      });
      let result = validateTip(json);
      if (!result.ok) result = repairTip(text);     // weak model returned non-JSON
      if (!result.ok) return null;
      // The pace and trend blocks are grounding material too — every figure the
      // model was shown must stay quotable, or enforceGrounding strips the very
      // numbers that make a "you keep doing this" line land.
      const allowed = collectAllowedNumbers({ evidence: [evidence, pace, trends].filter(Boolean).join("\n") });
      const { text: grounded } = enforceGrounding(result.tip.tip, allowed);
      // The multi-sentence summary gets the same clean + grounding pass.
      let summary;
      if (json && typeof json.summary === "string") {
        const { text: gs } = enforceGrounding(cleanSummary(json.summary), allowed);
        summary = gs || undefined;
      }
      const tip = { text: grounded || result.tip.tip, severity: result.tip.severity, summary };
      // `lapId` stamps WHICH lap this debrief describes. The Coach Log can be
      // pinned to an older lap while new laps keep completing behind it, and text
      // about a lap you aren't looking at is worse than no text at all.
      setLastAdvice({ text:tip.text, severity:tip.severity, summary:tip.summary, time:Date.now(), lap:true, lapId: lapId ?? null });
      return tip.text || null;
    } catch (e) {
      if (e.name!=="AbortError") setLastAdvice({ text:providerErr(), time:Date.now(), error:true });
      return null;
    } finally {
      setAsking(false);
    }
  }, [llmConfig]);

  return { askLap, lastAdvice, asking };
}

// ─── LAP RECORDER ─────────────────────────────────────────────────────────────
// Records the active telemetry stream into the in-progress lap and freezes a lap
// when lapPct wraps (end of lap → start of next). Frozen laps are normalised to
// the reference-trace sample shape, kept in memory for the live Compare overlay,
// AND persisted to IndexedDB under the active driver (lapStore) so their history +
// dashboard stats survive restarts. Distance-binning (~10 m) keeps a ~90 s / 30 Hz
// lap to a few hundred samples. The user can still export a lap to a file too.

// Idle telemetry reading shown before the Rust telemetry core delivers a snapshot.
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

// The run-key fields as a frozen lap's meta records them — same fallbacks as the
// lap `meta` built below, so a live key and a stored lap's key always agree.
const runMeta = (m) => ({
  sessionId: m.sessionId || null,
  sessionType: m.sessionType || null,
  track: m.trackName || "Live",
});

function useLapRecorder(tel, trackName, driver, sessionId, sessionType) {
  const [storedLaps, setStoredLaps] = useState([]);
  const bufRef    = useRef({ bins: new Map(), lastPct: null, lastLapTime: 0, lastLapNum: -1, lastDriverStatus: -1, lastS1: 0, lastS2: 0, lastSetup: null, lastTyre: null, tainted: false, invalidated: false, miniBound: freshMiniBound(), miniIdx: 0 });
  const lapNumRef = useRef(0);
  // The run (session + session type + track — see lapRunKey) the lap counter is
  // currently scoped to. Lap numbering restarts at 1 whenever that changes: a fresh
  // connection, a manual "Reset Session Laps", an auto track change, or the game
  // moving from one session type to the next (Qualifying → Race). So the readout
  // never shows a running career total like "Lap 24" on the first lap of a session,
  // and a race's laps count from 1 even when qualifying laps sit above them in the
  // same panel.
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
      const m = metaRef.current;
      const run = lapRunKey(runMeta(m));
      lapNumSessionRef.current = run;
      lapNumRef.current = laps.reduce(
        (acc, l) => (lapRunKey(l.meta) === run ? Math.max(acc, l.lapNumber || 0) : acc), 0);
    });
    return () => { cancelled = true; };
  }, [driver]);

  useEffect(() => {
    const { lapDistance, lapPct, lapNumber, throttle, brake, steer, speed, gear, ersMode, ersDeploy, lapTime,
            sector1Time, sector2Time, lastLapTime, driverStatus, pitStatus, lapInvalid,
            setup, tyreVisual, tyreActual, tyreAge, tyreWear, weather, trackTemp, airTemp,
            worldX, worldY, worldZ,
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
      // / in the pits / the lap was flagged invalid (buf.tainted). When the telemetry
      // supplies driver/pit status (driverStatus is a number) taint already catches
      // all of those, so we trust it alone. Only an OLDER data source that omits those
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
        // Lap numbers are scoped to the current RUN: when the drive's session or its
        // session type changes, restart the count at 1 (see lapNumSessionRef) so the
        // first lap of a fresh session reads "Lap 1", not a continuation of the
        // driver's career total or of the qualifying laps above it.
        const run = lapRunKey(runMeta(m));
        if (lapNumSessionRef.current !== run) {
          lapNumSessionRef.current = run;
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
            // Conditions the lap was run in → the Live lap log's per-session header.
            ...(typeof weather === "number" ? { weather } : {}),
            ...(typeof trackTemp === "number" && trackTemp > 0 ? { trackTemp } : {}),
            ...(typeof airTemp === "number" && airTemp > 0 ? { airTemp } : {}),
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
    // Wear rides along on the same tag: it's the wear at the END of the lap (the
    // last tick before the line), which is what a stint review wants to read.
    if (typeof tyreVisual === "number" && tyreVisual >= 0) {
      const wear = (Array.isArray(tyreWear) && tyreWear.length === 4 && tyreWear.some(v => v > 0))
        ? tyreWear.map(v => Math.round(v * 10) / 10) : (buf.lastTyre?.wear ?? null);
      buf.lastTyre = { visual: tyreVisual, actual: tyreActual ?? -1, age: tyreAge ?? 0, ...(wear ? { wear } : {}) };
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
// caller-supplied colorAt(point, i). `path` points carry x/z (required) plus
// whatever fields colorAt reads (pct, throttle, brake, …).
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

// Render outline + coloured segments + a colour legend to a 2×-scaled canvas and
// download it as PNG or JPG, matching what's on screen. Dark background is filled
// first, so JPG (no alpha) comes out opaque.
function exportMapImage({ segs, outline, filters, legend, name, format = "png", W = 240, H = 240 }) {
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
  // proj + telemetry.worldX outside the memo).
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

  // The STATIC half of the map — outline, ~400 coloured segments, corner labels —
  // built once per geometry change and held as a memoised element tree.
  //
  // `geo` above was already memoised, but turning it into elements happened in the
  // JSX body, so the .map() re-ran on every 30 Hz telemetry tick and React
  // reconciled the whole circuit ~30×/s for the entire time the driver is on the
  // Live screen. Returning the IDENTICAL element object lets React skip the
  // subtree wholesale (element identity bail-out). The car dot below is
  // deliberately left outside this — it's the one thing that must move at full
  // rate, and it's two nodes.
  const staticMap = useMemo(() => {
    if (!geo) return null;
    return (
      <>
        <path d={geo.outline} fill="none" stroke="#111" strokeWidth={10} strokeLinejoin="round" strokeLinecap="round" />
        {geo.segs.map((s, i) => (
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
      </>
    );
  }, [geo, cornerMarks]);

  if (useReal && geo) {
    const car = (typeof telemetry.worldX === "number" && typeof telemetry.worldZ === "number")
      ? geo.proj(telemetry.worldX, telemetry.worldZ) : null;

    return (
      <svg width={fill?"100%":W} height={fill?"100%":H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ display: "block", ...(fill?{width:"100%",height:"100%"}:null) }}>
        {staticMap}
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
  // telemetry core forwards what the game sends). Persisted so the choice sticks.
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
  // ── Shared Analytics playback timeline ──
  // One clock for the whole Overview: a 0–1 lap-distance fraction + playing flag,
  // fed to BOTH the driving-lines panel and the telemetry trace stack so Play /
  // scrubbing in either moves the cars and the trace cursor together. The rAF
  // loop that advances it lives in DrivingLinesView (it owns duration/speed/loop).
  const [anaPlayhead, setAnaPlayhead] = useState(0);
  const [anaPlaying, setAnaPlaying] = useState(false);
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

  // Demo mode: the native core synthesises a lap so the whole pipeline (recorder,
  // coaching, FFB, track map) can be exercised with no game running. Two ways in,
  // and they have to agree:
  //   • the `F1_FAKE=1` env var, read by the core at startup;
  //   • this toggle, persisted per install.
  // So we don't push the saved preference until we've asked the core what it
  // started as — otherwise a saved "off" would immediately cancel an F1_FAKE=1
  // launch. Once synced, the toggle is the source of truth.
  const [fakeMode, setFakeMode] = useState(() => localStorage.getItem("f1coach.fakeMode") === "1");
  const [fakeSynced, setFakeSynced] = useState(!inTauri);
  useEffect(() => {
    if (!inTauri) return;
    let cancelled = false;
    invoke("get_fake_mode")
      .then((coreOn) => { if (!cancelled && coreOn) setFakeMode(true); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setFakeSynced(true); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!fakeSynced) return; // still reading the core's startup state
    localStorage.setItem("f1coach.fakeMode", fakeMode ? "1" : "0");
    coreInvoke("set_fake_mode", { enabled: fakeMode });
  }, [fakeMode, fakeSynced]);

  // LLM backend — OpenRouter cloud. Persisted so the user doesn't re-enter their
  // key/model each session.
  const [openRouterKey,   setOpenRouterKey]   = useState(() => localStorage.getItem("f1coach.openRouterKey") || "");
  const [openRouterModel, setOpenRouterModel] = useState(() => localStorage.getItem("f1coach.openRouterModel") || DEFAULT_OPENROUTER_MODEL);
  useEffect(() => { localStorage.setItem("f1coach.openRouterKey", openRouterKey); }, [openRouterKey]);
  useEffect(() => { localStorage.setItem("f1coach.openRouterModel", openRouterModel); }, [openRouterModel]);

  // One config object threaded to the LLM call sites (tips + debrief).
  const llmConfig = useMemo(
    () => ({ openRouterKey, openRouterModel }),
    [openRouterKey, openRouterModel]
  );

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

  // Speed units — the telemetry core always reports km/h; the driver can read km/h or
  // mph across the Live KPIs, Telemetry readouts and Corner table. Persisted.
  const [units, setUnits] = useState(() => localStorage.getItem("f1coach.units") || "km/h");
  useEffect(() => { localStorage.setItem("f1coach.units", units); }, [units]);

  // Tyre temp units — the telemetry core always reports °C; the driver can read °C or °F
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
  // A drive "session": a fresh id minted each time live telemetry connects, so
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

  // Telemetry comes solely from the Rust telemetry core. Until a connection delivers a
  // snapshot, fall back to a zeroed reading so the UI renders an idle state.
  const rawTel = liveTel || EMPTY_TEL;

  // Identify the circuit from the m_trackId the telemetry core forwards in each snapshot.
  const trackInfo = useMemo(() => getTrack(rawTel.trackId ?? -1), [rawTel.trackId]);

  // Coarse game mode (Time Trial / Qualifying / …) from the telemetry core's sessionType,
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
  // Live track map: world positions accumulated into ~12 m distance bins as you
  // drive, so the map draws the actual circuit. `pathVersion` (declared with the
  // accumulating effect below) is what re-renders it when a new bin lands.
  const trackPathRef = useRef({ bins: new Map(), lastX: null, lastZ: null });

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
  // live snapshots from the telemetry core only carry lapPct, not the zone.
  const currentZone = useMemo(
    () => zones.find(z => rawTel.lapPct >= z.start && rawTel.lapPct <= z.end) || null,
    [rawTel.lapPct, zones]
  );
  const tel = useMemo(() => ({ ...rawTel, currentZone }), [rawTel, currentZone]);

  // Accumulate world positions into ~12 m bins to trace the real circuit.
  // Bumped ONLY when the set of bins actually changes (a new ~12 m bin, or a
  // teleport wiping them) — see recordedPath below for why that distinction
  // matters. Overwriting the bin the car is currently inside doesn't move the
  // outline, so it must not count.
  const [pathVersion, setPathVersion] = useState(0);
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
    const before = rec.bins.size; // read AFTER any clear above, so a wipe counts
    rec.bins.set(Math.round((lapDistance || 0) / 12), bin);
    if (rec.bins.size !== before) setPathVersion(v => v + 1);
  }, [tel.worldX, tel.worldZ]);

  // Keyed on the bin COUNT, not on worldX/worldZ: the car sends ~30 positions a
  // second but only crosses a new 12 m bin ~5×/s at racing speed, and this
  // rebuilds + sorts a ~400-entry array. Keying it on raw position re-sorted the
  // whole circuit every tick and — because the result is a new array identity —
  // also re-fired the map-save effect below 30×/s. The outline only ever changes
  // when a bin is added, which is exactly what pathVersion tracks.
  const recordedPath = useMemo(() => {
    const bins = trackPathRef.current.bins;
    if (bins.size < 20) return null;
    return [...bins.values()].sort((a, b) => a.dist - b.dist);
  }, [pathVersion]);

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
  // colour legend, on a dark background. Renders via the exportMapImage canvas
  // pipeline so the export matches the on-screen map styling.
  // Reads mapPath — the outline actually on screen (saved circuit, else the live
  // recording) — so the export always matches what the Live map shows.
  const exportTrackMapPng = () => {
    if (!mapPath || mapPath.length < 20) return;
    const { segs, outline } = buildTrackMapGeometry(mapPath, zones, 240, 240, liveCues);
    exportMapImage({ segs, outline, filters: liveCues, legend: LIVE_LEGEND, name: trackName || "live", format: "png" });
  };

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
  // Real-world corners for the active circuit (live track id, else the reference
  // trace's track name), numbered from the real start/finish. Drives the labeler,
  // the timeline ticks and the track-map markers; empty for unknown tracks →
  // callers fall back to zones.
  const trackCorners = useTrackCorners(trackInfo?.slug || trackName);
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

  // Laps the coach is allowed to reason about:
  //   • THIS circuit only — a lap at Silverstone is never analysed against laps from
  //     another track (mixed history produced nonsense cross-track claims);
  //   • game-valid only (isRankable drops track-limits/corner-cut deleted laps).
  const trackLaps = useMemo(
    () => storedLaps.filter((l) => isRankable(l) && sameTrack(l.meta?.track, drivenTrackName)),
    [storedLaps, drivenTrackName]);

  // The newest lap on this circuit — what the driver is being coached on AS THEY
  // DRIVE, and the default subject of the Coach Log.
  const latestTrackLap = trackLaps.length ? trackLaps[trackLaps.length - 1] : null;

  // ── The lap the COACH LOG is analysing ────────────────────────────────────
  // Shared with the Analytics "Driven Lap" selector, so choosing a lap on either
  // screen moves both. Analytics' "live" option is the lap IN PROGRESS: it has no
  // lap time and only partial samples, so it can't be analysed — for the coach it
  // means "follow the newest completed lap", which is the pre-selector behaviour.
  // Anything else resolves within trackLaps, so a stale id can never point the
  // coach at another circuit's lap.
  const coachLap = useMemo(() => {
    if (comparisonLapId === "live") return latestTrackLap;
    return trackLaps.find((l) => l.id === comparisonLapId) || latestTrackLap;
  }, [comparisonLapId, trackLaps, latestTrackLap]);
  // Is the Coach Log pinned to an earlier lap rather than following the newest?
  const coachLapPinned = !!coachLap && !!latestTrackLap && coachLap.id !== latestTrackLap.id;

  // The selector is shared with Analytics, which happily lists laps the coach
  // cannot work with — an invalidated lap is still worth overlaying as a trace,
  // but it can never be coached (isRankable). Rather than quietly analysing a
  // different lap than the one named in the dropdown, say so.
  const coachLapNotice = useMemo(() => {
    if (comparisonLapId === "live") return null;
    if (trackLaps.some((l) => l.id === comparisonLapId)) return null;
    const sel = sessionLaps.find((l) => l.id === comparisonLapId);
    if (!sel) return null;
    return sel.invalid
      ? "That lap was invalidated in-game (track limits), so it can't be coached — showing your latest lap instead."
      : "That lap has no usable time or telemetry, so it can't be coached — showing your latest lap instead.";
  }, [comparisonLapId, trackLaps, sessionLaps]);

  // Is a lap and the loaded reference even the same experiment? Track, dry/wet
  // conditions, session type and tyre compound all have to line up before a
  // channel-by-channel comparison means anything (see lib/coach/refMatch.js) —
  // analysing a wet race lap on Inters against a dry qualifying lap on Softs
  // produced confident advice about deltas the driver could do nothing about.
  // Each rule fails open on missing tags, so untagged history still gets coached.
  //
  // TWO verdicts, deliberately: the LIVE one is always about the lap being driven
  // now, the COACH one about whichever lap is on the Coach Log. They're the same
  // object until the driver pins an older lap — and they must not be merged, since
  // the live verdict also silences the real-time calls (below). Reviewing a wet lap
  // from earlier in the session must never mute the calls for the dry lap in
  // progress.
  const liveRefMatch = useMemo(
    () => matchReference(latestTrackLap, activeTrace, { drivenTrack: drivenTrackName }),
    [latestTrackLap, activeTrace, drivenTrackName]);
  const liveRefMismatch = liveRefMatch && !liveRefMatch.ok ? liveRefMatch : null;

  const refMatch = useMemo(
    () => matchReference(coachLap, activeTrace, { drivenTrack: drivenTrackName }),
    [coachLap, activeTrace, drivenTrackName]);
  const refMismatch = refMatch && !refMatch.ok ? refMatch : null;

  // The LIVE verdict gates the REAL-TIME call engine. Every brake / lift-and-coast
  // / ERS zone is derived from the reference's own channels (deriveZonesFromTrace),
  // so an incomparable reference doesn't just skew the between-lap analysis — it
  // puts a dry-line braking point in the driver's ear while they're on Inters in
  // the wet. Zones stay derived (the Live map and the Analytics overlays still draw
  // the reference they belong to); it's the CALLS that fall silent, and the Live
  // screen says why so the silence doesn't read as a fault.
  const liveCalls = useMemo(
    () => (liveRefMismatch ? [] : announceCalls),
    [liveRefMismatch, announceCalls]);

  // Aggregate window for inputs that don't cite lap numbers (evidence, trends,
  // structured log) — the most recent laps on this track that are COMPARABLE with
  // the lap just completed: same session bucket, and for a race, the same tyre
  // compound. Pooling a quali lap with a race lap on hards made every average and
  // trend meaningless; this window only ever holds like-for-like laps.
  //
  // Sharing a bucket isn't enough on its own: out-laps, in-laps and traffic laps
  // pass every bucket test and then poison every cross-lap average, so the set is
  // also pace-gated (lib/lapBuckets.js). `coachingSet.dropped` carries what was
  // excluded and why, which the Coach Log shows — the driver should be able to see
  // exactly which laps produced the advice.
  //
  // Anchored on the lap being ANALYSED, not on the newest one: reviewing lap 4
  // should read as it did at the end of lap 4, so the window ends there and laps
  // driven afterwards are not folded into its "recurring" patterns.
  const coachingSet = useMemo(
    () => buildCoachingSet(trackLaps, coachLap, COACH_LAP_WINDOW),
    [trackLaps, coachLap]);
  const coachableLaps = coachingSet.laps;

  // What that window represents ("Race · Medium", "Qualifying") — shown on the
  // Coach Log so the driver can see which laps the advice was drawn from.
  const coachBucket = useMemo(
    () => (coachLap ? lapBucket(coachLap) : null),
    [coachLap]);

  // Pace per bucket across ALL of this circuit's laps — the qualifying-vs-race
  // read that replaced the setup-direction guesses. Spans every bucket (not just
  // the active one) since its whole point is the comparison between them.
  const paceBuckets = useMemo(
    () => buildPaceBuckets(trackLaps, { activeKey: coachBucket?.key || null }),
    [trackLaps, coachBucket]);

  // Both of the below analyse `coachLap` explicitly rather than "the last lap in
  // the window" — with a pinned lap those are the same thing, but naming the lap
  // means a change to the window's ordering can never silently re-point them.
  const lapEvidence = useMemo(() => {
    if (!activeTrace || refMismatch || !coachLap?.samples) return null;
    const refLapTime = activeTrace.lapTime ?? activeTrace.meta?.lapTime ?? null;
    return buildLapEvidence(coachLap.samples, activeTrace.samples,
      { labelAt: trackLabeler, userLapTime: coachLap.lapTime, refLapTime });
  }, [coachLap, activeTrace, trackLabeler, refMismatch]);

  // Structured per-channel breakdown for the Coach Log screen — the lap under
  // analysis vs the reference, with the real time-on-table distributed across
  // channels. Recomputed only on lap finish / lap selection / reference change
  // (cheap), like the evidence above. Null until there's a completed lap + a
  // reference, and while the reference isn't comparable with the lap analysed
  // (the screen shows the notice).
  const coachLog = useMemo(() => {
    if (!activeTrace || refMismatch || !coachLap?.samples) return null;
    const refLapTime = activeTrace.lapTime ?? activeTrace.meta?.lapTime ?? null;
    return buildCoachLog(coachLap, activeTrace.samples, refLapTime,
      { labelAt: trackLabeler, lapsAnalysed: coachableLaps.length });
  }, [coachLap, coachableLaps, activeTrace, trackLabeler, refMismatch]);

  // Cross-lap trends (recurring corner issues on this track), scoped to the
  // current circuit. Recomputed only when a lap completes or the reference changes.
  const sessionTrends = useMemo(() => {
    if (coachableLaps.length < 2) return null;
    // An incomparable reference (wrong track, wrong conditions, wrong compound…)
    // must not seed the "vs reference" trend lines — pass no reference on a
    // mismatch so trends stay pure like-for-like self-consistency.
    const ref = refMismatch ? null : (activeTrace?.samples || null);
    return buildTrends(coachableLaps, ref, { labelAt: trackLabeler });
  }, [coachableLaps, activeTrace, trackLabeler, refMismatch]);

  // LLM
  const { askLap, lastAdvice, asking } = useLLM(llmConfig);

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

  // Drive-session identity is minted from the GAME's per-session UID (in every UDP
  // header), but ONLY to open a panel that has none yet. A new UID deliberately does
  // NOT re-scope the panel: restarting a session in-game (the normal way to run
  // repeated qualy/practice stints on the same circuit) would otherwise drop every
  // lap driven so far. The panel therefore persists across session restarts and is
  // only cleared by a different circuit (the auto-reset effect above) or the manual
  // "Reset Session Laps" button — both of which mint their own id.
  useEffect(() => {
    const uid = rawTel.sessionUid;
    if (uid && uid !== "0") setSessionId(prev => prev || `s-${uid}`);
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

  // Append a line to the pit-wall cue feed (kept to the last 60 entries).
  const addCue = useCallback((text, type="info") => {
    const t = new Date();
    const time = `${t.getMinutes().toString().padStart(2,"0")}:${t.getSeconds().toString().padStart(2,"0")}`;
    setCues(prev => [...prev.slice(-59), { text, time, type }]);
  }, []);

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
      for (const call of liveCalls) if (tel.lapPct < call.atPct) a.set.delete(call.key);
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

    for (const call of liveCalls) {
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
    // reads 0% battery), at most once per 30 s. Deliberately OUTSIDE the reference
    // gate above — it's grounded in the car's own state, not in a comparison, so it
    // stays useful even when the loaded reference has nothing to say about this lap.
    if (wsConnected && tel.lapTime > 0 && tel.ersBattery < 15 &&
        Date.now() - lastBatteryCallRef.current > 30000) {
      lastBatteryCallRef.current = Date.now();
      speak("Battery critical — conserve ERS", "urgent");
      addCue("⚠️ Battery critical", "info");
    }
  }, [tel.lapPct, tel.speed, tel.lapDistance, tel.lapTime, tel.ersBattery,
      tel.gamePaused, tel.driverStatus, tel.pitStatus, wsConnected,
      audioOn, liveCalls, liveCues, leadSeconds, speak, beep, addCue]);

  // ── AI between-lap coach: one improvement tip when a lap completes ───────
  // Fires once per freshly-completed lap (at the start/finish line), grounded in
  // the just-finished lap vs the reference. The real-time engine owns in-corner
  // calls; this never speaks mid-corner, so the two no longer compete.
  const lastSummarisedLap = useRef(null);
  useEffect(() => {
    if (!aiActive || !activeTrace || !coachLap) return;
    // While the Coach Log is pinned to an earlier lap, every analysis input on
    // screen (evidence, trends, pace) describes THAT lap. Auto-debriefing the newly
    // completed one would send the pinned lap's evidence under the new lap's name,
    // so auto-debriefs pause while pinned and the driver drives the debrief from
    // the screen's own button. The real-time calls are unaffected either way.
    if (coachLapPinned) return;
    const lap = coachLap;
    if (lastSummarisedLap.current === lap.id) return;
    // Skip a stale lap (e.g. one finished before the AI was switched on).
    if (Date.now() - lap.recordedAt > 20000) { lastSummarisedLap.current = lap.id; return; }
    lastSummarisedLap.current = lap.id;
    if (!lapEvidence) return;
    (async () => {
      // The debrief sees the lap's evidence, the per-bucket pace picture and the
      // cross-lap trends: so it can say "that's your race pace on mediums" instead
      // of comparing the lap against a pool of unrelated qualifying runs, and can
      // tell a one-off mistake apart from the corner the driver gets wrong every lap.
      const tip = await askLap(lapEvidence, activeTrace.meta, {
        pace: buildPaceBlock(paceBuckets),
        bucket: coachBucket?.label || null,
        trends: sessionTrends,
        lapId: lap.id,
      });
      if (tip && focusAudioOn) speak(tip, "low");
      if (tip) addCue(`🤖 ${tip}`, "llm");
    })();
  }, [coachLap, coachLapPinned, aiActive, activeTrace, lapEvidence, focusAudioOn, paceBuckets, coachBucket, sessionTrends]);

  // The Coach Log's "Ask the coach" button: the same debrief, for whichever lap is
  // being reviewed. Manual rather than automatic because selecting a lap should
  // cost nothing — clicking through a stint would otherwise be one OpenRouter call
  // per click — and because the auto path deliberately skips laps older than 20s.
  const askCoachForLap = useCallback(async () => {
    if (!lapEvidence || !activeTrace || !coachLap) return;
    const tip = await askLap(lapEvidence, activeTrace.meta, {
      pace: buildPaceBlock(paceBuckets),
      bucket: coachBucket?.label || null,
      trends: sessionTrends,
      lapId: coachLap.id,
    });
    if (tip) addCue(`🤖 ${tip}`, "llm");
  }, [askLap, lapEvidence, activeTrace, coachLap, paceBuckets, coachBucket, sessionTrends, addCue]);

  // Open the Car Setup modal for a lap/trace (Dashboard, Live, Analytics).
  const openSetupForLap = (lap) => setCarSetup({
    track: lap?.meta?.track || trackName || "—",
    time: lap?.lapTime ? fmtTime(lap.lapTime) : (lap?.meta?.lapTime ? fmtTime(lap.meta.lapTime) : ""),
    date: lap?.recordedAt ? new Date(lap.recordedAt).toLocaleDateString(undefined,{month:"short",day:"numeric"}) : "",
    color: activeDriverObj?.color || "#3671C6", setup: lap?.setup || null,
  });

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

      {/* ── LIVE (full-bleed redesigned screen) ──
          Takes the LIVE reference verdict: this screen is about the lap being
          driven, and its notice explains why the real-time calls are silent.
          Never the Coach Log's verdict, which follows the lap being reviewed. */}
      {tab==="live" && (
        <LiveScreen
          tel={tel} units={units}
          trackName={trackName}
          sessionLabel={sessionTypeLabel}
          liveLapNumber={storedLaps.reduce((m,l)=>(l.meta?.sessionId===sessionId?Math.max(m,l.lapNumber||0):m),0)+1}
          laps={storedLaps} sessionId={sessionId} liveMini={liveMini}
          activeTrace={activeTrace} lastAdvice={lastAdvice} refMismatch={liveRefMismatch}
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
          laps={sessionLaps} comparisonLap={comparisonLap}
          referenceSources={[...refTraces, ...sessionLaps]}
          referenceId={activeTraceId} onSelectReference={setActiveTraceId}
          comparisonSources={sessionLaps}
          comparisonId={comparisonLapId} onSelectComparison={setComparisonLapId}
          onLoadTrace={loadTrace} onRemoveTrace={removeTrace}
          onDeleteLap={deleteLap} onExportLap={exportLapToFile}
          labelFor={lapSourceLabel} onOpenSetup={openSetupForLap}
          tracesSlot={<TelemetryStudio compareSamples={cs} referenceSamples={rs} lapLength={lapLen}
            zones={zones} sectorDists={activeTrace?.meta?.sectors||[]} units={units} tempUnits={tempUnits} corners={trackCorners}
            visibleTraces={visibleTraces} onToggleTrace={toggleTrace} compact
            playhead={anaPlayhead} playing={anaPlaying} onSeek={setAnaPlayhead} onSetPlaying={setAnaPlaying} />}
          linesSlot={<DrivingLinesView referenceLap={activeTrace} comparisonLap={comparisonLap}
            referenceLabel={referenceLabel} comparisonLabel={comparisonLabel}
            trackName={trackName} trackSlug={trackInfo?.slug || null}
            zones={zones} corners={trackCorners} lapLength={lapLen}
            playhead={anaPlayhead} playing={anaPlaying} onSeek={setAnaPlayhead} onSetPlaying={setAnaPlaying} />}
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
          fakeMode={fakeMode} setFakeMode={setFakeMode}
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


      {/* ── COACH LOG (full-bleed redesigned screen) ──
          The lap selector is the SAME state as the Analytics "Driven Lap" one, so
          a lap picked on either screen is the lap both are showing. The debrief
          text is only passed through when it was generated for the lap on screen
          (lastAdvice.lapId) — advice about a lap you aren't looking at is worse
          than none. */}
      {tab==="coach" && (() => {
        const forThisLap = lastAdvice && lastAdvice.lap && !lastAdvice.error
          && (lastAdvice.lapId == null || lastAdvice.lapId === coachLap?.id);
        return (
        <CoachLogScreen
          coachLog={coachLog} trackName={trackName} sessionLabel={sessionTypeLabel}
          trends={sessionTrends} pace={paceBuckets} coachBucket={coachBucket}
          coachingSet={coachingSet}
          refMismatch={refMismatch} refLabel={profileLabel(refMatch?.ref)}
          lapOptions={sessionLaps} lapId={comparisonLapId} onSelectLap={setComparisonLapId}
          coachLap={coachLap} pinned={coachLapPinned} labelFor={lapSourceLabel}
          lapNotice={coachLapNotice}
          onAskCoach={aiActive && lapEvidence ? askCoachForLap : null} asking={asking}
          llmFocus={forThisLap ? lastAdvice.text : null}
          llmSummary={forThisLap ? lastAdvice.summary : null}
        />
        );
      })()}

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
