/**
 * Graph publication. The graph is rebuilt from the curated seed catalog and the
 * latest published orbit elements, written to Neo4j (the graph store), then
 * projected into KV read models and the D1 search projection. Publication is
 * idempotent and versioned; a failed run leaves the previous version in place.
 */
import type { GraphSnapshot } from '@satgraph/publishing';
import { buildReadModels, buildSeedSnapshot, readModelEntries } from '@satgraph/publishing';
import type { Manifest } from '@satgraph/contracts';
import type { SchedulerBindings } from '../services';
import { blobStore, neo4jClient, publishToD1, publishToNeo4j, readModelStore } from '../services';

const HASH_KEY = 'state:graph-hash';
const HISTORY_KEY = 'history:snapshots';

export interface GraphRefreshResult {
  changed: boolean;
  graphVersion: string;
  orbitVersion: string;
  satelliteCount: number;
  relationCount: number;
  staged: boolean;
}

export interface PublishedSnapshotSummary {
  graphVersion: string;
  orbitVersion: string;
  generatedAt: string;
  satelliteCount: number;
  relationCount: number;
}

/** FNV-1a over the parts that change the graph; cheap and stable. */
function contentHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function versionStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function rebrand(snapshot: GraphSnapshot, graphVersion: string, generatedAt: string): GraphSnapshot {
  return {
    ...snapshot,
    graphVersion,
    generatedAt,
    relations: snapshot.relations.map((relation) => ({
      ...relation,
      updatedVersion: graphVersion,
    })),
    events: snapshot.events.map((event) => ({ ...event, graphVersion })),
  };
}

/**
 * Builds the snapshot for publication. The current orbit version is attached so
 * every cache key is bound to the element set the graph was derived from.
 */
export function buildPublicationSnapshot(
  orbitCsv: string | null,
  orbitVersion: string,
  now: Date,
): GraphSnapshot {
  const base = buildSeedSnapshot();
  const generatedAt = now.toISOString();
  const hash = contentHash(
    JSON.stringify({
      orbitVersion,
      satellites: base.satellites.map((satellite) => satellite.id),
      relations: base.relations.map((relation) => relation.id),
    }),
  );
  const graphVersion = `g-${versionStamp(now)}-${hash.slice(0, 6)}`;
  const snapshot = rebrand(base, graphVersion, generatedAt);
  return {
    ...snapshot,
    orbitVersion,
    orbitCsv: orbitCsv ?? base.orbitCsv,
    sources: snapshot.sources,
  };
}

/** Publishes one snapshot and records it in the history list. */
export async function publishSnapshot(
  env: SchedulerBindings,
  snapshot: GraphSnapshot,
  modes: Manifest['modes'],
): Promise<GraphRefreshResult> {
  const store = readModelStore(env);
  const bytes = JSON.stringify(snapshot);

  let staged = false;
  const b2 = blobStore(env);
  if (b2) {
    await b2.put(
      `snapshots/${snapshot.graphVersion}.json`,
      bytes,
      'application/json',
    );
    if (snapshot.orbitCsv) {
      await b2.put(
        `staging/${snapshot.graphVersion}/orbits.csv`,
        snapshot.orbitCsv,
        'text/csv',
      );
    }
    staged = true;
  }

  const entries = readModelEntries(snapshot, modes);
  await store.putMany(entries);

  const neo4j = neo4jClient(env);
  if (neo4j) {
    await publishToNeo4j(neo4j, snapshot);
  }

  if (env.SATGRAPH_DB) {
    await publishToD1(env.SATGRAPH_DB, buildReadModels(snapshot));
  }

  await store.put(HASH_KEY, contentHash(
    JSON.stringify({
      orbitVersion: snapshot.orbitVersion,
      relations: snapshot.relations.map((relation) => relation.id),
    }),
  ));

  const history = await readHistory(store);
  const next: PublishedSnapshotSummary = {
    graphVersion: snapshot.graphVersion,
    orbitVersion: snapshot.orbitVersion,
    generatedAt: snapshot.generatedAt,
    satelliteCount: snapshot.satellites.length,
    relationCount: snapshot.relations.length,
  };
  const merged = [next, ...history.filter((item) => item.graphVersion !== next.graphVersion)]
    .slice(0, 8);
  await store.put(HISTORY_KEY, JSON.stringify(merged));

  return {
    changed: true,
    graphVersion: snapshot.graphVersion,
    orbitVersion: snapshot.orbitVersion,
    satelliteCount: next.satelliteCount,
    relationCount: next.relationCount,
    staged,
  };
}

async function readHistory(
  store: ReturnType<typeof readModelStore>,
): Promise<PublishedSnapshotSummary[]> {
  const raw = await store.getText(HISTORY_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as PublishedSnapshotSummary[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** True when the orbit set and relation set are unchanged since the last run. */
export async function isUnchanged(
  env: SchedulerBindings,
  snapshot: GraphSnapshot,
): Promise<boolean> {
  const store = readModelStore(env);
  const previous = await store.getText(HASH_KEY);
  if (!previous) {
    return false;
  }
  const current = contentHash(
    JSON.stringify({
      orbitVersion: snapshot.orbitVersion,
      relations: snapshot.relations.map((relation) => relation.id),
    }),
  );
  return previous === current;
}
