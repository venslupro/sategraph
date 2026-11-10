/** Shared scheduler helpers: adapter construction and D1 publication. */
import type { Env } from '@satgraph/infra';
import {
  B2BlobStore,
  ConditionalHttpClient,
  KvReadModelStore,
} from '@satgraph/infra';
import type { ReadModelBundle } from '@satgraph/publishing';

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

  for (const edge of bundle.relations) {
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO relation_edge
           (id, type, from_id, to_id, confidence, method, layer_id, data_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          edge.id,
          edge.type,
          edge.from.id,
          edge.to.id,
          edge.confidence,
          edge.method,
          edge.from.kind === 'Satellite' ? layerOf(edge.from.id, bundle) : null,
          JSON.stringify(edge),
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

function layerOf(satelliteId: string, bundle: ReadModelBundle): string | null {
  const detail = bundle.satelliteDetails.get(satelliteId);
  return detail?.satellite.layerId ?? null;
}
