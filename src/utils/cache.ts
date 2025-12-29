/**
 * Lambda-level in-memory cache
 * Persists across warm Lambda invocations (typically 5-15 min)
 * Automatically expires entries based on TTL
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

/** Get cached value or undefined if expired/missing */
export function get<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;

  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }

  return entry.data as T;
}

/** Set a cached value with TTL in milliseconds */
export function set<T>(key: string, data: T, ttlMs: number): void {
  store.set(key, { data, expiresAt: Date.now() + ttlMs });
}

/** Delete a cached entry */
export function del(key: string): void {
  store.delete(key);
}

/** Clear all entries (useful for testing) */
export function clear(): void {
  store.clear();
}

/**
 * Get cached value or fetch and cache it
 * @param key Cache key
 * @param ttlMs Time to live in milliseconds
 * @param fetcher Async function to fetch data if not cached
 */
export async function cached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const existing = get<T>(key);
  if (existing !== undefined) return existing;

  const data = await fetcher();
  set(key, data, ttlMs);
  return data;
}

/**
 * Batch get with caching - fetches missing keys and caches results
 * @param keys Array of cache keys
 * @param ttlMs TTL for cached entries
 * @param fetcher Function that fetches data for missing keys, returns Map<key, value>
 */
export async function cachedBatch<T>(
  keys: string[],
  ttlMs: number,
  fetcher: (missingKeys: string[]) => Promise<Map<string, T>>,
): Promise<Map<string, T>> {
  const results = new Map<string, T>();
  const missingKeys: string[] = [];

  for (const key of keys) {
    const cached = get<T>(key);
    if (cached !== undefined) {
      results.set(key, cached);
    } else {
      missingKeys.push(key);
    }
  }

  if (missingKeys.length > 0) {
    const fetched = await fetcher(missingKeys);
    for (const [key, value] of fetched) {
      set(key, value, ttlMs);
      results.set(key, value);
    }
  }

  return results;
}

export const TTL = {
  RAP: 30_000,
  HISTORY: 300_000,
  ACTIVE_SELLERS: 10_000,
  LISTINGS_INDEX: 5_000,
} as const;
