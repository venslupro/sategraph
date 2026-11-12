/**
 * Per-isolate micro cache with single-flight de-duplication. Edge caches do not
 * exist in every runtime (tests, local Node), so this is the portable layer.
 */
interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export class MicroCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly maxEntries: number;

  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries;
  }

  async getOrLoad<T>(
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      return entry.value as T;
    }
    const inFlight = this.pending.get(key);
    if (inFlight) {
      return inFlight as Promise<T>;
    }
    const promise = loader()
      .then((value) => {
        this.entries.set(key, {
          value,
          expiresAt: Date.now() + ttlSeconds * 1000,
        });
        if (this.entries.size > this.maxEntries) {
          const oldest = this.entries.keys().next().value;
          if (oldest) {
            this.entries.delete(oldest);
          }
        }
        return value;
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, promise);
    return promise;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
