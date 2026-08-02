// F1 2026 calendar — maps m_trackId (from session UDP packet) to display name,
// asset slug, and country. Index = the value the game emits in m_trackId.
//
// `name` is the CANONICAL short name and is load-bearing: it's what the lap
// recorder stamps into meta.track, what getTrackByName round-trips, and what
// sameTrack()/refMatch compare. Never change one to make a screen read better —
// every lap already in IndexedDB carries the old string. Use the display fields
// below for that instead:
//   countryName + city → trackFullName() → "Australia – Melbourne"
//   round              → CALENDAR_SLUGS, the season's running order
export const TRACKS = {
  0:  { name: 'Melbourne',   slug: 'australia',   country: 'AU', countryName: 'Australia',            city: 'Melbourne',         round: 1 },
  2:  { name: 'Shanghai',    slug: 'china',       country: 'CN', countryName: 'China',                city: 'Shanghai',          round: 2 },
  3:  { name: 'Sakhir',      slug: 'bahrain',     country: 'BH', countryName: 'Bahrain',              city: 'Sakhir',            round: 4 },
  4:  { name: 'Catalunya',   slug: 'spain',       country: 'ES', countryName: 'Spain',                city: 'Barcelona',         round: 9 },
  5:  { name: 'Monaco',      slug: 'monaco',      country: 'MC', countryName: 'Monaco',               city: 'Monte Carlo',       round: 8 },
  6:  { name: 'Montreal',    slug: 'canada',      country: 'CA', countryName: 'Canada',               city: 'Montreal',          round: 7 },
  7:  { name: 'Silverstone', slug: 'silverstone', country: 'GB', countryName: 'Great Britain',        city: 'Silverstone',       round: 11 },
  9:  { name: 'Hungaroring', slug: 'hungary',     country: 'HU', countryName: 'Hungary',              city: 'Hungaroring',       round: 13 },
  10: { name: 'Spa',         slug: 'belgium',     country: 'BE', countryName: 'Belgium',              city: 'Spa-Francorchamps', round: 12 },
  11: { name: 'Monza',       slug: 'italy',       country: 'IT', countryName: 'Italy',                city: 'Monza',             round: 15 },
  12: { name: 'Singapore',   slug: 'singapore',   country: 'SG', countryName: 'Singapore',            city: 'Marina Bay',        round: 18 },
  13: { name: 'Suzuka',      slug: 'japan',       country: 'JP', countryName: 'Japan',                city: 'Suzuka',            round: 3 },
  14: { name: 'Abu Dhabi',   slug: 'abudhabi',    country: 'AE', countryName: 'United Arab Emirates', city: 'Abu Dhabi',         round: 24 },
  15: { name: 'Texas',       slug: 'usa',         country: 'US', countryName: 'United States',        city: 'Austin',            round: 19 },
  16: { name: 'Brazil',      slug: 'brazil',      country: 'BR', countryName: 'Brazil',               city: 'São Paulo',         round: 21 },
  17: { name: 'Austria',     slug: 'austria',     country: 'AT', countryName: 'Austria',              city: 'Spielberg',         round: 10 },
  19: { name: 'Mexico City', slug: 'mexico',      country: 'MX', countryName: 'Mexico',               city: 'Mexico City',       round: 20 },
  20: { name: 'Baku',        slug: 'azerbaijan',  country: 'AZ', countryName: 'Azerbaijan',           city: 'Baku',              round: 17 },
  26: { name: 'Zandvoort',   slug: 'netherlands', country: 'NL', countryName: 'Netherlands',          city: 'Zandvoort',         round: 14 },
  27: { name: 'Imola',       slug: 'imola',       country: 'IT', countryName: 'Italy',                city: 'Imola',             round: null },
  29: { name: 'Jeddah',      slug: 'saudiarabia', country: 'SA', countryName: 'Saudi Arabia',         city: 'Jeddah',            round: 5 },
  30: { name: 'Miami',       slug: 'miami',       country: 'US', countryName: 'United States',        city: 'Miami',             round: 6 },
  31: { name: 'Las Vegas',   slug: 'lasvegas',    country: 'US', countryName: 'United States',        city: 'Las Vegas',         round: 22 },
  32: { name: 'Losail',      slug: 'qatar',       country: 'QA', countryName: 'Qatar',                city: 'Lusail',            round: 23 },
  42: { name: 'Madring',     slug: 'madring',     country: 'ES', countryName: 'Spain',                city: 'Madrid',            round: 16 },
};

// Display label: country first, then the city or circuit — "Australia – Melbourne".
// Three of the twenty-four rounds are in the United States, so leading with the
// country is what makes a list of them readable. Falls back to the short name for
// anything without the display fields.
export function trackFullName(track) {
  if (!track) return null;
  return track.countryName && track.city ? `${track.countryName} – ${track.city}` : (track.name ?? null);
}

// Every slug in the season's running order. `round` is the calendar as originally
// published, deliberately NOT whatever the running order was reshuffled into by
// postponements — a list that reorders itself mid-season is worse than one that's
// merely a round or two out of date. Circuits the game ships but the calendar
// doesn't run (Imola) have no round and sort to the end.
export const CALENDAR_SLUGS = Object.values(TRACKS)
  .slice()
  .sort((a, b) => (a.round ?? Infinity) - (b.round ?? Infinity))
  .map((t) => t.slug);

export function getTrack(id) {
  return (typeof id === 'number' && id >= 0) ? (TRACKS[id] ?? null) : null;
}

// Reverse lookup: resolve a display name ("Silverstone") or asset slug to its
// track entry. Case-insensitive; returns null when unknown.
export function getTrackByName(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  const n = name.trim().toLowerCase();
  for (const t of Object.values(TRACKS)) {
    if (t.name.toLowerCase() === n || t.slug === n) return t;
  }
  return null;
}

// Track "names" that carry no real circuit identity — a lap recorded before the
// game identified the circuit, or a hand-entered placeholder on an imported trace.
// Treated as unknown so the reference/driven track-match guard never fires on them
// (with no identity we can't positively confirm a mismatch).
const UNKNOWN_TRACK_NAMES = new Set(['', 'live', 'unknown track', 'track', '—', '-']);

export function isKnownTrackName(name) {
  return !UNKNOWN_TRACK_NAMES.has(String(name ?? '').trim().toLowerCase());
}

// Do two track names refer to the same circuit? Case/whitespace-insensitive, and
// slug-aware so a display name ("Melbourne") matches an alternate spelling that
// resolves to the same calendar slug ("australia"). Two unknown/blank names never
// count as a match.
export function sameTrack(a, b) {
  const na = String(a ?? '').trim().toLowerCase();
  const nb = String(b ?? '').trim().toLowerCase();
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = getTrackByName(a), tb = getTrackByName(b);
  return !!(ta && tb && ta.slug === tb.slug);
}
