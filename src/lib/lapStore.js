// ─── LAP STORE ──────────────────────────────────────────────────────────────
// Per-driver persistence of completed laps in IndexedDB, so a driver's history
// and stats survive closing the app (the in-memory recorder only kept the
// current session). Laps keep the exact shape the recorder froze — { id,
// lapNumber, recordedAt, lapTime, sectorTimes, source, meta, setup, samples } —
// with meta.driver naming the owner, so Compare / lapEvidence / lapHistory and
// the new dashboard all read the same records unchanged.
//
// IndexedDB (not localStorage) because a lap carries its full telemetry sample
// array (~tens of KB); a busy driver's history blows past localStorage's ~5 MB
// string quota but is comfortable in IndexedDB. Native API — no new deps.
//
// The same DB also holds driver avatars (the `avatars` store, keyed by driver
// name) — a downscaled photo data URL is a few KB, too bulky for the localStorage
// roster but trivial here, and it keeps a driver's picture beside their laps.

const DB_NAME = "f1coach";
const DB_VERSION = 3;
const STORE = "laps";
const AVATAR_STORE = "avatars";
const TRACKMAP_STORE = "trackmaps";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        // Query laps by their owning driver (meta.driver).
        store.createIndex("driver", "meta.driver", { unique: false });
      }
      // v2: per-driver avatar photos, keyed by driver name.
      if (!db.objectStoreNames.contains(AVATAR_STORE)) {
        db.createObjectStore(AVATAR_STORE, { keyPath: "driver" });
      }
      // v3: per-driver, per-track saved circuit outlines, keyed by "<driver>::<slug>".
      if (!db.objectStoreNames.contains(TRACKMAP_STORE)) {
        db.createObjectStore(TRACKMAP_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // Don't cache a rejected promise — let a later call retry the open.
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function avatarTx(db, mode) {
  return db.transaction(AVATAR_STORE, mode).objectStore(AVATAR_STORE);
}

function trackMapTx(db, mode) {
  return db.transaction(TRACKMAP_STORE, mode).objectStore(TRACKMAP_STORE);
}

// All laps owned by `driver`, sorted oldest → newest (recordedAt). Resolves to []
// on any failure so a storage hiccup degrades to "no history", never a crash.
export async function getLaps(driver) {
  if (!driver) return [];
  try {
    const db = await openDb();
    const laps = await new Promise((resolve, reject) => {
      const req = tx(db, "readonly").index("driver").getAll(driver);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    return laps.sort((a, b) => (a.recordedAt || 0) - (b.recordedAt || 0));
  } catch {
    return [];
  }
}

// Persist (or overwrite) a single lap. meta.driver must already name the owner.
export async function putLap(lap) {
  if (!lap?.id || !lap?.meta?.driver) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const req = tx(db, "readwrite").put(lap);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch { /* best-effort: keep the lap in memory even if the write failed */ }
}

export async function deleteLap(id) {
  if (!id) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const req = tx(db, "readwrite").delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch { /* ignore */ }
}

// Delete every lap owned by `driver` (used when a driver is removed).
export async function clearLaps(driver) {
  if (!driver) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const store = tx(db, "readwrite");
      const idxReq = store.index("driver").getAllKeys(driver);
      idxReq.onsuccess = () => {
        const keys = idxReq.result || [];
        for (const k of keys) store.delete(k);
      };
      idxReq.onerror = () => reject(idxReq.error);
      // Resolve on the transaction, not the getAllKeys callback — the deletes are
      // still in flight when onsuccess fires; oncomplete means every write landed.
      store.transaction.oncomplete = () => resolve();
      store.transaction.onerror = () => reject(store.transaction.error);
    });
  } catch { /* ignore */ }
}

// Mark every lap owned by `driver` as archived — this is what "Reset Session Laps"
// does. Archived laps are HIDDEN from the live Session-Laps / Analytics views but
// stay in the DB (and in every history, trends and dashboard query, which read all
// laps) so coaching insights still see them. Unlike the old reset — which only
// minted a fresh sessionId and so resurrected the laps on the next launch — this
// flag is persisted, so a cleared panel stays cleared across restarts.
export async function archiveLaps(driver) {
  if (!driver) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const req = tx(db, "readwrite").index("driver").openCursor(driver);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        const rec = cursor.value;
        if (rec && !rec.archived) { rec.archived = true; cursor.update(rec); }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch { /* ignore */ }
}

// ─── AVATARS ──────────────────────────────────────────────────────────────
// A driver's profile photo as a downscaled data URL (see lib/avatarImage.js).
// Best-effort like the lap helpers: a storage hiccup degrades to "no photo",
// never a crash, so the UI falls back to the initials tile.

// Resolve the stored data URL for `driver`, or null if none / on failure.
export async function getAvatar(driver) {
  if (!driver) return null;
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = avatarTx(db, "readonly").get(driver);
      req.onsuccess = () => resolve(req.result?.dataUrl || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

// Save (or overwrite) `driver`'s avatar.
export async function putAvatar(driver, dataUrl) {
  if (!driver || !dataUrl) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const req = avatarTx(db, "readwrite").put({ driver, dataUrl });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch { /* best-effort */ }
}

export async function deleteAvatar(driver) {
  if (!driver) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const req = avatarTx(db, "readwrite").delete(driver);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch { /* ignore */ }
}

// ─── TRACK MAPS ─────────────────────────────────────────────────────────────
// A driver's saved circuit outline for one track — the live world-position path
// (an array of { dist, pct, x, z, y? } bins) captured the first time they drove a
// clean lap there, then refreshed on each later clean lap. Stored so the Live map
// can draw the full circuit the moment a known track loads, instead of redrawing
// it lap-by-lap. Keyed by "<driver>::<slug>" so each profile keeps its own map.
// Best-effort like the lap/avatar helpers: failures degrade to "no saved map".

function trackMapKey(driver, slug) {
  return `${driver}::${slug}`;
}

// Resolve the saved outline path for `driver` on `slug`, or null if none / on failure.
export async function getTrackMap(driver, slug) {
  if (!driver || !slug) return null;
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = trackMapTx(db, "readonly").get(trackMapKey(driver, slug));
      req.onsuccess = () => resolve(req.result?.path || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

// Save (or overwrite) the outline for `driver` on `slug`.
export async function putTrackMap(driver, slug, track, path) {
  if (!driver || !slug || !path?.length) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const req = trackMapTx(db, "readwrite").put({
        key: trackMapKey(driver, slug), driver, slug, track, path, savedAt: Date.now(),
      });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch { /* best-effort */ }
}

// Every saved circuit outline owned by `driver`, as portable rows
// { slug, track, path, savedAt } (the composite key is dropped — it's rebuilt
// from driver+slug on import). Used by the profile backup export. Resolves to []
// on any failure, like the other readers.
export async function getTrackMaps(driver) {
  if (!driver) return [];
  try {
    const db = await openDb();
    const all = await new Promise((resolve, reject) => {
      const req = trackMapTx(db, "readonly").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    return all
      .filter((r) => r?.driver === driver)
      .map(({ slug, track, path, savedAt }) => ({ slug, track, path, savedAt }));
  } catch {
    return [];
  }
}

// Delete every saved outline owned by `driver` — used when a profile import
// overwrites an existing driver, so the incoming maps replace (not merge with)
// the old ones.
export async function clearTrackMaps(driver) {
  if (!driver) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const store = trackMapTx(db, "readwrite");
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return; // resolve on transaction complete, not here
        if (cursor.value?.driver === driver) cursor.delete();
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
      store.transaction.oncomplete = () => resolve();
      store.transaction.onerror = () => reject(store.transaction.error);
    });
  } catch { /* ignore */ }
}

// ─── RENAME ─────────────────────────────────────────────────────────────────
// Re-file every record owned by `oldName` under `newName` — used when a driver
// profile is renamed in Settings. The driver name is the key their whole history
// hangs off: laps (meta.driver), their avatar row (keyed by name) and every saved
// track map (keyed by "<driver>::<slug>"). Moving all three keeps a renamed
// driver's laps, photo and circuit outlines intact. Best-effort like the rest of
// the store — a partial rename still leaves each record readable under whichever
// name it landed on, never a crash.
export async function renameDriver(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  try {
    const db = await openDb();
    // Laps: rewrite meta.driver on each of the driver's laps (the id key is
    // unchanged, so the record moves owners without being re-created).
    await new Promise((resolve, reject) => {
      const req = tx(db, "readwrite").index("driver").openCursor(oldName);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        const rec = cursor.value;
        if (rec?.meta) { rec.meta = { ...rec.meta, driver: newName }; cursor.update(rec); }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
    // Avatar: copy the photo to the new key, then drop the old row.
    const avatar = await getAvatar(oldName);
    if (avatar) { await putAvatar(newName, avatar); await deleteAvatar(oldName); }
    // Track maps: re-key each "<old>::<slug>" record to "<new>::<slug>". The guard
    // on rec.driver skips the freshly-put records the cursor may revisit, so this
    // never loops.
    await new Promise((resolve, reject) => {
      const store = trackMapTx(db, "readwrite");
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        const rec = cursor.value;
        if (rec?.driver === oldName) {
          store.put({ ...rec, key: trackMapKey(newName, rec.slug), driver: newName });
          cursor.delete();
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch { /* best-effort */ }
}
