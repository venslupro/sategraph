/** Share storage adapters for agent answers. */
import type { ShareStore } from '../ports';

interface Entry {
  value: string;
  expiresAt: number;
}

export class MemoryShareStore implements ShareStore {
  private readonly entries = new Map<string, Entry>();

  async get(id: string): Promise<string | null> {
    const entry = this.entries.get(id);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(id);
      return null;
    }
    return entry.value;
  }

  async put(id: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(id, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }
}

export class KvShareStore implements ShareStore {
  constructor(private readonly kv: KVNamespace) {}

  async get(id: string): Promise<string | null> {
    return this.kv.get(`share:${id}`);
  }

  async put(id: string, value: string, ttlSeconds: number): Promise<void> {
    await this.kv.put(`share:${id}`, value, {
      expirationTtl: Math.max(60, ttlSeconds),
    });
  }
}
