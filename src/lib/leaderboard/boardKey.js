// ─── LEADERBOARD BOARD KEY ────────────────────────────────────────────────────
// Which online board does a lap belong to?
//
//   boardId = `${trackSlug}__${sessionGroup}`      e.g. "silverstone__qualifying"
//
// Two axes, 50 boards. Both tokens are lowercase and contain no underscore, so
// the "__" separator is unambiguous and parseBoardId is exact.
//
// WHY ONLY TWO AXES. Tyre compound was considered as a third and deliberately
// dropped: qualifying and time trial are both low-fuel push running, so a board
// is simply "the fastest lap ever set here in this session type". Every extra
// axis multiplies the number of boards and divides an already-thin population.
// Compound is still carried on the entry and shown in the table — see the note
// on comparability at the bottom of this file, it matters more than it looks.
//
// WHY NOT RACE OR PRACTICE. A race lap carries fuel and tyre management that a
// push lap doesn't, so the two aren't comparable. Practice is worse: a practice
// session can be a qualifying sim OR a race stint and the game gives us no way
// to tell, which is exactly why lib/coach/refMatch.js refuses to classify it.
//
// Pure — no React, no network, no imports outside lib/. This module is shared
// verbatim with the server-side validator, which re-derives the board id from an
// uploaded payload rather than trusting the client's.

import { TRACKS, CALENDAR_SLUGS, getTrack, getTrackByName, trackFullName } from "../trackData.js";
import { SESSION_GROUP } from "../sessionGroups.js";
import { tyreLabel, tyreCondition } from "../tyres.js";

export const BOARD_SEP = "__";

// The ONLY session groups a board accepts. SESSION_GROUP is deliberately wider
// (it also maps Race and Practice) because lapBuckets needs those; a board must
// never infer "boardable" from "has a group".
const BOARDABLE = {
  "Qualifying": "qualifying",
  "Time Trial": "time-trial",
};

// Display order for the session select, and the labels that go with the tokens.
export const SESSION_TOKENS = ["qualifying", "time-trial"];
export const SESSION_LABELS = { "qualifying": "Qualifying", "time-trial": "Time Trial" };

// Compound tokens. NOT part of the board key — used for the entry's displayed
// column and the client-side filter chips. Ordered softest-first, matching
// COMPOUND_ORDER in lib/lapBuckets.js.
export const COMPOUND_TOKENS = ["soft", "medium", "hard", "superhard", "inter", "wet"];
export const COMPOUND_LABELS = {
  soft: "Soft", medium: "Medium", hard: "Hard",
  superhard: "Super Hard", inter: "Inter", wet: "Wet",
};
const COMPOUND_TOKEN_BY_LABEL = {
  "Soft": "soft", "Medium": "medium", "Hard": "hard",
  "Super Hard": "superhard", "Inter": "inter", "Wet": "wet",
};

// Every track slug, in the season's running order (see CALENDAR_SLUGS — the
// numeric key order of TRACKS is the game's internal track id, not the calendar).
// Order matters only for display; every lookup below treats this as a set.
export const TRACK_SLUGS = CALENDAR_SLUGS;

// ─── Resolution ───────────────────────────────────────────────────────────────

// The circuit slug for a lap, or null when we can't positively identify it.
//
// Three sources, best first. Laps recorded before this feature existed only have
// the DISPLAY NAME — but meta.track is set from trackInfo?.name, which is itself
// a TRACKS[].name, so getTrackByName round-trips it exactly. That's what makes
// the whole existing lap history uploadable with no migration and no writes.
//
// Note we do NOT use isKnownTrackName() here: it only rejects ""/"Live"/"—", so
// a hand-edited trace claiming track "Nordschleife" would sail through it. A
// board key needs a real calendar hit, nothing less.
export function trackSlugForLap(lap) {
  const meta = lap?.meta || {};
  if (meta.trackSlug && TRACK_SLUGS.includes(meta.trackSlug)) return meta.trackSlug;
  const byId = getTrack(typeof meta.trackId === "number" ? meta.trackId : -1);
  if (byId) return byId.slug;
  return getTrackByName(meta.track)?.slug ?? null;
}

