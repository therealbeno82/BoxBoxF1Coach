// ─── LEADERBOARD CARD ───────────────────────────────────────────────────────
// Dashboard summary: the top of the board for the circuit you last ran, and
// where your own best lap sits on it.
//
// THIS RENDERS ON THE DEFAULT TAB AT EVERY LAUNCH, which makes it the one piece
// of leaderboard UI that has to be careful. It follows lib/updateCheck.js: the
// fetch fires from a post-paint effect, gives up after a few seconds, and every
// failure resolves to "render nothing". An offline launch must be
// indistinguishable from one where this feature doesn't exist — CLAUDE.md's
// no-network rule is about race weekends, when this is exactly the screen the
// driver opens on.

import { useEffect, useState } from "react";
import { C, FONT } from "../lib/ui/tokens.js";
import { formatLapTime } from "../lib/format.js";
import { getBoard, rankFor, myEntryOn, available } from "../lib/leaderboard/api.js";
import { lastRunBoard, secOf } from "../lib/leaderboard/entries.js";
import { boardLabel } from "../lib/leaderboard/boardKey.js";

const TOP_N = 5;

export default function LeaderboardCard({ laps = [], driver, preferSlug = null, enabled = true, cardStyle, onOpenBoard }) {
  const target = lastRunBoard(laps, { driver, preferSlug });
  const boardId = target?.boardId ?? null;
  const myBestMs = target?.best?.lapTimeMs ?? null;

  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    if (!boardId || !available({ enabled })) return;

    // Deferred past paint so the Dashboard never waits on the network to render.
    const id = setTimeout(async () => {
      const [board, rank, mine] = await Promise.all([
        getBoard(boardId, { limit: TOP_N, enabled }),
        myBestMs ? rankFor(boardId, myBestMs, { enabled }) : Promise.resolve(null),
        myEntryOn(boardId, { enabled }),
      ]);
      if (cancelled || !board || !board.entries.length) return;
      setData({ entries: board.entries, rank, published: mine });
    }, 0);

    return () => { cancelled = true; clearTimeout(id); };
  }, [boardId, myBestMs, enabled]);

  // Nothing to show, offline, or the board is empty → the card doesn't exist.
  if (!data) return null;

  const { entries, rank, published } = data;

  return (
    <div style={{ ...cardStyle, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={{ fontSize: 10, letterSpacing: 2, color: C.textMuted, textTransform: "uppercase", fontWeight: 600 }}>
          Leaderboard
        </span>
        <button onClick={onOpenBoard} style={{
          background: "transparent", border: "none", cursor: "pointer", padding: 0,
          fontSize: 9, letterSpacing: 1, color: C.textDim, fontFamily: FONT.mono,
        }}>{boardLabel(boardId)?.toUpperCase()} →</button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {entries.map((e) => (
          <div key={e.entryId} style={{
            display: "grid", gridTemplateColumns: "22px 1fr 78px", gap: 9, alignItems: "center",
            background: e.isYou ? C.elevated : "transparent",
            border: `1px solid ${e.isYou ? C.blue : "transparent"}`,
            borderRadius: 7, padding: "5px 8px",
          }}>
            <span style={{
              fontFamily: FONT.mono, fontSize: 12, fontWeight: 800,
              color: e.pos === 1 ? C.purple : C.textDim,
            }}>{e.pos}</span>
            <span style={{
              fontSize: 12, color: e.isYou ? "#fff" : C.textMid,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{e.displayName}</span>
            <span style={{
              fontFamily: FONT.mono, fontSize: 13, fontWeight: 700,
              textAlign: "right", color: e.pos === 1 ? C.purple : C.textBody2,
            }}>{formatLapTime(secOf(e.lapTimeMs), 3)}</span>
          </div>
        ))}
      </div>

      {/* Where the driver stands. "Would rank" vs "ranked" is a real distinction:
          one is an invitation to publish, the other is a result. */}
      {rank && myBestMs && (
        <div style={{
          marginTop: 12, paddingTop: 11, borderTop: `1px solid ${C.line}`,
          display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap",
        }}>
          <span style={{ fontSize: 9, letterSpacing: 1.5, color: C.textDim, textTransform: "uppercase" }}>
            {published ? "Your entry" : "Your best would rank"}
          </span>
          <span style={{ fontFamily: FONT.mono, fontSize: 15, fontWeight: 800, color: C.textHi }}>
            P{rank.pos}
          </span>
          <span style={{ fontSize: 11, color: C.textFaint }}>
            of {rank.total}
          </span>
          {entries[0] && myBestMs > entries[0].lapTimeMs && (
            <span style={{ fontFamily: FONT.mono, fontSize: 11, fontWeight: 700, color: C.textMid, marginLeft: "auto" }}>
              +{((myBestMs - entries[0].lapTimeMs) / 1000).toFixed(3)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
