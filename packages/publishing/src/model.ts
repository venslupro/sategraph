/**
 * In-memory graph snapshot: the neutral shape read models are projected from.
 * Both the seed adapter and the live Neo4j read path must produce this shape.
 */
import type {
  CatalogEntry,
  Constellation,
  DomainEventView,
  Layer,
  Link,
  OrbitSummary,
  Relation,
  SourceHealth,
} from '@sategraph/contracts';

export interface SnapshotOrbit {
  epoch: string;
  summary: OrbitSummary;
  meanAnomalyDeg: number;
  raanDeg: number;
  inclinationDeg: number;
}

export interface SnapshotSatellite {
  id: string;
  name: string;
  aliases: string[];
  cosparId: string | null;
  jcatId: string | null;
  wikidataId: string | null;
  status: 'CATALOGED' | 'ACTIVE' | 'INACTIVE' | 'DECAYED';
  purpose: string;
  country: string | null;
  operatorId: string | null;
  operatorName: string | null;
  manufacturerId: string | null;
  manufacturerName: string | null;
  busId: string | null;
  busName: string | null;
  launchId: string | null;
  constellationId: string | null;
  layerId: string;
  system: string | null;
  orbit: SnapshotOrbit;
  /** Raw OMM fields, keyed like the CCSDS JSON schema. */
  omm: Record<string, string | number>;
  planeIndex: number | null;
  slotIndex: number | null;
  slotCount: number | null;
  provenance: {
    field: string;
    value: string;
    source: string;
    license: string;
    url?: string;
    retrievedAt: string;
    candidates: { value: string; source: string }[];
  }[];
}

export interface SnapshotOrganization {
  id: string;
  name: string;
  country: string;
}

export interface SnapshotLaunch {
  id: string;
  name: string;
  date: string;
  vehicle: string;
  site: string;
}

export interface SnapshotBus {
  id: string;
  name: string;
  manufacturerId: string;
}

export interface GraphSnapshot {
  orbitVersion: string;
  graphVersion: string;
  generatedAt: string;
  satellites: SnapshotSatellite[];
  relations: Relation[];
  constellations: Constellation[];
  organizations: SnapshotOrganization[];
  launches: SnapshotLaunch[];
  buses: SnapshotBus[];
  layers: Layer[];
  links: Link[];
  events: DomainEventView[];
  sources: SourceHealth[];
  orbitCsv: string;
}

export interface ReadModelBundle {
  orbitVersion: string;
  graphVersion: string;
  generatedAt: string;
  catalog: CatalogEntry[];
  layers: Layer[];
  layerLinks: Map<string, Link[]>;
  constellations: Constellation[];
  satelliteDetails: Map<string, {
    satellite: CatalogEntry;
    orbit: { epoch: string; summary: OrbitSummary; omm: Record<string, string | number> };
    relations: Relation[];
    provenance: SnapshotSatellite['provenance'];
  }>;
  relations: Relation[];
  links: Link[];
  events: DomainEventView[];
  sources: SourceHealth[];
  orbitCsv: string;
}
