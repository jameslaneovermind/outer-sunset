interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const DEFAULT_TTL_MS = 2 * 60 * 1000;
const STALE_TTL_MS = 30 * 60 * 1000;

const store = new Map<string, CacheEntry<unknown>>();

export function getCached<T>(key: string, ttlMs = DEFAULT_TTL_MS): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > ttlMs) return null;
  return entry.data as T;
}

export function getStale<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > STALE_TTL_MS) return null;
  return entry.data as T;
}

export function setCache<T>(key: string, data: T): void {
  store.set(key, { data, fetchedAt: Date.now() });
}

export function invalidateCache(key: string): void {
  store.delete(key);
}
