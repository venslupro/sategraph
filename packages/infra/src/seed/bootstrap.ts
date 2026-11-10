/**
 * Seed runtime wiring: publishes read models into memory and exposes the same
 * ports the Cloudflare adapters implement. Used by local development, tests and
 * the deployed fallback when KV/D1 are empty.
 */
import type { CatalogReader } from '@satgraph/catalog';
import type { GraphReadPort } from '@satgraph/graph';
import type { GraphSnapshot } from '@satgraph/publishing';
import {
  buildReadModels,
  getSeedSnapshot,
  readModelEntries,
} from '@satgraph/publishing';
import type { Manifest } from '@satgraph/contracts';
import { MemoryReadModelStore } from '../kv/read-model-store';
import type { EventReader, ShareStore } from '../ports';
import { SnapshotCatalogReader } from './catalog-reader';
import { SnapshotEventReader } from './event-reader';
import { SnapshotGraphRepository } from './graph-repository';
import { MemoryShareStore } from './share-store';

export interface SeedRuntime {
  snapshot: GraphSnapshot;
  readModels: MemoryReadModelStore;
  catalog: CatalogReader;
  graph: GraphReadPort;
  events: EventReader;
  shares: ShareStore;
}

export async function createSeedRuntime(
  modes: Manifest['modes'] = { graph: 'seed', agent: 'fake' },
): Promise<SeedRuntime> {
  const snapshot = getSeedSnapshot();
  const readModels = new MemoryReadModelStore();
  await readModels.putMany(readModelEntries(snapshot, modes));
  return {
    snapshot,
    readModels,
    catalog: new SnapshotCatalogReader(buildReadModels(snapshot).catalog),
    graph: new SnapshotGraphRepository(snapshot),
    events: new SnapshotEventReader(snapshot),
    shares: new MemoryShareStore(),
  };
}
