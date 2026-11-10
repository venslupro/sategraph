/**
 * Weekly backup. Writes an immutable snapshot to B2 and refreshes the small
 * history list the UI uses for replay. The previous backup is never deleted by
 * this workflow; B2 lifecycle rules own retention.
 */
import { buildReadModels, buildSeedSnapshot, readModelEntries } from '@satgraph/publishing';
import type { Manifest } from '@satgraph/contracts';
import type { SchedulerBindings } from '../services';
import { blobStore, publishToD1, readModelStore } from '../services';

export interface BackupResult {
  graphVersion: string;
  orbitVersion: string;
  backupKey: string | null;
  bytes: number;
}

const HISTORY_KEY = 'history:snapshots';

export async function runBackup(
  env: SchedulerBindings,
  now = new Date(),
): Promise<BackupResult> {
  const store = readModelStore(env);
  const snapshot = buildSeedSnapshot();
  const payload = JSON.stringify(snapshot);
  const backupKey = `backups/${now.toISOString().slice(0, 10)}-${snapshot.graphVersion}.json`;

  const b2 = blobStore(env);
  if (b2) {
    await b2.put(backupKey, payload, 'application/json');
  }

  const mode: Manifest['modes'] = {
    graph: env.GRAPH_BACKEND ?? 'd1',
    agent: env.AGENT_MODE ?? 'fake',
  };
  const entries = readModelEntries(snapshot, mode);
  await store.putMany(entries);
  if (env.SATGRAPH_DB) {
    await publishToD1(env.SATGRAPH_DB, buildReadModels(snapshot));
  }

  const raw = await store.getText(HISTORY_KEY);
  let history: unknown[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      history = Array.isArray(parsed) ? parsed : [];
    } catch {
      history = [];
    }
  }
  const summary = {
    graphVersion: snapshot.graphVersion,
    orbitVersion: snapshot.orbitVersion,
    generatedAt: snapshot.generatedAt,
    satelliteCount: snapshot.satellites.length,
    relationCount: snapshot.relations.length,
    backupKey: b2 ? backupKey : null,
  };
  await store.put(
    HISTORY_KEY,
    JSON.stringify([summary, ...history].slice(0, 8)),
  );

  return {
    graphVersion: snapshot.graphVersion,
    orbitVersion: snapshot.orbitVersion,
    backupKey: b2 ? backupKey : null,
    bytes: payload.length,
  };
}
