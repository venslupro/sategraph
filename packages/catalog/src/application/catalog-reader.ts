/**
 * Catalog read port. The publishing context projects these entries into the
 * KV read model; adapters live in the infrastructure layer.
 */
import type { CatalogEntry, LifecycleStatus } from '@sategraph/contracts';

export interface CatalogFilter {
  text?: string;
  layerId?: string;
  status?: LifecycleStatus;
  purpose?: string;
  limit?: number;
}

export interface CatalogReader {
  list(): Promise<CatalogEntry[]>;
  get(satelliteId: string): Promise<CatalogEntry | null>;
  search(filter: CatalogFilter): Promise<CatalogEntry[]>;
}
