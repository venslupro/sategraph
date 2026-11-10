/** Shared scheduler helpers: adapter construction and D1 publication. */
import type { Env } from '@satgraph/infra';
import {
  B2BlobStore,
  ConditionalHttpClient,
  KvReadModelStore,
  Neo4jClient,
} from '@satgraph/infra';
import type { GraphSnapshot, ReadModelBundle } from '@satgraph/publishing';

export interface SchedulerBindings extends Env {
  ADMIN_TOKEN?: string;
}

export function blobStore(env: SchedulerBindings): B2BlobStore | null {
  if (
    env.B2_ENDPOINT &&
    env.B2_BUCKET &&
    env.B2_KEY_ID &&
    env.B2_APP_KEY
  ) {
    return new B2BlobStore({
      endpoint: env.B2_ENDPOINT,
      bucket: env.B2_BUCKET,
      keyId: env.B2_KEY_ID,
      appKey: env.B2_APP_KEY,
      region: env.B2_REGION ?? 'us-west-004',
    });
  }
  return null;
}

export function httpClient(): ConditionalHttpClient {
  return new ConditionalHttpClient();
}

export function requireKv(env: SchedulerBindings): KVNamespace {
  if (!env.SATGRAPH_KV) {
    throw new Error('SATGRAPH_KV binding is required by the scheduler');
  }
  return env.SATGRAPH_KV;
}

export function readModelStore(env: SchedulerBindings): KvReadModelStore {
  return new KvReadModelStore(requireKv(env));
}

export async function publishToD1(
  db: D1Database,
  bundle: ReadModelBundle,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  const constellationNames = new Map(
    bundle.constellations.map((item) => [item.id, item.name]),
  );

  for (const entry of bundle.catalog) {
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO satellite_search
           (id, name, aliases, cospar_id, norad_id, layer_id, purpose, status,
            constellation_name, orbit_class, data_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          entry.id,
          entry.name,
          entry.aliases.join('|'),
          entry.cosparId,
          entry.noradId,
          entry.layerId,
          entry.purpose,
          entry.status,
          entry.constellationId
            ? constellationNames.get(entry.constellationId) ?? null
            : null,
          entry.orbitClass,
          JSON.stringify(entry),
        ),
    );
  }

  for (const event of bundle.events) {
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO domain_event
           (id, type, occurred_at, aggregate_id, title, detail, graph_version, data_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          event.id,
          event.type,
          event.occurredAt,
          event.aggregateId,
          event.title,
          event.detail,
          event.graphVersion,
          JSON.stringify(event),
        ),
    );
  }

  for (let index = 0; index < statements.length; index += 50) {
    await db.batch(statements.slice(index, index + 50));
  }
}

/** Neo4j Query API client, or null when the graph store is not configured. */
export function neo4jClient(env: SchedulerBindings): Neo4jClient | null {
  if (env.NEO4J_HTTP_URL && env.NEO4J_USER && env.NEO4J_PASSWORD) {
    return new Neo4jClient({
      url: env.NEO4J_HTTP_URL,
      database: env.NEO4J_DATABASE ?? 'neo4j',
      user: env.NEO4J_USER,
      password: env.NEO4J_PASSWORD,
    });
  }
  return null;
}

/** Node labels the graph is allowed to create; mirrors the contract enum. */
const NODE_KINDS = new Set([
  'Satellite',
  'Constellation',
  'OrbitalPlane',
  'Organization',
  'Launch',
  'Bus',
]);

/** Relationship types the graph is allowed to create; mirrors the enum. */
const RELATION_TYPES = new Set([
  'MEMBER_OF',
  'IN_PLANE',
  'IN_SLOT',
  'ISL_MODELED',
  'RELAY_SERVES',
  'DOCKED_TO',
  'FORMATION_WITH',
  'LAUNCHED_IN',
  'OPERATED_BY',
  'OWNED_BY',
  'BUILT_BY',
  'USES_BUS',
  'CO_LOCATED',
  'SUCCEEDS',
]);

const NEO4J_BATCH = 500;

function chunks<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += NEO4J_BATCH) {
    result.push(items.slice(index, index + NEO4J_BATCH));
  }
  return result;
}

/**
 * Publishes the whole snapshot to Neo4j. New nodes and relationships are
 * MERGEd with the current graphVersion first and stale ones are deleted
 * afterwards, so a failed run leaves the previous version readable.
 */
