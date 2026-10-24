// Drives the native FFB engine from React.
// ─────────────────────────────────────────────────────────────────────────────
// • Subscribes to the engine's "ffb_status" (device/connection) Tauri event.
//   The high-rate "ffb_gauges" stream lives in the separate useFfbGauges hook
//   below — mount that only where the gauges are actually rendered (FfbScreen),
//   so its ~30 Hz updates never re-render the rest of the app.
// • Invokes the engine's commands (device enumerate/open/close, push settings,
//   master enable, reset peak-force).
// • Owns persistence: settings + named profiles live in localStorage and are
//   pushed to the stateless-ish Rust engine.
//
// Diagnostic test-force / test-rumble values are live but never persisted, so the
// wheel can't spin unexpectedly on the next launch.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { inTauri, isAndroid } from "../lib/env.js";
import { saveJson } from "../lib/lapExport.js";
import { useTauriEvents } from "./useTauriEvents.js";

// Is there a native FFB engine on the other end of the IPC at all? `inTauri`
// alone is no longer the right test: Android IS Tauri, but its Rust side is
// built with `mod ffb` cfg'd out (SDL2 can't cross-compile and a phone has no
// wheel), so the seven FFB commands simply aren't registered there. Invoking
// them would reject on every call. The hook stays mounted either way — React's
// rules of hooks mean the caller can't conditionally skip it — it just goes
// quiet, and BoxBoxApp never renders the screen that would use it.
const ffbAvailable = inTauri && !isAndroid;

// Browser-dev fallback only. Inside Tauri the engine's own defaults are fetched
// via `get_ffb_defaults` on mount (single source of truth: ffb/settings.rs).
export const DEFAULT_FFB_SETTINGS = {
  overallStrength: 0.85,
  gripLossStrength: 0.70,
  understeerStrength: 0.80,
  oversteerStrength: 0.90,
  peakEmphasis: 0.0,
  smoothing: 0.15,
  interpolation: "cubic",
  interpDelayFrac: 0.5,
  minSpeedKmh: 10,
  ffbUpdateHz: 200,
  maxForceN: 12000,
  invertForce: false,
  lockupStrength: 0.60,
  lockupHz: 28,
  wheelspinStrength: 0.40,
  wheelspinHz: 10,
  scrubStrength: 0.50,
  scrubHz: 45,
  damping: 1.0,
  slewLimit: 0.0,
  brakingStrength: 0.50,
  brakingInvert: false,
  maxOutput: 1.0,
  softStartSec: 0.50,
  ttStartHoldSec: 6.0,
  runUpReleaseM: 500,
  minForce: 0.0,
  loadSensitivity: 0.0,
  loadRefN: 8000,
  testForce: 0.0,
  testRumble: 0.0,
};

const SETTINGS_KEY = "f1coach.ffbSettings";
const PROFILES_KEY = "f1coach.ffbProfiles";
const ACTIVE_KEY = "f1coach.ffbActiveProfile";
const ENABLED_KEY = "f1coach.ffbEnabled";
const RATE_MIGRATED_KEY = "f1coach.ffbRateMigrated";

const clean = (s) => ({ ...s, testForce: 0, testRumble: 0 });

const hasSavedSettings = () => !!localStorage.getItem(SETTINGS_KEY);

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    // One-time: 90 Hz used to be an unreachable "ceiling" — the loop was pinned
    // to the game's 60 Hz packets. Now that it free-runs, lift a legacy saved
    // value to the direct-drive default once, without blocking a later choice.
    if (!localStorage.getItem(RATE_MIGRATED_KEY)) {
      localStorage.setItem(RATE_MIGRATED_KEY, "1");
      if (saved.ffbUpdateHz != null && saved.ffbUpdateHz < DEFAULT_FFB_SETTINGS.ffbUpdateHz) {
        saved.ffbUpdateHz = DEFAULT_FFB_SETTINGS.ffbUpdateHz;
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(clean(saved)));
      }
    }
    return clean({ ...DEFAULT_FFB_SETTINGS, ...saved });
  } catch {
    return { ...DEFAULT_FFB_SETTINGS };
  }
}
function loadProfiles() {
  try {
    return JSON.parse(localStorage.getItem(PROFILES_KEY)) || {};
  } catch {
    return {};
  }
}

