/**
 * Snapshot catalog reader. Used by the seed/D1 fallback path and by tests.
 */
import type { CatalogEntry } from '@sategraph/contracts';
import type { CatalogFilter, CatalogReader } from '@sategraph/catalog';

export class SnapshotCatalogReader implements CatalogReader {
  private readonly entries: CatalogEntry[];
  private readonly byId: Map<string, CatalogEntry>;

  constructor(entries: readonly CatalogEntry[]) {
    this.entries = [...entries];
    this.byId = new Map(this.entries.map((entry) => [entry.id, entry]));
  }

  async list(): Promise<CatalogEntry[]> {
    return [...this.entries];
  }

  async get(satelliteId: string): Promise<CatalogEntry | null> {
    return this.byId.get(satelliteId) ?? null;
  }

  async search(filter: CatalogFilter): Promise<CatalogEntry[]> {
    const text = (filter.text ?? '').trim().toLowerCase();
    const matches = this.entries
      .filter((entry) => {
        if (filter.layerId && entry.layerId !== filter.layerId) {
          return false;
        }
        if (filter.status && entry.status !== filter.status) {
          return false;
        }
        if (
          filter.purpose &&
          !entry.purpose.toLowerCase().includes(filter.purpose.toLowerCase())
        ) {
          return false;
        }
        if (!text) {
          return true;
        }
        return searchableText(entry).includes(text);
      })
      .sort((a, b) => scoreEntry(b, text) - scoreEntry(a, text));
    return matches.slice(0, filter.limit ?? 50);
  }
}

export function searchableText(entry: CatalogEntry): string {
  return [
    entry.name,
    entry.noradId,
    entry.cosparId ?? '',
    entry.constellationName ?? '',
    entry.operator ?? '',
    entry.purpose,
    ...entry.aliases,
  ]
    .join(' ')
    .toLowerCase();
}

export function scoreEntry(entry: CatalogEntry, query: string): number {
  if (!query) {
    return 0;
  }
  const name = entry.name.toLowerCase();
  let score = 0;
  if (name === query) {
    score += 120;
  }
  if (name.startsWith(query)) {
    score += 80;
  }
  if (name.includes(query)) {
    score += 50;
  }
  if (entry.noradId === query) {
    score += 110;
  }
  if ((entry.cosparId ?? '').toLowerCase() === query) {
    score += 90;
  }
  if (entry.aliases.some((alias) => alias.toLowerCase().includes(query))) {
    score += 40;
  }
  if ((entry.constellationName ?? '').toLowerCase().includes(query)) {
    score += 25;
  }
  return score;
}
