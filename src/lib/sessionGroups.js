// ─── SESSION GROUPS ───────────────────────────────────────────────────────────
// The coarse session buckets the app compares laps within. `meta.sessionType` on
// a lap comes from format.js's sessionTypeName(), which already collapses the
// game's 18 numeric session types down to five labels; this collapses those five
// one step further, folding Sprint Shootout into Qualifying — it is a qualifying
// session by every measure that matters (low fuel, one push lap, same rubber).
//
// Lives in its own module because two features need the SAME answer and must not
// drift: lib/lapBuckets.js (which laps the coach may pool together) and
// lib/leaderboard/boardKey.js (which board an uploaded lap lands on). If the game
// ever adds another qualifying-shaped session, adding it here fixes both.
//
// NOTE for board code: this map is deliberately WIDER than what a leaderboard
// accepts — it also maps Race and Practice, which are exactly the two the boards
// refuse. Never treat "has a group" as "is boardable"; boardKey.js layers an
// explicit allow-set on top.

export const SESSION_GROUP = {
  "Race": "Race",
  "Qualifying": "Qualifying",
  "Sprint Shootout": "Qualifying",
  "Time Trial": "Time Trial",
  "Practice": "Practice",
};

// The group a lap belongs to, or "Unclassified" when it carries no session type
// (legacy history, or an imported trace tagged with free text we don't know).
// THE lookup — lapBuckets and boardKey both go through it. Own-property only: an
// imported lap's session text is arbitrary, and a bare index would hand back
// Object.prototype members for "constructor" or "toString".
export function sessionGroupOf(lap) {
  const t = lap?.meta?.sessionType;
  return (typeof t === "string" && Object.hasOwn(SESSION_GROUP, t)) ? SESSION_GROUP[t] : "Unclassified";
}