const pushSettings = (s) => { if (ffbAvailable) invoke("set_ffb_settings", { settings: s }).catch(() => {}); };

export function useFfbEngine() {
  const [settings, setSettingsState] = useState(loadSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // The engine's authoritative default tuning — fetched from Rust on mount so
  // "Reset all" / fresh installs can never drift from ffb/settings.rs.
  const defaultsRef = useRef(DEFAULT_FFB_SETTINGS);
  const [status, setStatus] = useState({ deviceOpen: false, healthy: false, deviceName: null, activeIndex: -1, enabled: true, error: "" });
  const [devices, setDevices] = useState([]);
  const [enabled, setEnabledState] = useState(() => localStorage.getItem(ENABLED_KEY) !== "0");
  const [profiles, setProfiles] = useState(loadProfiles);
  // Latest profiles for the profile actions below, so their localStorage writes
  // can stay OUTSIDE the state updater (the same rule setSetting follows).
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  const [activeProfile, setActiveProfile] = useState(() => localStorage.getItem(ACTIVE_KEY) || "");

  useTauriEvents({
    ffb_status: (e) => setStatus(e.payload),
  });

  const refreshDevices = useCallback(async () => {
    if (!ffbAvailable) { setDevices([]); return; }
    try { setDevices(await invoke("get_ffb_devices")); } catch { setDevices([]); }
  }, []);

  // On mount: hand the engine our persisted settings + enabled state, list wheels,
  // and pull its default tuning (a fresh install adopts it as the live settings).
  useEffect(() => {
    let cancelled = false;
    pushSettings(settingsRef.current);
    if (ffbAvailable) {
      invoke("set_ffb_enabled", { enabled }).catch(() => {});
      invoke("get_ffb_defaults").then((d) => {
        if (cancelled) return;
        const merged = clean({ ...DEFAULT_FFB_SETTINGS, ...d });
        defaultsRef.current = merged;
        if (!hasSavedSettings()) {
          setSettingsState(merged);
          pushSettings(merged);
        }
      }).catch(() => {});
    }
    refreshDevices();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A self-repair in the engine can re-enumerate behind this list's back (it
  // reopens a lost wheel by NAME, since the haptic index moves when the device
  // list changes), leaving the rows here pointing at the old indices. Rust only
  // ever reports a name and an index that agree, so the two disagreeing here
  // means exactly one thing: our copy is stale. Re-pull it — once per mismatch,
  // so a name the engine reports and enumeration doesn't can't spin.
  const chasedRef = useRef(null);
  useEffect(() => {
    const { deviceName, activeIndex } = status;
    const row = devices.find((d) => d.index === activeIndex);
    if (!deviceName || (row && row.name === deviceName)) { chasedRef.current = null; return; }
    const key = `${deviceName}@${activeIndex}`;
    if (chasedRef.current === key) return;
    chasedRef.current = key;
    refreshDevices();
  }, [status, devices, refreshDevices]);

  const persist = (s) => localStorage.setItem(SETTINGS_KEY, JSON.stringify(clean(s)));

  // Side effects stay OUTSIDE the state updater (updaters must stay pure —
  // StrictMode double-invokes them); settingsRef always holds the latest value.
  const setSetting = useCallback((key, value) => {
    const next = { ...settingsRef.current, [key]: value };
    persist(next);
    pushSettings(next);
    setSettingsState(next);
  }, []);

  const applySettings = useCallback((s) => {
    const next = { ...defaultsRef.current, ...s, testForce: 0, testRumble: 0 };
    setSettingsState(next);
    persist(next);
    pushSettings(next);
  }, []);

  const resetSettings = useCallback(() => applySettings(defaultsRef.current), [applySettings]);

  const openDevice = useCallback(async (index) => {
    if (!ffbAvailable) return;
    try { await invoke("open_ffb_device", { index }); }
    catch { /* the error surfaces via ffb_status */ }
  }, []);

  const closeDevice = useCallback(() => { if (ffbAvailable) invoke("close_ffb_device").catch(() => {}); }, []);

  const setEnabled = useCallback((v) => {
    setEnabledState(v);
    localStorage.setItem(ENABLED_KEY, v ? "1" : "0");
    if (ffbAvailable) invoke("set_ffb_enabled", { enabled: v }).catch(() => {});
  }, []);

  const resetPeak = useCallback(() => { if (ffbAvailable) invoke("reset_ffb_peak").catch(() => {}); }, []);

  // Snapshot the engine's bounded output history (motion → torque) and save it
  // for offline analysis with scripts/analyze-ffb-trace.mjs. Resolves false if
  // there is nothing recorded or the save dialog was cancelled.
  const exportTrace = useCallback(async () => {
    if (!ffbAvailable) return false;
    try {
      const trace = await invoke("get_ffb_trace");
      if (!trace || !Array.isArray(trace.samples) || trace.samples.length === 0) return false;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      return await saveJson(trace, `ffb-trace-${stamp}.json`);
    } catch {
      return false;
    }
  }, []);

  // Profiles (localStorage map name → settings).
  const saveProfileAs = useCallback((name) => {
    const nm = (name || "").trim();
    if (!nm) return;
    const next = { ...profilesRef.current, [nm]: clean(settingsRef.current) };
    localStorage.setItem(PROFILES_KEY, JSON.stringify(next));
    setProfiles(next);
    setActiveProfile(nm);
    localStorage.setItem(ACTIVE_KEY, nm);
  }, []);

  const saveActive = useCallback(() => {
    if (activeProfile) saveProfileAs(activeProfile);
  }, [activeProfile, saveProfileAs]);

  const loadProfile = useCallback((name) => {
    const p = profiles[name];
    if (!p) return;
    applySettings(p);
    setActiveProfile(name);
    localStorage.setItem(ACTIVE_KEY, name);
  }, [profiles, applySettings]);

  const deleteProfile = useCallback((name) => {
    const next = { ...profilesRef.current };
    delete next[name];
    localStorage.setItem(PROFILES_KEY, JSON.stringify(next));
    setProfiles(next);
    if (activeProfile === name) {
      localStorage.removeItem(ACTIVE_KEY);
      setActiveProfile("");
    }
  }, [activeProfile]);

  // "MODIFIED": current sliders differ from the active profile's saved values.
  const dirty = useMemo(() => {
    if (!activeProfile || !profiles[activeProfile]) return false;
    return JSON.stringify(clean(settings)) !== JSON.stringify(profiles[activeProfile]);
  }, [settings, profiles, activeProfile]);

  return {
    settings, setSetting, applySettings, resetSettings,
    status, devices, refreshDevices,
    openDevice, closeDevice, resetPeak, exportTrace,
    enabled, setEnabled,
    profiles, activeProfile, dirty, saveProfileAs, saveActive, loadProfile, deleteProfile,
    // "Open" is not the same as "producing force" — another app acquiring the
    // wheel stops our effects behind a handle that stays valid. The engine's
    // `healthy` flag is the one that means the wheel actually responds, so it,
    // not `deviceOpen`, is what the FFB pill reports.
    connected: !!status.deviceOpen && status.healthy !== false,
  };
}

// Live monitor data ("ffb_gauges", ~30 Hz while anything changes). A separate
// hook so only the component that renders the gauges (FfbScreen) pays for the
// re-renders — mounting it at the app root would re-render the whole tree.
export function useFfbGauges() {
  const [gauges, setGauges] = useState(null);
  useTauriEvents({
    ffb_gauges: (e) => setGauges(e.payload),
  });
  return gauges;
}
