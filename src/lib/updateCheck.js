// ─── UPDATE CHECK ────────────────────────────────────────────────────────────
// Boot-time "is there a newer release?" probe. Hits the public GitHub Releases
// API for this repo and compares the latest published tag against the running
// build's version (__APP_VERSION__, inlined from package.json by Vite — see
// vite.config.js). Notify-only: we never download or install, the dashboard
// banner just points the user at the release page. Every failure path (offline,
// no releases yet → 404, API rate-limited → 403, malformed tag) resolves to
// null so the UI simply shows nothing.

import { isAndroid } from "./env.js";

const REPO = "therealbeno82/BoxBoxF1Coach";
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

// The version this build reports. Vite replaces the __APP_VERSION__ token at
// build time; the typeof guard keeps the module importable in a raw test/runner
// context where the define isn't applied.
export const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

// Compare two semver-style versions (a leading "v" is tolerated). Returns 1 when
// a > b, -1 when a < b, 0 when equal. A pre-release sorts BEFORE its own release
// (4.2.0-beta.1 < 4.2.0), so someone running a beta is told when the final
// version ships. Splitting the whole string on "." used to read "4.2.0-beta.1"
// as 4.2.0.1 — newer than 4.2.0 — and the banner never came. Build metadata
// ("+…") is ignored.
export function compareVersions(a, b) {
  const split = (v) => {
    const s = String(v).trim().replace(/^v/i, "").split("+")[0];
    const dash = s.indexOf("-");
    return {
      core: (dash < 0 ? s : s.slice(0, dash)).split(".").map((n) => parseInt(n, 10) || 0),
      pre: dash < 0 ? [] : s.slice(dash + 1).split("."),
    };
  };
  const pa = split(a);
  const pb = split(b);
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    const diff = (pa.core[i] || 0) - (pb.core[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  // Same release number: the release itself outranks any of its pre-releases.
  if (!pa.pre.length || !pb.pre.length) {
    return pa.pre.length === pb.pre.length ? 0 : pa.pre.length ? -1 : 1;
  }
  // Both pre-releases: identifier by identifier, numbers numerically (beta.10 >
  // beta.9), a number below a word, and a shorter list below a longer one.
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// Resolves to { latestVersion, url, notes } when a newer, published (non-draft,
// non-prerelease) release exists; otherwise null. Never throws.
//
// `/releases/latest` never returns a GitHub pre-release, so a beta is opt-in:
// nobody on a stable build is nudged onto it, and a beta build hears nothing
// until the next STABLE release — which compareVersions ranks above the beta.
//
// On Android the release must also SHIP AN APK. Every release so far carries one
// asset — a Windows NSIS installer — and announcing "4.1.0 is out" to a phone
// that can do nothing with a .exe is worse than staying quiet: the banner can't
// be dismissed by acting on it. So the Android build reads the asset list and
// links straight at the .apk, which is the whole install path for a sideloaded
// app. Until APKs are published there, the check simply finds nothing.
export async function checkForUpdate(current = APP_VERSION) {
  try {
    const res = await fetch(LATEST_URL, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return null; // 404 = no releases yet, 403 = rate-limited, etc.
    const rel = await res.json();
    const tag = rel?.tag_name;
    if (!tag || rel.draft || rel.prerelease) return null;
    if (compareVersions(tag, current) <= 0) return null;

    let url = rel.html_url || `https://github.com/${REPO}/releases/latest`;
    if (isAndroid) {
      const apk = (rel.assets || []).find(
        (a) => typeof a?.name === "string" && a.name.toLowerCase().endsWith(".apk")
      );
      if (!apk) return null;
      url = apk.browser_download_url || url;
    }

    return {
      latestVersion: String(tag).replace(/^v/i, ""),
      url,
      notes: typeof rel.body === "string" ? rel.body.trim() : "",
    };
  } catch {
    return null;
  }
}
