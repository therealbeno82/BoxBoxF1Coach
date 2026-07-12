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
import { inTauri } from "../lib/env.js";
import { useTauriEvents } from "./useTauriEvents.js";

// Browser-dev fallback only. Inside Tauri the engine's own defaults are fetched
// via `get_ffb_defaults` on mount (single source of truth: ffb/settings.rs).
export const DEFAULT_FFB_SETTINGS = {
  overallStrength: 0.85,
  gripLossStrength: 0.70,
  understeerStrength: 0.80,
  oversteerStrength: 0.90,
  peakEmphasis: 0.0,
  smoothing: 0.15,
  minSpeedKmh: 10,
  ffbUpdateHz: 90,
  maxForceN: 12000,
  invertForce: false,
  lockupStrength: 0.60,
  lockupHz: 28,
  wheelspinStrength: 0.40,
  wheelspinHz: 10,
  scrubStrength: 0.50,
  scrubHz: 45,
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

const clean = (s) => ({ ...s, testForce: 0, testRumble: 0 });

const hasSavedSettings = () => !!localStorage.getItem(SETTINGS_KEY);

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
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

const pushSettings = (s) => { if (inTauri) invoke("set_ffb_settings", { settings: s }).catch(() => {}); };

export function useFfbEngine() {
  const [settings, setSettingsState] = useState(loadSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // The engine's authoritative default tuning — fetched from Rust on mount so
  // "Reset all" / fresh installs can never drift from ffb/settings.rs.
  const defaultsRef = useRef(DEFAULT_FFB_SETTINGS);
  const [status, setStatus] = useState({ deviceOpen: false, deviceName: null, activeIndex: -1, enabled: true, error: "" });
  const [devices, setDevices] = useState([]);
  const [enabled, setEnabledState] = useState(() => localStorage.getItem(ENABLED_KEY) !== "0");
  const [profiles, setProfiles] = useState(loadProfiles);
  const [activeProfile, setActiveProfile] = useState(() => localStorage.getItem(ACTIVE_KEY) || "");

  useTauriEvents({
    ffb_status: (e) => setStatus(e.payload),
  });

  const refreshDevices = useCallback(async () => {
    if (!inTauri) { setDevices([]); return; }
    try { setDevices(await invoke("get_ffb_devices")); } catch { setDevices([]); }
  }, []);

  // On mount: hand the engine our persisted settings + enabled state, list wheels,
  // and pull its default tuning (a fresh install adopts it as the live settings).
  useEffect(() => {
    pushSettings(settingsRef.current);
    if (inTauri) {
      invoke("set_ffb_enabled", { enabled }).catch(() => {});
      invoke("get_ffb_defaults").then((d) => {
        const merged = clean({ ...DEFAULT_FFB_SETTINGS, ...d });
        defaultsRef.current = merged;
        if (!hasSavedSettings()) {
          setSettingsState(merged);
          pushSettings(merged);
        }
      }).catch(() => {});
    }
    refreshDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (!inTauri) return;
    try { await invoke("open_ffb_device", { index }); }
    catch { /* the error surfaces via ffb_status */ }
  }, []);

  const closeDevice = useCallback(() => { if (inTauri) invoke("close_ffb_device").catch(() => {}); }, []);

  const setEnabled = useCallback((v) => {
    setEnabledState(v);
    localStorage.setItem(ENABLED_KEY, v ? "1" : "0");
    if (inTauri) invoke("set_ffb_enabled", { enabled: v }).catch(() => {});
  }, []);

  const resetPeak = useCallback(() => { if (inTauri) invoke("reset_ffb_peak").catch(() => {}); }, []);

  // Profiles (localStorage map name → settings).
  const saveProfileAs = useCallback((name) => {
    const nm = (name || "").trim();
    if (!nm) return;
    setProfiles((prev) => {
      const next = { ...prev, [nm]: clean(settingsRef.current) };
      localStorage.setItem(PROFILES_KEY, JSON.stringify(next));
      return next;
    });
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
    setProfiles((prev) => {
      const next = { ...prev };
      delete next[name];
      localStorage.setItem(PROFILES_KEY, JSON.stringify(next));
      return next;
    });
    setActiveProfile((cur) => {
      if (cur === name) { localStorage.removeItem(ACTIVE_KEY); return ""; }
      return cur;
    });
  }, []);

  // "MODIFIED": current sliders differ from the active profile's saved values.
  const dirty = useMemo(() => {
    if (!activeProfile || !profiles[activeProfile]) return false;
    return JSON.stringify(clean(settings)) !== JSON.stringify(profiles[activeProfile]);
  }, [settings, profiles, activeProfile]);

  return {
    settings, setSetting, applySettings, resetSettings,
    status, devices, refreshDevices,
    openDevice, closeDevice, resetPeak,
    enabled, setEnabled,
    profiles, activeProfile, dirty, saveProfileAs, saveActive, loadProfile, deleteProfile,
    connected: !!status.deviceOpen,
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
