/**
 * Service port of the assistant context. The API composition root satisfies
 * this interface structurally; the assistant never depends on the container
 * that provides the implementations (dependency inversion).
 */
import type { CatalogReader } from '@sategraph/catalog';
import type {
  Constellation,
  DomainEventView,
  Layer,
  LayerLinks,
  SatelliteDetail,
} from '@sategraph/contracts';
import type { GraphReadPort } from '@sategraph/graph';
import type { LlmProvider, ShareStore } from '@sategraph/infra';

export interface AssistantServices {
  readonly llm: LlmProvider;
  readonly shares: ShareStore;
  readonly catalog: CatalogReader;
  readonly graph: GraphReadPort;
  readModel<T>(suffix: string): Promise<T | null>;
  getSatelliteDetail(id: string): Promise<SatelliteDetail | null>;
  layers(): Promise<Layer[]>;
  links(): Promise<LayerLinks[]>;
  constellations(): Promise<Constellation[]>;
  recentEvents(sinceHours: number, limit: number): Promise<DomainEventView[]>;
}
