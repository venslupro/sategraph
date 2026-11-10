/** Read-model store port plus KV and in-memory adapters. */
export interface ReadModelStore {
  get<T>(key: string): Promise<T | null>;
  getText(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds?: number): Promise<void>;
  putMany(
    entries: { key: string; value: string; ttlSeconds?: number }[],
  ): Promise<void>;
}

export class KvReadModelStore implements ReadModelStore {
  constructor(private readonly kv: KVNamespace) {}

  async get<T>(key: string): Promise<T | null> {
    const text = await this.kv.get(key);
    if (text === null) {
      return null;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  async getText(key: string): Promise<string | null> {
    return this.kv.get(key);
  }

  async put(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.kv.put(
      key,
      value,
      ttlSeconds ? { expirationTtl: Math.max(60, ttlSeconds) } : undefined,
    );
  }

  async putMany(
    entries: { key: string; value: string; ttlSeconds?: number }[],
  ): Promise<void> {
    // KV bulk writes are not available on every plan; write with small batches
    // so the worker stays within the subrequest limit.
    for (const entry of entries) {
      await this.put(entry.key, entry.value, entry.ttlSeconds);
    }
  }
}

interface MemoryEntry {
  value: string;
  expiresAt: number | null;
}

export class MemoryReadModelStore implements ReadModelStore {
  private readonly entries = new Map<string, MemoryEntry>();

  async get<T>(key: string): Promise<T | null> {
    const text = await this.getText(key);
    if (text === null) {
      return null;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  async getText(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async putMany(
    entries: { key: string; value: string; ttlSeconds?: number }[],
  ): Promise<void> {
    for (const entry of entries) {
      await this.put(entry.key, entry.value, entry.ttlSeconds);
    }
  }
}
