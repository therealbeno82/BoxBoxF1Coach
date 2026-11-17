import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSubmission, sanitizeDisplayName } from "../src/lib/leaderboard/validate.js";
import { getTrackByName } from "../src/lib/trackData.js";
import { lapTraceMeta } from "../src/lib/lapTrace.js";
import { computeDriverStats, bestSectorsAt } from "../src/lib/driverStats.js";
import { demoLap } from "./helpers.mjs";

const slug = getTrackByName("Singapore")?.slug;

const submit = (lap, over = {}) => validateSubmission({
  samples: lap.samples, lapTime: lap.lapTime, sectorTimes: lap.sectorTimes,
  trackLengthM: lap.meta.trackLengthM, slug, ...over,
});

test("an honest recorded lap passes the validator", () => {
  assert.ok(slug, "Singapore resolves to a calendar slug");
  const v = submit(demoLap(3));
  assert.equal(v.ok, true, v.reason);
});

test("an edited lap time is refused (sector sum no longer matches)", () => {
  const lap = demoLap(3);
  assert.equal(submit(lap, { lapTime: lap.lapTime - 2 }).ok, false);
});

test("a truncated trace is refused on coverage", () => {
  const lap = demoLap(3);
  assert.equal(submit(lap, { samples: lap.samples.slice(0, Math.floor(lap.samples.length / 2)) }).ok, false);
});

test("missing sector splits are refused, not waved through", () => {
  assert.equal(submit(demoLap(3), { sectorTimes: null }).ok, false);
});

test("display names lose control/bidi characters and adverts", () => {
  assert.equal(sanitizeDisplayName("  Max‮  Power\n"), "Max Power");
  assert.equal(sanitizeDisplayName("visit www.cheats.com"), null);
});

// ── A10: the file export and the upload share one meta block ──
test("lapTraceMeta carries identity, length, sectors, conditions and invalid", () => {
  const lap = demoLap(3);
  lap.invalid = true;
  lap.meta.trackSlug = slug;
  lap.meta.sectors = [1800, 3500];
  const m = lapTraceMeta(lap);
  assert.equal(m.trackSlug, slug);
  assert.equal(m.trackLengthM, 4930);
  assert.deepEqual(m.sectors, [1800, 3500]);
  assert.equal(m.invalid, true);
  assert.equal(typeof m.weather, "number");
  // Optional fields are omitted, not nulled, when the lap doesn't carry them.
  const bare = lapTraceMeta({ lapTime: 90, meta: {} });
  assert.equal("trackSlug" in bare, false);
  assert.equal("invalid" in bare, false);
});

// ── A3: sector bests belong to one circuit and one condition ──
test("bestSectorsAt grades against the same track and the same rubber", () => {
  const sing = demoLap(3);                               // Singapore, dry
  const monza = { ...demoLap(4), id: "m", meta: { ...demoLap(4).meta, track: "Monza" },
    lapTime: 80, sectorTimes: [26, 27, 27] };            // faster overall, elsewhere
  const wet = { ...demoLap(5), id: "w", tyre: { visual: 8 }, sectorTimes: [40, 50, 35], lapTime: 125 };
  const stats = computeDriverStats([sing, monza, wet]);
  assert.equal(stats.fastestOverall.meta.track, "Monza");
  assert.deepEqual(bestSectorsAt(stats, "Singapore", "dry"), sing.sectorTimes);
  assert.deepEqual(bestSectorsAt(stats, "Singapore", "wet"), [40, 50, 35]);
  assert.deepEqual(bestSectorsAt(stats, "Spa", "dry"), [null, null, null]);
});
