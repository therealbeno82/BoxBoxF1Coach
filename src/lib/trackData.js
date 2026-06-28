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