export async function publishToNeo4j(
  client: Neo4jClient,
  snapshot: GraphSnapshot,
): Promise<void> {
  const version = snapshot.graphVersion;

  const satellites = snapshot.satellites.map((satellite) => ({
    id: satellite.id,
    name: satellite.name,
    layerId: satellite.layerId,
    status: satellite.status,
    purpose: satellite.purpose,
    country: satellite.country,
    operatorName: satellite.operatorName,
    constellationId: satellite.constellationId,
    cosparId: satellite.cosparId,
  }));
  for (const rows of chunks(satellites)) {
    await client.query(
      `UNWIND $rows AS row
       MERGE (n:Satellite {objectId: row.id})
       SET n.name = row.name,
           n.layerId = row.layerId,
           n.status = row.status,
           n.purpose = row.purpose,
           n.country = row.country,
           n.operatorName = row.operatorName,
           n.constellationId = row.constellationId,
           n.cosparId = row.cosparId,
           n.updatedVersion = $version`,
      { rows, version },
    );
  }

  const entityNodes: { label: string; rows: Record<string, unknown>[] }[] = [
    {
      label: 'Constellation',
      rows: snapshot.constellations.map((item) => ({
        id: item.id,
        name: item.name,
      })),
    },
    {
      label: 'Organization',
      rows: snapshot.organizations.map((item) => ({
        id: item.id,
        name: item.name,
        country: item.country,
      })),
    },
    {
      label: 'Launch',
      rows: snapshot.launches.map((item) => ({
        id: item.id,
        name: item.name,
        date: item.date,
        vehicle: item.vehicle,
        site: item.site,
      })),
    },
    {
      label: 'Bus',
      rows: snapshot.buses.map((item) => ({
        id: item.id,
        name: item.name,
        manufacturerId: item.manufacturerId,
      })),
    },
  ];
  for (const group of entityNodes) {
    for (const rows of chunks(group.rows)) {
      if (rows.length === 0) {
        continue;
      }
      await client.query(
        `UNWIND $rows AS row
         MERGE (n:${group.label} {objectId: row.id})
         SET n += row.props, n.updatedVersion = $version`,
        {
          rows: rows.map(({ id, ...props }) => ({ id, props })),
          version,
        },
      );
    }
  }

  // Endpoint stubs guarantee every relation endpoint exists even when its
  // kind has no dedicated entity collection above (for example OrbitalPlane).
  const stubs = new Map<string, { id: string; name: string }[]>();
  for (const relation of snapshot.relations) {
    for (const endpoint of [relation.from, relation.to]) {
      if (endpoint.kind === 'Satellite' || !NODE_KINDS.has(endpoint.kind)) {
        continue;
      }
      const rows = stubs.get(endpoint.kind) ?? [];
      if (!rows.some((row) => row.id === endpoint.id)) {
        rows.push({ id: endpoint.id, name: endpoint.name });
      }
      stubs.set(endpoint.kind, rows);
    }
  }
  for (const [kind, rows] of stubs) {
    await client.query(
      `UNWIND $rows AS row
       MERGE (n:${kind} {objectId: row.id})
       SET n.name = row.name, n.updatedVersion = $version`,
      { rows, version },
    );
  }

  const relationsByType = new Map<string, Record<string, unknown>[]>();
  for (const relation of snapshot.relations) {
    if (!RELATION_TYPES.has(relation.type)) {
      continue;
    }
    const rows = relationsByType.get(relation.type) ?? [];
    rows.push({
      id: relation.id,
      fromId: relation.from.id,
      toId: relation.to.id,
      confidence: relation.confidence,
      method: relation.method,
      evidence: JSON.stringify(relation.evidence),
      validFrom: relation.validFrom,
      validTo: relation.validTo,
    });
    relationsByType.set(relation.type, rows);
  }
  for (const [type, relations] of relationsByType) {
    for (const rows of chunks(relations)) {
      await client.query(
        `UNWIND $rows AS row
         MATCH (a {objectId: row.fromId}), (b {objectId: row.toId})
         MERGE (a)-[rel:${type} {id: row.id}]->(b)
         SET rel.confidence = row.confidence,
             rel.method = row.method,
             rel.evidence = row.evidence,
             rel.validFrom = row.validFrom,
             rel.validTo = row.validTo,
             rel.updatedVersion = $version`,
        { rows, version },
      );
    }
  }

  await client.query(
    `MATCH ()-[rel]-()
     WHERE rel.updatedVersion IS NOT NULL AND rel.updatedVersion <> $version
     DELETE rel`,
    { version },
  );
  await client.query(
    `MATCH (n)
     WHERE n.updatedVersion IS NOT NULL AND n.updatedVersion <> $version
     DETACH DELETE n`,
    { version },
  );
}
