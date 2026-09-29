// Kleiner Key-Value-Speicher auf IndexedDB-Basis (für große Caches wie die Erfolgsdaten).
const DB = (() => {
  const NAME = 'gw2-achievement-tool';
  const STORE = 'kv';
  let dbPromise;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function run(mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  return {
    async get(key) {
      try { return await run('readonly', (s) => s.get(key)); } catch (e) { console.warn('DB.get', e); return undefined; }
    },
    async set(key, value) {
      try { await run('readwrite', (s) => s.put(value, key)); } catch (e) { console.warn('DB.set', e); }
    },
    async del(key) {
      try { await run('readwrite', (s) => s.delete(key)); } catch (e) { console.warn('DB.del', e); }
    },
  };
})();

// localStorage-Helfer für kleine Einstellungen.
const Store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};
