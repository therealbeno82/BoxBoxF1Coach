// ─── LEADERBOARD LIMITS ───────────────────────────────────────────────────────
// The numeric gates a submitted lap has to clear. Shared verbatim between the app
// (which pre-checks before spending a round trip) and the server-side validator
// (which is the one that actually decides). The server may overlay live overrides
// from its `config` table, but these committed values are the working default —
// a missing or empty override must never DISABLE a check.
//
// Pure data + pure functions. No imports beyond lib/.

// ─── Per-track lap-time floors ────────────────────────────────────────────────
// A lap faster than its track's floor is physically impossible and is rejected.
//
// HOW THESE WERE SET: ~92% of the real-world F1 pole/qualifying record for each
// circuit. The game's time-trial laps run roughly 2-5% under real pole (no fuel,
// full-attack setup, ideal conditions), so 92% clears every legitimate lap by a
// wide margin while still catching the absurd. Worked check — Monaco: real pole
// 70.3 s → floor 64.7 s, against a game TT record around 68-69 s. Comfortable.
//
// These are DELIBERATELY conservative. The cost of a floor set too high is that
// a genuinely world-class lap gets rejected and the driver has no recourse; the
// cost of one set too low is that an obviously fake lap survives to be caught by
// the four structural checks in validate.js. The second failure is much cheaper.
// Do not tighten these without checking real submissions first.
//
// Seconds. Keyed by the slug from lib/trackData.js.
export const TRACK_FLOOR_S = {
  australia:    69.9,   // Melbourne — pole ~1:15.9
  china:        86.1,   // Shanghai — pole ~1:33.6
  bahrain:      82.1,   // Sakhir — pole ~1:29.2
  spain:        65.7,   // Catalunya — pole ~1:11.4
  monaco:       64.7,   // Monaco — pole ~1:10.3
  canada:       66.2,   // Montreal — pole ~1:12.0
  silverstone:  78.9,   // Silverstone — pole ~1:25.8
  hungary:      69.2,   // Hungaroring — pole ~1:15.2
  belgium:      93.2,   // Spa — dry quali record ~1:41.3
  italy:        72.7,   // Monza — pole ~1:19.3
  singapore:    82.3,   // Singapore — pole ~1:29.5
  japan:        81.1,   // Suzuka — pole ~1:28.2
  abudhabi:     76.4,   // Yas Marina — pole ~1:22.6
  usa:          84.9,   // COTA — pole ~1:32.3
  brazil:       61.9,   // Interlagos — quali record ~1:07.3
  austria:      57.9,   // Red Bull Ring — quali record ~1:02.9
  mexico:       68.8,   // Mexico City — quali record ~1:14.8
  azerbaijan:   92.2,   // Baku — quali record ~1:40.2
  netherlands:  63.4,   // Zandvoort — quali record ~1:08.9
  imola:        68.8,   // Imola — pole ~1:14.7
  saudiarabia:  80.5,   // Jeddah — pole ~1:27.5
  miami:        80.2,   // Miami — pole ~1:27.2
  lasvegas:     84.9,   // Las Vegas — pole ~1:32.3
  qatar:        74.1,   // Losail — pole ~1:20.5
  madring:      84.6,   // Madrid — new for 2026, no real reference yet; estimated
                        // from the announced 5.47 km layout. Revisit once the
                        // circuit has actually been raced.
};

// A lap slower than this is a cruise, not a hot lap, and would only clutter the
// board. Generous on purpose: 3x the floor still allows a very bad wet lap.
export const CEILING_MULTIPLIER = 3;

export function floorFor(slug) {
  return TRACK_FLOOR_S[slug] ?? null;
}

export function ceilingFor(slug) {
  const floor = floorFor(slug);
  return floor == null ? null : floor * CEILING_MULTIPLIER;
}

// Is a claimed lap time physically possible at this circuit?
// → { ok: true } | { ok: false, reason }
// An unknown slug passes: we'd rather accept an untested circuit than reject
// every lap on it. The board key already refused anything off the calendar.
export function plausibleLapTime(slug, seconds) {
  if (typeof seconds !== "number" || !isFinite(seconds) || seconds <= 0) {
    return { ok: false, reason: "This lap has no valid lap time." };
  }
  const floor = floorFor(slug);
  if (floor == null) return { ok: true };
  if (seconds < floor) {
    return { ok: false, reason: `${seconds.toFixed(3)}s is faster than anything possible at this circuit.` };
  }
  const ceiling = ceilingFor(slug);
  if (seconds > ceiling) {
    return { ok: false, reason: `${seconds.toFixed(3)}s is too slow to be a representative lap here.` };
  }
  return { ok: true };
}

