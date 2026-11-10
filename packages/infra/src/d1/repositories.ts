/**
 * D1 read-side adapters. D1 is the degraded backup for graph reads and the
 * authoritative store for events, search projection and agent analytics.
 */
import type {
  CatalogEntry,
  DomainEventView,
  GraphNode,
  Neighborhood,
  Relation,
  RelationPath,
  RelationType,
} from '@satgraph/contracts';
import type { CatalogFilter, CatalogReader } from '@satgraph/catalog';
import type { GraphReadPort } from '@satgraph/graph';
import type { EventReader } from '../ports';

interface RelationRow {
  data_json: string;
}

interface SatelliteRow {
  data_json: string;
}

function parseRelation(row: RelationRow): Relation | null {
  try {
    return JSON.parse(row.data_json) as Relation;
  } catch {
    return null;
  }
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

export class D1GraphRepository implements GraphReadPort {
  constructor(private readonly db: D1Database) {}

  async listRelations(satelliteId: string): Promise<Relation[]> {
    const result = await this.db
      .prepare(
        'SELECT data_json FROM relation_edge WHERE from_id = ? OR to_id = ? LIMIT 500',
      )
      .bind(satelliteId, satelliteId)
      .all<RelationRow>();
    return (result.results ?? [])
      .map(parseRelation)
      .filter((relation): relation is Relation => relation !== null);
  }

  async listByType(type: RelationType, limit: number): Promise<Relation[]> {
    const result = await this.db
      .prepare(
        'SELECT data_json FROM relation_edge WHERE type = ? ORDER BY id LIMIT ?',
      )
      .bind(type, limit)
      .all<RelationRow>();
    return (result.results ?? [])
      .map(parseRelation)
      .filter((relation): relation is Relation => relation !== null);
  }

  async neighborhood(
    satelliteId: string,
    depth: number,
    limit: number,
  ): Promise<Neighborhood> {
    const rows = await this.db
      .prepare(
        `WITH RECURSIVE reach(id, depth) AS (
           SELECT ?, 0
           UNION
           SELECT CASE WHEN e.from_id = reach.id THEN e.to_id ELSE e.from_id END,
                  reach.depth + 1
           FROM relation_edge e
           JOIN reach ON e.from_id = reach.id OR e.to_id = reach.id
           WHERE reach.depth < ?
         )
         SELECT DISTINCT e.data_json
         FROM relation_edge e
         JOIN reach a ON e.from_id = a.id
         JOIN reach b ON e.to_id = b.id
         LIMIT ?`,
      )
      .bind(satelliteId, depth, limit)
      .all<RelationRow>();
    const edges = (rows.results ?? [])
      .map(parseRelation)
      .filter((relation): relation is Relation => relation !== null);
    const nodeIds = new Set<string>([satelliteId]);
    for (const edge of edges) {
      nodeIds.add(edge.from.id);
      nodeIds.add(edge.to.id);
    }
    const satellites = await this.loadSatellites([...nodeIds]);
    const nodes: GraphNode[] = [];
    for (const id of nodeIds) {
      const entry = satellites.get(id);
      if (entry) {
        nodes.push({
          id,
          name: entry.name,
          kind: 'Satellite',
          layerId: entry.layerId,
          status: entry.status,
        });
        continue;
      }
      const endpoint = edges
        .flatMap((edge) => [edge.from, edge.to])
        .find((item) => item.id === id);
      if (endpoint) {
        nodes.push({
          id: endpoint.id,
          name: endpoint.name,
          kind: endpoint.kind,
          layerId: null,
          status: null,
        });
      }
    }
    return {
      centerId: satelliteId,
      depth,
      nodes,
      edges,
      truncated: edges.length >= limit,
    };
  }

  async path(
    fromId: string,
    toId: string,
    maxDepth: number,
  ): Promise<RelationPath | null> {
    if (fromId === toId) {
      const satellites = await this.loadSatellites([fromId]);
      const entry = satellites.get(fromId);
      return {
        fromId,
        toId,
        nodes: entry
          ? [
              {
                id: entry.id,
                name: entry.name,
                kind: 'Satellite',
                layerId: entry.layerId,
                status: entry.status,
              },
            ]
          : [],
        edges: [],
      };
    }
    const result = await this.db
      .prepare('SELECT data_json FROM relation_edge LIMIT 5000')
      .all<RelationRow>();
    const edges = (result.results ?? [])
      .map(parseRelation)
      .filter((relation): relation is Relation => relation !== null);
    const adjacency = new Map<string, Relation[]>();
    for (const edge of edges) {
      for (const id of [edge.from.id, edge.to.id]) {
        const bucket = adjacency.get(id) ?? [];
        bucket.push(edge);
        adjacency.set(id, bucket);
      }
    }
    const queue: { id: string; depth: number }[] = [{ id: fromId, depth: 0 }];
    const visited = new Set<string>([fromId]);
    const parent = new Map<string, { previous: string; relation: Relation }>();
    while (queue.length > 0) {
      const current = queue.shift() as { id: string; depth: number };
      if (current.depth >= maxDepth) {
        continue;
      }
      for (const edge of adjacency.get(current.id) ?? []) {
        const other = edge.from.id === current.id ? edge.to.id : edge.from.id;
        if (visited.has(other)) {
          continue;
        }
        visited.add(other);
        parent.set(other, { previous: current.id, relation: edge });
        queue.push({ id: other, depth: current.depth + 1 });
      }
    }
    if (!parent.has(toId)) {
      return null;
    }
    const nodeIds = [toId];
    const pathEdges: Relation[] = [];
    let cursor = toId;
    while (cursor !== fromId) {
      const step = parent.get(cursor);
      if (!step) {
        break;
      }
      pathEdges.unshift(step.relation);
      nodeIds.unshift(step.previous);
      cursor = step.previous;
    }
    const satellites = await this.loadSatellites(nodeIds);
    return {
      fromId,
      toId,
      nodes: nodeIds
        .map((id): GraphNode | null => {
          const entry = satellites.get(id);
          if (entry) {
            return {
              id,
              name: entry.name,
              kind: 'Satellite',
              layerId: entry.layerId,
              status: entry.status,
            };
          }
          const endpoint = pathEdges
            .flatMap((edge) => [edge.from, edge.to])
            .find((item) => item.id === id);
          return endpoint
            ? {
                id: endpoint.id,
                name: endpoint.name,
                kind: endpoint.kind,
                layerId: null,
                status: null,
              }
            : null;
        })
        .filter((node): node is GraphNode => node !== null),
      edges: pathEdges,
    };
  }

  private async loadSatellites(ids: string[]): Promise<Map<string, CatalogEntry>> {
    const map = new Map<string, CatalogEntry>();
    if (ids.length === 0) {
      return map;
    }
    const placeholders = ids.map(() => '?').join(',');
    const result = await this.db
      .prepare(
        `SELECT data_json FROM satellite_search WHERE id IN (${placeholders})`,
      )
      .bind(...ids)
      .all<SatelliteRow>();
    for (const row of result.results ?? []) {
      const entry = parseEntry(row);
      if (entry) {
        map.set(entry.id, entry);
      }
    }
    return map;
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