// The board session token for a lap, or null when the lap isn't boardable.
// Sprint Shootout folds into qualifying via SESSION_GROUP; Race, Practice and
// untagged laps all return null.
export function boardSession(lap) {
  const group = SESSION_GROUP[lap?.meta?.sessionType];
  return group ? (BOARDABLE[group] ?? null) : null;
}

// The compound token for a lap's tyre tag, or null when untagged. Display only.
export function compoundToken(lap) {
  const label = tyreLabel(lap?.tyre);
  return label ? (COMPOUND_TOKEN_BY_LABEL[label] ?? null) : null;
}

// "dry" | "wet" | null for a lap. Display only, same as the compound.
export function conditionToken(lap) {
  return tyreCondition(lap?.tyre);
}

// The board a lap belongs to.
//   → { boardId, slug, session, compound, condition }   when it's boardable
//   → { boardId: null, reason }                          with a user-facing reason
// `reason` is written to be shown verbatim in a disabled button's tooltip.
export function boardIdForLap(lap) {
  const slug = trackSlugForLap(lap);
  if (!slug) {
    return { boardId: null, reason: "This lap isn't tagged with a circuit the game's calendar knows." };
  }
  const session = boardSession(lap);
  if (!session) {
    const type = lap?.meta?.sessionType;
    return {
      boardId: null,
      reason: type
        ? `Leaderboards only take Qualifying and Time Trial laps — this one is from ${type}.`
        : "This lap has no session type, so there's no board it belongs on.",
    };
  }
  return {
    boardId: `${slug}${BOARD_SEP}${session}`,
    slug,
    session,
    compound: compoundToken(lap),
    condition: conditionToken(lap),
  };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

// "silverstone__qualifying" → { slug, session } | null. Strict: an id whose parts
// aren't both recognised is treated as unknown rather than half-parsed.
export function parseBoardId(boardId) {
  const parts = String(boardId ?? "").split(BOARD_SEP);
  if (parts.length !== 2) return null;
  const [slug, session] = parts;
  if (!TRACK_SLUGS.includes(slug) || !SESSION_TOKENS.includes(session)) return null;
  return { slug, session };
}

// "Great Britain – Silverstone · Qualifying", or null for an id we can't parse.
// Note the two separators are different characters on purpose: the en dash joins
// country to circuit, the middot joins circuit to session.
export function boardLabel(boardId) {
  const parsed = parseBoardId(boardId);
  if (!parsed) return null;
  return `${trackDisplayName(parsed.slug)} · ${SESSION_LABELS[parsed.session]}`;
}

const trackForSlug = (slug) => Object.values(TRACKS).find((t) => t.slug === slug) ?? null;

// Canonical short name for a slug ("silverstone" → "Silverstone"). This is the
// MATCHING name — it's what refMatch/sameTrack compare a lap's meta.track
// against, so it must stay the string the recorder stamps. For anything a driver
// reads, use trackDisplayName.
export function trackNameForSlug(slug) {
  return trackForSlug(slug)?.name ?? slug;
}

// What the driver reads: "silverstone" → "Great Britain – Silverstone".
export function trackDisplayName(slug) {
  return trackFullName(trackForSlug(slug)) ?? slug;
}

// Every board id, in calendar order then session order. The Leaderboard screen
// builds its selects from this rather than from whatever happens to have entries,
// so an empty board is still reachable.
export function allBoardIds() {
  const out = [];
  for (const slug of TRACK_SLUGS) {
    for (const session of SESSION_TOKENS) out.push(`${slug}${BOARD_SEP}${session}`);
  }
  return out;
}

// ─── A note on compound, for whoever wires the download button ────────────────
// Compound is NOT part of the board key, but lib/coach/refMatch.js still blocks
// on it: a reference set on Softs against a lap driven on Mediums mutes every
// corner call and withholds the debrief. So a board can legitimately hold a Soft
// reference and an Inter reference side by side, and downloading the wrong one
// yields a reference the coach silently refuses to use.
//
// The board UI therefore has to show the compound on every row AND preview
// comparability with matchReference() before the user commits to a download.
// Don't drop that — it's the one place where dropping the compound axis costs
// something, and it's cheap to pay for.
