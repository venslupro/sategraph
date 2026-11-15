/**
 * Weekly backup. Copies the currently published snapshot archive inside B2
 * (`snapshots/` -> `backups/`) and refreshes the small history list the UI
 * uses for replay. Read models, D1 and the version pointers are never
 * touched; B2 lifecycle rules own retention.
 */
import type { Manifest } from '@sategraph/contracts';
import type { SchedulerBindings } from '../services';
import { blobStore, readModelStore } from '../services';

export interface BackupResult {
  graphVersion: string;
  orbitVersion: string;
  backupKey: string | null;
  bytes: number;
}

const HISTORY_KEY = 'history:snapshots';

interface SnapshotSummary {
  graphVersion: string;
  orbitVersion: string;
  generatedAt: string;
  satelliteCount: number;
  relationCount: number;
  backupKey: string | null;
}

export async function runBackup(
  env: SchedulerBindings,
  now = new Date(),
): Promise<BackupResult> {
  const store = readModelStore(env);
  const graphVersion = (await store.getText('ptr:graph')) ?? 'unpublished';
  const orbitVersion = (await store.getText('ptr:orbit')) ?? 'unpublished';

  let backupKey: string | null = null;
  let bytes = 0;
  const b2 = blobStore(env);
  if (b2 && graphVersion !== 'unpublished') {
    const staged = await b2.get(`snapshots/${graphVersion}.json`);
    if (staged !== null) {
      backupKey = `backups/${now.toISOString().slice(0, 10)}-${graphVersion}.json`;
      await b2.put(backupKey, staged, 'application/json');
      bytes = staged.length;
    }
  }

  const manifest =
    graphVersion === 'unpublished'
      ? null
      : await store.get<Manifest>(`rm:${graphVersion}:manifest`);
  const summary: SnapshotSummary = {
    graphVersion,
    orbitVersion,
    generatedAt: manifest?.generatedAt ?? now.toISOString(),
    satelliteCount: manifest?.satelliteCount ?? 0,
    relationCount: manifest?.relationCount ?? 0,
    backupKey,
  };
  const history = await readHistory(store);
  const merged = [
    summary,
    ...history.filter((item) => item.graphVersion !== summary.graphVersion),
  ].slice(0, 8);
  await store.put(HISTORY_KEY, JSON.stringify(merged));

  return { graphVersion, orbitVersion, backupKey, bytes };
}

async function readHistory(
  store: ReturnType<typeof readModelStore>,
): Promise<SnapshotSummary[]> {
  const raw = await store.getText(HISTORY_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as SnapshotSummary[]) : [];
  } catch {
    return [];
  }
}
