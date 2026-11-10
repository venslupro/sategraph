/**
 * Orbit refresh. One conditional GET against CelesTrak GP, then a versioned KV
 * write. The scheduler never parses or recomputes elements; the browser and
 * Neo4j consume the published CSV.
 */
import { CELESTRAK_GP, assessHealth, degradedRecord, healthyRecord } from '@satgraph/ingestion';
import { toIsoUtc } from '@satgraph/shared-kernel';
import type { SourceHealth } from '@satgraph/contracts';
import type { SchedulerBindings } from '../services';
import { httpClient, readModelStore } from '../services';

const ETAG_KEY = 'state:etag:celestrak-gp';
const LAST_GOOD_KEY = 'state:orbit:last-good';

export interface OrbitRefreshResult {
  changed: boolean;
  orbitVersion: string;
  bytes: number;
  health: SourceHealth;
}

function versionFrom(csv: string, now: Date): string {
  const epoch = csv.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)?.[0];
  const stamp = (epoch ?? toIsoUtc(now)).replace(/[-:]/g, '');
  return `o-${stamp}Z`;
}

/** Runs the refresh and returns the published version. */
export async function refreshOrbits(
  env: SchedulerBindings,
  now = new Date(),
): Promise<OrbitRefreshResult> {
  const store = readModelStore(env);
  const etag = await store.getText(ETAG_KEY);

  let response;
  try {
    response = await httpClient().get(CELESTRAK_GP.url, {
      accept: 'text/csv',
      etag: etag ?? undefined,
      timeoutMs: 25_000,
    });
  } catch (error) {
    const record = degradedRecord(
      CELESTRAK_GP.id,
      CELESTRAK_GP.license,
      error instanceof Error ? error.message : 'CelesTrak request failed',
    );
    await store.put('health:celestrak-gp', JSON.stringify(assessHealth(record, now)));
    throw error;
  }

  const health = assessHealth(
    response.status === 200 || response.status === 304
      ? healthyRecord(CELESTRAK_GP.id, CELESTRAK_GP.license, now)
      : degradedRecord(
          CELESTRAK_GP.id,
          CELESTRAK_GP.license,
          `CelesTrak responded with ${response.status}`,
        ),
    now,
  );

  if (response.status === 304) {
    const previous = (await store.getText('ptr:orbit')) ?? 'o-unknown';
    const lastBytes = Number((await store.getText(LAST_GOOD_KEY)) ?? 0);
    await store.put('health:celestrak-gp', JSON.stringify(health));
    return {
      changed: false,
      orbitVersion: previous,
      bytes: Number.isFinite(lastBytes) ? lastBytes : 0,
      health,
    };
  }

  if (response.status !== 200) {
    await store.put('health:celestrak-gp', JSON.stringify(health));
    throw new Error(`CelesTrak GP returned ${response.status}`);
  }

  const csv = new TextDecoder().decode(response.body);
  if (!csv.startsWith('OBJECT_NAME') && !csv.includes('NORAD_CAT_ID')) {
    const record = degradedRecord(
      CELESTRAK_GP.id,
      CELESTRAK_GP.license,
      'CelesTrak GP payload did not contain OMM columns',
    );
    await store.put('health:celestrak-gp', JSON.stringify(assessHealth(record, now)));
    throw new Error('Unexpected CelesTrak GP payload');
  }

  const orbitVersion = versionFrom(csv, now);
  await store.put(`orbits:${orbitVersion}`, csv, 30 * 24 * 3600);
  await store.put('ptr:orbit', orbitVersion);
  await store.put('health:celestrak-gp', JSON.stringify(health));
  await store.put(LAST_GOOD_KEY, String(csv.length));
  if (response.etag) {
    await store.put(ETAG_KEY, response.etag);
  }

  return {
    changed: true,
    orbitVersion,
    bytes: csv.length,
    health,
  };
}
