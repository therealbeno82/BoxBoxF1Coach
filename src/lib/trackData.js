// F1 2026 calendar — maps m_trackId (from session UDP packet) to display name,
// asset slug, and country. Index = the value the game emits in m_trackId.
export const TRACKS = {
  0:  { name: 'Melbourne',      slug: 'australia',    country: 'AU' },
  2:  { name: 'Shanghai',       slug: 'china',        country: 'CN' },
  3:  { name: 'Sakhir',         slug: 'bahrain',      country: 'BH' },
  4:  { name: 'Catalunya',      slug: 'spain',        country: 'ES' },
  5:  { name: 'Monaco',         slug: 'monaco',       country: 'MC' },
  6:  { name: 'Montreal',       slug: 'canada',       country: 'CA' },
  7:  { name: 'Silverstone',    slug: 'silverstone',  country: 'GB' },
  9:  { name: 'Hungaroring',    slug: 'hungary',      country: 'HU' },
  10: { name: 'Spa',            slug: 'belgium',      country: 'BE' },
  11: { name: 'Monza',          slug: 'italy',        country: 'IT' },
  12: { name: 'Singapore',      slug: 'singapore',    country: 'SG' },
  13: { name: 'Suzuka',         slug: 'japan',        country: 'JP' },
  14: { name: 'Abu Dhabi',      slug: 'abudhabi',     country: 'AE' },
  15: { name: 'Texas',          slug: 'usa',          country: 'US' },
  16: { name: 'Brazil',         slug: 'brazil',       country: 'BR' },
  17: { name: 'Austria',        slug: 'austria',      country: 'AT' },
  19: { name: 'Mexico City',    slug: 'mexico',       country: 'MX' },
  20: { name: 'Baku',           slug: 'azerbaijan',   country: 'AZ' },
  26: { name: 'Zandvoort',      slug: 'netherlands',  country: 'NL' },
  27: { name: 'Imola',          slug: 'imola',        country: 'IT' },
  29: { name: 'Jeddah',         slug: 'saudiarabia',  country: 'SA' },
  30: { name: 'Miami',          slug: 'miami',        country: 'US' },
  31: { name: 'Las Vegas',      slug: 'lasvegas',     country: 'US' },
  32: { name: 'Losail',         slug: 'qatar',        country: 'QA' },
  42: { name: 'Madring',        slug: 'madring',      country: 'ES' },
};

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
