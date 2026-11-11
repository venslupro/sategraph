/** Ports used by the API application layer. */
import type {
  CatalogEntry,
  DomainEventView,
} from '@sategraph/contracts';

export interface EventReader {
  list(sinceHours: number, limit: number): Promise<DomainEventView[]>;
  recentForAggregate(
    aggregateId: string,
    limit: number,
  ): Promise<DomainEventView[]>;
}

export interface ShareStore {
  get(id: string): Promise<string | null>;
  put(id: string, value: string, ttlSeconds: number): Promise<void>;
}

export interface CatalogSearchReader {
  search(options: {
    text: string;
    layerId?: string;
    status?: string;
    purpose?: string;
    limit: number;
  }): Promise<CatalogEntry[]>;
}
