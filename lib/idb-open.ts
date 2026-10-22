// Resilient IndexedDB open.
//
// Several stores open their database at a fixed version constant. The data
// backup/restore engine, however, bumps a database's version whenever it needs to
// create object stores. After restoring into a fresh browser the stored version
// can end up HIGHER than the code's constant, and `indexedDB.open(name, fixed)`
// then fails with "An attempt was made to open a database using a lower version
// than the existing version." — breaking that whole store.
//
// openIndexedDbAtLeast() opens normally at minVersion (so first-time creation and
// real upgrades run the onUpgrade callback), and only if that throws a VersionError
// (the stored DB is already newer) does it reopen without a version, adopting the
// existing schema — whose stores were already created by the restore.

export function openIndexedDbAtLeast(
  name: string,
  minVersion: number,
  onUpgrade: (db: IDBDatabase, oldVersion: number, tx: IDBTransaction | null) => void,
): Promise<IDBDatabase> {
  const openAt = (version?: number): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = version ? indexedDB.open(name, version) : indexedDB.open(name);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = (event) => onUpgrade(req.result, event.oldVersion, req.transaction);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(req.error);
    });

  return openAt(minVersion).catch((err: unknown) => {
    // The stored DB is already at a higher version (e.g. inflated by a restore) —
    // reopen at whatever version exists; its stores are already there.
    if (err instanceof DOMException && err.name === "VersionError") {
      return openAt(undefined);
    }
    throw err;
  });
}
