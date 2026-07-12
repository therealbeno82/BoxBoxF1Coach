// ─── useUpdateCheck ──────────────────────────────────────────────────────────
// Runs the GitHub release check (src/lib/updateCheck.js) once on mount and
// returns the update descriptor ({ latestVersion, url, notes }) when a newer
// version is out, or null while pending / already up to date. Notify-only — the
// caller decides how to surface it. checkForUpdate swallows every failure, so
// there is no error state to expose.

import { useEffect, useState } from "react";
import { checkForUpdate } from "../lib/updateCheck.js";

export function useUpdateCheck() {
  const [update, setUpdate] = useState(null);
  useEffect(() => {
    let alive = true;
    checkForUpdate().then((u) => {
      if (alive && u) setUpdate(u);
    });
    return () => { alive = false; };
  }, []);
  return update;
}
