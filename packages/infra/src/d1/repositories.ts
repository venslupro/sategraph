/**
 * D1 read-side adapters. D1 is the authoritative store for the catalog/search
 * projection and domain events; graph data lives in Neo4j.
 */
import type {
  CatalogEntry,
  DomainEventView,
} from '@satgraph/contracts';
import type { CatalogFilter, CatalogReader } from '@satgraph/catalog';
import type { EventReader } from '../ports';

interface SatelliteRow {
  data_json: string;
}

function parseEntry(row: SatelliteRow): CatalogEntry | null {
  try {
    return JSON.parse(row.data_json) as CatalogEntry;
  } catch {
    return null;
  }
}

export class D1CatalogReader implements CatalogReader {
  constructor(private readonly db: D1Database) {}

  async list(): Promise<CatalogEntry[]> {
    const result = await this.db
      .prepare('SELECT data_json FROM satellite_search ORDER BY name')
      .all<SatelliteRow>();
    return (result.results ?? [])
      .map(parseEntry)
      .filter((entry): entry is CatalogEntry => entry !== null);
  }

  async get(satelliteId: string): Promise<CatalogEntry | null> {
    const row = await this.db
      .prepare('SELECT data_json FROM satellite_search WHERE id = ?')
      .bind(satelliteId)
      .first<SatelliteRow>();
    return row ? parseEntry(row) : null;
  }

  async search(filter: CatalogFilter): Promise<CatalogEntry[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filter.text) {
      conditions.push('(lower(name) LIKE ? OR lower(aliases) LIKE ? OR norad_id = ?)');
      const like = `%${filter.text.toLowerCase()}%`;
      values.push(like, like, filter.text);
    }
    if (filter.layerId) {
      conditions.push('layer_id = ?');
      values.push(filter.layerId);
    }
    if (filter.status) {
      conditions.push('status = ?');
      values.push(filter.status);
    }
    if (filter.purpose) {
      conditions.push('lower(purpose) LIKE ?');
      values.push(`%${filter.purpose.toLowerCase()}%`);
    }
    const sql = `SELECT data_json FROM satellite_search${
      conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    } ORDER BY name LIMIT ?`;
    const result = await this.db
      .prepare(sql)
      .bind(...values, filter.limit ?? 50)
      .all<SatelliteRow>();
    return (result.results ?? [])
      .map(parseEntry)
      .filter((entry): entry is CatalogEntry => entry !== null);
  }
}

export class D1EventReader implements EventReader {
  constructor(private readonly db: D1Database) {}

  async list(sinceHours: number, limit: number): Promise<DomainEventView[]> {
    const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
    const result = await this.db
      .prepare(
        'SELECT data_json FROM domain_event WHERE occurred_at >= ? ORDER BY occurred_at DESC LIMIT ?',
      )
      .bind(since, limit)
      .all<{ data_json: string }>();
    return (result.results ?? [])
      .map((row): DomainEventView | null => {
        try {
          return JSON.parse(row.data_json) as DomainEventView;
        } catch {
          return null;
        }
      })
      .filter((event): event is DomainEventView => event !== null);
  }

  async recentForAggregate(
    aggregateId: string,
    limit: number,
  ): Promise<DomainEventView[]> {
    const result = await this.db
      .prepare(
        'SELECT data_json FROM domain_event WHERE aggregate_id = ? ORDER BY occurred_at DESC LIMIT ?',
      )
      .bind(aggregateId, limit)
      .all<{ data_json: string }>();
    return (result.results ?? [])
      .map((row): DomainEventView | null => {
        try {
          return JSON.parse(row.data_json) as DomainEventView;
        } catch {
          return null;
        }
      })
      .filter((event): event is DomainEventView => event !== null);
  }
}