// ─── Validation thresholds ────────────────────────────────────────────────────
// Read validate.js alongside these — each constant's justification lives with the
// check that uses it.
export const THRESHOLDS = {
  // (a) Lap time re-derived from the trace, as a RATIO of the claimed time.
  //
  // THIS WINDOW IS NOT CENTRED ON 1.0, AND THAT IS DELIBERATE. Integrating a
  // 10 m distance-binned trace runs systematically HIGH — measured at +1.7% to
  // +2.3% across all 24 genuine laps of the committed demo session (Singapore,
  // dry mediums through a wet inter stint, 92 s to 127 s). That bias is in the
  // data, not the quadrature: integrating against the recording's own true time
  // axis reproduces it exactly. Coarse distance bins simply cannot resolve the
  // speed trace finely enough, and 1/v is convex, so error accumulates upward.
  //
  // The good news is how TIGHT it is — a 0.6-point spread across wet and dry —
  // which is what makes an offset window usable at all. The window below brackets
  // the observed band with room either side for circuits and driving styles the
  // demo session doesn't cover.
  //
  // MEASURED BAND (25-lap Singapore demo session): 1.0167 – 1.0229, median 1.0207.
  // The accept window below is that band plus ~2 points of headroom either side,
  // because the bias should vary with how much speed changes inside one 10 m bin
  // — a lap of slow corners (Monaco) should sit higher than a fast one (Monza),
  // and only one circuit has actually been measured.
  //
  // WHAT THIS CATCHES at the window below: a lap time shaved by more than ~3.5%,
  // i.e. over 3 s on a 90 s lap. WHAT IT DOES NOT: a 1-2 s shave. It cannot, at
  // any tolerance a real lap survives. The sector-sum check is the precise one —
  // an edited lap time almost always forgets to move the sectors with it, and
  // that's caught at 20 ms. Treat this as the coarse backstop it is.
  //
  // CALIBRATED ON REPLAY DATA, ONE CIRCUIT. The demo session is rebuilt by
  // scripts/make-demo-session.mjs from a real session export, so it is resampled
  // rather than raw recorder output. Re-measure across circuits against genuinely
  // driven laps before tightening further:
  //   node scripts/calibrate-leaderboard.mjs "path/to/session.json"
  integralRatioPassMin: 1.005,
  integralRatioPassMax: 1.045,  // inside → clean
  integralRatioMin: 0.99,
  integralRatioMax: 1.06,       // outside → rejected; between the two → flagged

  // (b) Distance coverage.
  coverageMin: 0.97,      // samples must span >= 97% of the track length
  firstDistMaxM: 30,      // the first sample must be near the start/finish line
  maxGapM: 60,            // a hole this big is a flashback or a packet-loss burst
  sampleCountMin: 0.85,   // vs the expected trackLength/10 bins
  sampleCountMax: 1.15,

  // (c) ERS cumulative counter — a descending step suggests a flashback.
  // Drops inside the first stretch of the lap are IGNORED: the game resets
  // m_ersDeployedThisLap at the start/finish line, and the recorder's first bin
  // can be captured a tick before that reset lands, so it still carries the
  // previous lap's total. One lap in the 25-lap demo session does exactly this
  // (9261 → 39 kJ at 14 m) and was being rejected as a flashback. A genuine
  // flashback landing this early would fail the coverage check anyway.
  ersResetZoneM: 150,
  ersDropKj: 2,           // below this is rounding, not a real drop
  ersDropCountFlag: 1,    // 1-2 small drops → flagged
  ersDropCountReject: 3,  // 3+ drops → rejected
  ersDropTotalFlagKj: 50, // ...or a smaller count totalling more than this
  ersDropSingleRejectKj: 100,

  // Per-lap deployment ceiling. An earlier version used the familiar 4 MJ figure
  // and rejected genuine laps, because 4 MJ is the ENERGY STORE's capacity, not a
  // deployment limit — the car harvests throughout the lap, so what it can spend
  // is the battery plus everything recovered on the way round. Under the 2026
  // rules that's roughly 4 MJ stored + up to ~8.5 MJ recovered.
  //
  // Set well above that rather than at it. The demo session peaks at 9.99 MJ and
  // those are RACE laps; boards only take qualifying and time-trial laps, where
  // deployment is maximal, so real submissions should sit higher again. The cost
  // of a ceiling set too low is rejecting somebody's genuine best lap with no
  // recourse; the cost of one set too high is that an obviously fabricated trace
  // has to be caught by one of the other four checks instead. Easy trade.
  ersMaxLapKj: 13000,

  // (d) Sector sum. The recorder derives S3 as (total - s1 - s2), so for any
  // genuine recorder lap the three sectors sum to the lap time to float
  // precision. This is by far the tightest and cheapest check we have.
  sectorSumMaxS: 0.02,
  sectorMinS: 5,

  // (f) Speed sanity.
  speedMaxKmh: 400,
  crawlSpeedKmh: 5,
  crawlFractionMax: 0.02, // more than 2% of the lap below crawl speed is not a lap

  // Structural minimums.
  minSamples: 200,
  maxInflatedBytes: 2 * 1024 * 1024, // zip-bomb guard on the upload

  // Display name.
  nameMinLen: 1,
  nameMaxLen: 24,
};
