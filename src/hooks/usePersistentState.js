// ─── PERSISTENT STATE ─────────────────────────────────────────────────────────
// `useState` that loads its first value from localStorage and writes every change
// back. The hub used to spell this out a dozen times — a lazy initializer that
// read and parsed the key, then a matching effect that wrote it — each with its
// own idea of parsing, and none of the writes guarded, although localStorage
// throws in a private window or when storage is full.
//
//   const [port, setPort] = usePersistentState("f1coach.udpPort", 20777, {
//     read:  (raw) => { const n = parseInt(raw, 10); return n >= 1 && n <= 65535 ? n : undefined; },
//   });
//
// `read(raw)` turns the stored string into a value; returning `undefined` (or
// throwing) falls back to `initial`, so a hand-edited or stale entry can't seed a
// bad value. `write(value)` turns it back into a string (default String()).
// `initial` may be a function, as with useState.

import { useEffect, useState } from "react";

export function usePersistentState(key, initial, { read = (raw) => raw, write = String } = {}) {
  const [value, setValue] = useState(() => {
    const fallback = typeof initial === "function" ? initial() : initial;
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      const v = read(raw);
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, write(value)); } catch { /* private window / quota — keep the in-memory value */ }
  }, [key, value]); // eslint-disable-line react-hooks/exhaustive-deps
  return [value, setValue];
}

// Common readers.
export const readJson = (raw) => JSON.parse(raw);
export const readBool01 = (raw) => raw !== "0";
export const writeBool01 = (v) => (v ? "1" : "0");
