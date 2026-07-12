// ─── PROFILE BACKUP ───────────────────────────────────────────────────────────
// Export ONE driver's whole profile to a single .json file, and import it back —
// on this PC, a fresh install, or someone else's copy of the app. A "profile" is
// everything that makes a driver theirs:
//   • the roster entry — name, number, team, livery colour and per-driver prefs
//     (speed/temp units, coach voice, team skin)  [lives in localStorage]
//   • their profile photo (avatar)                [IndexedDB, keyed by name]
//   • every recorded lap, with its full telemetry samples  [IndexedDB]
//   • every saved circuit outline (track map)      [IndexedDB]
//
// The OpenRouter API key is deliberately NOT included — it's a global app secret,
// not a per-driver value, and a profile file is meant to be portable/shareable.
//
// Lap ids are re-minted on import so bringing a profile in never clobbers an
// unrelated lap that happens to share an id (same trick parseSessionLaps relies
// on). Import supports two collision modes decided by the caller: bring the
// profile in under a new name (a copy), or overwrite an existing driver's data —
// the caller clears the old laps/maps first for a clean replace.

import * as lapStore from "./lapStore.js";
import { downloadJson, fileSafe } from "./lapExport.js";

const PROFILE_KIND = "boxbox-profile";
const PROFILE_VERSION = 1;

// Gather everything the driver `d` (a roster object { name, number, team, color,
// prefs }) owns into one payload and download it. Returns { laps, trackMaps }
// counts so the UI can report what was saved.
export async function exportProfile(d) {
  const name = (d?.name || "").trim();
  if (!name) throw new Error("No active driver to export.");

  const [laps, avatar, trackMaps] = await Promise.all([
    lapStore.getLaps(name),
    lapStore.getAvatar(name),
    lapStore.getTrackMaps(name),
  ]);

  const payload = {
    kind: PROFILE_KIND,
    version: PROFILE_VERSION,
    exportedAt: new Date().toISOString(),
    // Roster identity + preferences (never the app's API key).
    driver: {
      name,
      number: d.number || "",
      team: d.team || "",
      color: d.color || null,
      prefs: d.prefs || null,
    },
    avatar: avatar || null, // downscaled data URL, or null
    laps,                   // full stored shape incl. samples
    trackMaps,              // [{ slug, track, path, savedAt }]
    counts: { laps: laps.length, trackMaps: trackMaps.length },
  };

  const dateTag = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, filename-safe
  const fileName = `${fileSafe(name, "Driver")} - profile - ${dateTag}.json`;
  downloadJson(payload, fileName);
  return payload.counts;
}

// Parse a profile file's text into its payload. Throws a readable message on
// anything that isn't a profile backup, so the caller can surface it. Accepts
// only files written by exportProfile (kind + driver.name required).
export function parseProfileFile(text) {
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error("Could not parse the file — it isn't valid JSON."); }

  if (!json || json.kind !== PROFILE_KIND || !json.driver || !json.driver.name) {
    throw new Error("Not a Box, Box profile backup — use “Export Profile” to create one.");
  }
  return json;
}

// Write an imported `payload` into storage under `name` (the target driver name,
// which the caller may have changed to avoid a collision). Overwriting is the
// caller's job — it clears the target's existing laps/maps first — so this only
// writes. Returns the roster entry the caller should merge into React state.
export async function importProfile(payload, { name } = {}) {
  const target = (name || payload?.driver?.name || "").trim();
  if (!target) throw new Error("No driver name to import under.");

  // Laps: re-mint ids and re-own to the target so an import can never overwrite an
  // unrelated existing lap. Keep the rest of each lap's stored shape intact.
  const laps = Array.isArray(payload.laps) ? payload.laps : [];
  for (const l of laps) {
    if (!l || typeof l !== "object") continue;
    await lapStore.putLap({
      ...l,
      id: `lap-${crypto.randomUUID()}`,
      meta: { ...(l.meta || {}), driver: target },
    });
  }

  // Avatar (putAvatar overwrites any existing photo for this name).
  if (payload.avatar) await lapStore.putAvatar(target, payload.avatar);

  // Track maps, re-keyed to the target driver.
  const maps = Array.isArray(payload.trackMaps) ? payload.trackMaps : [];
  for (const m of maps) {
    if (m?.slug && Array.isArray(m.path) && m.path.length) {
      await lapStore.putTrackMap(target, m.slug, m.track, m.path);
    }
  }

  const src = payload.driver || {};
  return {
    name: target,
    number: (src.number || "").trim(),
    team: (src.team || "").trim(),
    color: src.color || null,
    prefs: src.prefs || null,
    avatar: payload.avatar || null,
    counts: { laps: laps.length, trackMaps: maps.length },
  };
}
