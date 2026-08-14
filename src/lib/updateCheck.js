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

// Compare two dotted numeric versions (a leading "v" is tolerated). Returns 1
// when a > b, -1 when a < b, 0 when equal. Any pre-release/build suffix is
// ignored — this only needs to answer "is a newer stable out?".
export function compareVersions(a, b) {
  const parse = (v) => String(v).replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// Resolves to { latestVersion, url, notes } when a newer, published (non-draft,
// non-prerelease) release exists; otherwise null. Never throws.
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
