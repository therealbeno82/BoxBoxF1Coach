// ─── LEADERBOARD SETTINGS ───────────────────────────────────────────────────
// The master switch, what your identity actually is, and a way to take a
// published lap back down.
//
// The honest-limits block is the point of this panel. An anonymous account is
// the right default — nobody should have to make an account to put a lap on a
// board — but it has consequences a driver will otherwise only discover by
// losing something: the account lives in this install's browser storage, so
// clearing it or moving to a new PC means the entries stay up but stop being
// yours to change. Saying so here is cheaper than a support conversation later.

import { useCallback, useEffect, useState } from "react";
import { C, FONT } from "../lib/ui/tokens.js";
import { formatLapTime } from "../lib/format.js";
import { boardLabel } from "../lib/leaderboard/boardKey.js";
import { myEntries, deleteEntry, available } from "../lib/leaderboard/api.js";
import { currentUserId, isSignedIn, signOut } from "../lib/leaderboard/identity.js";
import { secOf } from "../lib/leaderboard/entries.js";
import { configured } from "../lib/leaderboard/config.js";

const label = { fontSize: 10, letterSpacing: 1.5, color: C.textMuted, textTransform: "uppercase", fontWeight: 600 };
const note = { fontSize: 10, color: C.textDim, lineHeight: 1.7 };

export default function LeaderboardSettings({ enabled, setEnabled, driver }) {
  const [entries, setEntries] = useState(null);
  const [busy, setBusy] = useState(false);
  const uid = currentUserId();

  const refresh = useCallback(async () => {
    if (!enabled || !isSignedIn()) { setEntries(null); return; }
    setEntries(await myEntries({ enabled }));
  }, [enabled]);

  useEffect(() => { refresh(); }, [refresh]);

  const remove = async (entry) => {
    const ok = window.confirm(
      `Take this lap off the leaderboard?\n\n${boardLabel(entry.boardId)}\n` +
      `${formatLapTime(secOf(entry.lapTimeMs), 3)}\n\n` +
      `It stops being visible to other drivers straight away. You can publish another lap to this board afterwards.`);
    if (!ok) return;
    setBusy(true);
    const res = await deleteEntry(entry.boardId);
    setBusy(false);
    if (res.ok) refresh();
    else window.alert(res.reason);
  };

  const forget = () => {
    const ok = window.confirm(
      "Forget this driver identity?\n\n" +
      "Laps you have already published STAY on the boards — but they stop being yours, " +
      "so you will not be able to replace or remove them. A new identity is created next " +
      "time you publish.\n\nThis cannot be undone.");
    if (ok) { signOut(); setEntries(null); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <label style={label}>Online leaderboards</label>
        <div style={{ display: "flex", gap: 8 }}>
          {[["On", true], ["Off", false]].map(([text, on]) => (
            <button key={text} onClick={() => setEnabled(on)} style={{
              padding: "9px 14px", borderRadius: 8, cursor: "pointer", fontSize: 12,
              fontWeight: 700, letterSpacing: .3, fontFamily: FONT.ui,
              background: enabled === on ? C.elevated : C.inset,
              border: `1px solid ${enabled === on ? (on ? C.blue : C.borderStrong) : C.borderInput}`,
              color: enabled === on ? "#fff" : "#9aa3b5",
            }}>{text}</button>
          ))}
        </div>
        <div style={note}>
          Compare your laps against other drivers and download theirs as reference laps.
          Turned off, the app makes no leaderboard request at all — not a failed one, none.
          Nothing is ever published without you pressing Publish on a specific lap.
        </div>
      </div>

      {!configured && (
        <div style={{ ...note, color: C.orange }}>
          This build has no leaderboard server configured, so the boards will stay empty.
        </div>
      )}

      {enabled && configured && (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <label style={label}>Published as</label>
            <div style={{ fontSize: 13, color: C.textBody2 }}>
              {driver?.name || "—"}
              {driver?.team && <span style={{ color: C.textFaint }}> · {driver.team}</span>}
            </div>
            <div style={note}>
              Your board name follows this driver profile's name. Rename the profile and
              future laps use the new name; laps already published keep the name they went
              up with.
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <label style={label}>Driver identity</label>
            <div style={{ fontFamily: FONT.mono, fontSize: 11, color: uid ? C.textMid : C.textFaint }}>
              {uid ? `${uid.slice(0, 8)}…` : "Not created yet"}
            </div>
            <div style={note}>
              {uid
                ? <>An anonymous identity, created when you first published. It lives in this
                    install only — clearing the app's data or moving to another PC means your
                    published laps stay up but stop being yours to change. There is no way to
                    recover it, so treat publishing as permanent.</>
                : <>No account yet. One is created automatically the first time you publish a
                    lap — no sign-up, no email.</>}
            </div>
            {uid && (
              <button onClick={forget} style={{
                alignSelf: "flex-start", padding: "8px 13px", borderRadius: 8, cursor: "pointer",
                fontSize: 11, fontWeight: 700, fontFamily: FONT.ui,
                border: "1px solid #4a2130", background: "rgba(255,71,87,0.08)", color: "#ff6b7d",
              }}>Forget this identity</button>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <label style={label}>Your published laps</label>
            {!available({ enabled }) ? (
              <div style={note}>Offline — connect to see or manage your entries.</div>
            ) : entries === null ? (
              <div style={note}>{isSignedIn() ? "Loading…" : "You haven't published any laps yet."}</div>
            ) : entries.length === 0 ? (
              <div style={note}>You haven't published any laps yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {entries.map((e) => (
                  <div key={e.boardId} style={{
                    display: "grid", gridTemplateColumns: "1fr 84px 30px", gap: 10, alignItems: "center",
                    background: C.inset, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 11px",
                  }}>
                    <span style={{ fontSize: 11, color: C.textMid, overflow: "hidden",
                      textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{boardLabel(e.boardId)}</span>
                    <span style={{ fontFamily: FONT.mono, fontSize: 13, fontWeight: 700,
                      textAlign: "right", color: C.textBody2 }}>{formatLapTime(secOf(e.lapTimeMs), 3)}</span>
                    <button onClick={() => remove(e)} disabled={busy} title="Remove from the leaderboard"
                      style={{
                        width: 26, height: 26, borderRadius: 7, cursor: busy ? "default" : "pointer",
                        border: "1px solid #4a2130", background: "rgba(255,71,87,0.08)",
                        color: "#ff6b7d", fontSize: 13, lineHeight: 1, opacity: busy ? 0.5 : 1,
                      }}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
