// ─── useTrackCorners ───────────────────────────────────────────────────────────
// The numbered, named corners of the active circuit as [{ n, name, f }] with f a
// LAP fraction from start/finish — the shape the labeler, the timeline ticks and
// the track maps all consume.
//
// Positions come from the centerline we ship (public/tracks/<slug>.json `apexes`,
// measured by scripts/fit-corners.mjs) and are numbered from the real start/finish
// using the anchor trackGeometry recovers when it fits a lap. The anchor is cached
// per circuit, so this only falls back on a circuit the app has never fitted:
// then it returns the legacy hand-estimated table from cornerData, which is rough
// but better than no corner names at all.
//
// Re-numbers itself the moment an anchor lands (first fit on a new circuit), so
// the Live screen picks up correct names without a reload.
import { useEffect, useMemo, useState } from "react";
import { getCorners, resolveSlug } from "../lib/cornerData.js";
import { getAnchor, subscribeAnchors, loadApexes, cornersFrom } from "../lib/cornerAnchors.js";

export function useTrackCorners(trackRef) {
  const slug = useMemo(() => resolveSlug(trackRef), [trackRef]);
  const [apexes, setApexes] = useState(null);
  const [anchorTick, setAnchorTick] = useState(0);

  useEffect(() => {
    let live = true;
    setApexes(null);
    if (slug) loadApexes(slug).then((a) => { if (live) setApexes(a); });
    return () => { live = false; };
  }, [slug]);

  // A fit landing on this circuit changes the numbering — recompute.
  useEffect(() => subscribeAnchors(() => setAnchorTick((t) => t + 1)), []);

  return useMemo(() => {
    if (!slug) return [];
    const anchor = getAnchor(slug);
    const measured = apexes && anchor ? cornersFrom(slug, apexes, anchor) : null;
    return measured?.length ? measured : getCorners(slug);
  }, [slug, apexes, anchorTick]);
}
