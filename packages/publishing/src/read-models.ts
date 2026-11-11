/**
 * Read-model projection. Keys are versioned by graph version, except orbits,
 * which follow the two-hour orbit version. No user request ever triggers a
 * write; these builders run in workflows only.
 */
import type {
  CatalogEntry,
  Constellation,
  DomainEventView,
  Layer,
  Link,
  Manifest,
  Relation,
  SourceHealth,
} from '@sategraph/contracts';
import type {
  GraphSnapshot,
  ReadModelBundle,
  SnapshotSatellite,
} from './model';

export interface ReadModelKeys {
  catalog: string;
  layers: string;
  links: string;
  manifest: string;
  constellations: string;
  satelliteShard: (satelliteId: string) => string;
  orbits: string;
  graphPointer: string;
  orbitPointer: string;
  health: (source: string) => string;
  agentShare: (id: string) => string;
}

/** Builds the complete key set for a snapshot. */
export function readModelKeys(
  graphVersion: string,
  orbitVersion: string,
): ReadModelKeys {
  return {
    catalog: `rm:${graphVersion}:catalog`,
    layers: `rm:${graphVersion}:layers`,
    links: `rm:${graphVersion}:links`,
    manifest: `rm:${graphVersion}:manifest`,
    constellations: `rm:${graphVersion}:constellations`,
    satelliteShard: (satelliteId: string) =>
      `rm:${graphVersion}:sat:${satelliteShard(satelliteId)}`,
    orbits: `orbits:${orbitVersion}`,
    graphPointer: 'ptr:graph',
    orbitPointer: 'ptr:orbit',
    health: (source: string) => `health:${source}`,
    agentShare: (id: string) => `share:${id}`,
  };
}

/** Stable two-hex-digit shard derived from the identifier. */
export function satelliteShard(satelliteId: string): string {
  let hash = 0;
  for (let i = 0; i < satelliteId.length; i += 1) {
    hash = (hash * 31 + satelliteId.charCodeAt(i)) >>> 0;
  }
  return (hash % 64).toString(16).padStart(2, '0');
}

export function toCatalogEntry(
  satellite: SnapshotSatellite,
  constellationName: string | null,
): CatalogEntry {
  return {
    id: satellite.id,
    name: satellite.name,
    aliases: satellite.aliases,
    noradId: satellite.id,
    cosparId: satellite.cosparId,
    jcatId: satellite.jcatId,
    wikidataId: satellite.wikidataId,
    purpose: satellite.purpose,
    status: satellite.status,
    country: satellite.country,
    operator: satellite.operatorName,
    manufacturer: satellite.manufacturerName,
    constellationId: satellite.constellationId,
    constellationName,
    layerId: satellite.layerId,
    orbitClass: satellite.orbit.summary.orbitClass,
    launchDate: null,
  };
}

export function buildReadModels(snapshot: GraphSnapshot): ReadModelBundle {
  const constellationNames = new Map(
    snapshot.constellations.map((constellation) => [
      constellation.id,
      constellation.name,
    ]),
  );
  const catalog = snapshot.satellites.map((satellite) =>
    toCatalogEntry(
      satellite,
      satellite.constellationId
        ? constellationNames.get(satellite.constellationId) ?? null
        : null,
    ),
  );
  const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));

  const satelliteDetails = new Map<
    string,
    {
      satellite: CatalogEntry;
      orbit: {
        epoch: string;
        summary: SnapshotSatellite['orbit']['summary'];
        omm: Record<string, string | number>;
      };
      relations: Relation[];
      provenance: SnapshotSatellite['provenance'];
    }
  >();
  for (const satellite of snapshot.satellites) {
    const entry = catalogById.get(satellite.id);
    if (!entry) {
      continue;
    }
    satelliteDetails.set(satellite.id, {
      satellite: entry,
      orbit: {
        epoch: satellite.orbit.epoch,
        summary: satellite.orbit.summary,
        omm: satellite.omm,
      },
      relations: snapshot.relations.filter(
        (relation) =>
          relation.from.id === satellite.id || relation.to.id === satellite.id,
      ),
      provenance: satellite.provenance,
    });
  }

  const layerLinks = new Map<string, Link[]>();
  for (const layer of snapshot.layers) {
    layerLinks.set(
      layer.id,
      snapshot.links.filter((link) => link.layerId === layer.id),
    );
  }

  return {
    orbitVersion: snapshot.orbitVersion,
    graphVersion: snapshot.graphVersion,
    generatedAt: snapshot.generatedAt,
    catalog,
    layers: snapshot.layers,
    layerLinks,
    constellations: snapshot.constellations,
    satelliteDetails,
    relations: snapshot.relations,
    links: snapshot.links,
    events: snapshot.events,
    sources: snapshot.sources,
    orbitCsv: snapshot.orbitCsv,
  };
}

export function buildManifest(
  snapshot: GraphSnapshot,
  modes: Manifest['modes'],
  generatedAt = snapshot.generatedAt,
): Manifest {
  return {
    orbitVersion: snapshot.orbitVersion,
    graphVersion: snapshot.graphVersion,
    generatedAt,
    satelliteCount: snapshot.satellites.length,
    activeCount: snapshot.satellites.filter(
      (satellite) => satellite.status === 'ACTIVE',
    ).length,
    relationCount: snapshot.relations.length,
    modes,
    sources: snapshot.sources,
  };
}

/** Every KV entry that must be written for a snapshot. */
export function readModelEntries(
  snapshot: GraphSnapshot,
  modes: Manifest['modes'],
): { key: string; value: string; ttlSeconds?: number }[] {
  const keys = readModelKeys(snapshot.graphVersion, snapshot.orbitVersion);
  const readModels = buildReadModels(snapshot);
  const entries: { key: string; value: string; ttlSeconds?: number }[] = [
    {
      key: keys.catalog,
      value: JSON.stringify(readModels.catalog),
    },
    {
      key: keys.layers,
      value: JSON.stringify(readModels.layers),
    },
    {
      key: keys.links,
      value: JSON.stringify(readModels.links),
    },
    {
      key: keys.constellations,
      value: JSON.stringify(readModels.constellations),
    },
    {
      key: keys.manifest,
      value: JSON.stringify(buildManifest(snapshot, modes)),
    },
    {
      key: keys.orbits,
      value: readModels.orbitCsv,
    },
    {
      key: keys.graphPointer,
      value: snapshot.graphVersion,
    },
    {
      key: keys.orbitPointer,
      value: snapshot.orbitVersion,
    },
  ];

  const shards = new Map<string, Record<string, unknown>>();
  for (const [satelliteId, detail] of readModels.satelliteDetails) {
    const key = keys.satelliteShard(satelliteId);
    const bucket = shards.get(key) ?? {};
    bucket[satelliteId] = detail;
    shards.set(key, bucket);
  }
  for (const [key, bucket] of shards) {
    entries.push({ key, value: JSON.stringify(bucket) });
  }

  for (const constellation of readModels.constellations) {
    entries.push({
      key: `rm:${snapshot.graphVersion}:constellation:${constellation.id}`,
      value: JSON.stringify(constellation),
    });
  }

  for (const [layerId, links] of readModels.layerLinks) {
    entries.push({
      key: `rm:${snapshot.graphVersion}:links:${layerId}`,
      value: JSON.stringify({ layerId, links, relayAssignments: links.filter((link) => link.type === 'RELAY_SERVES') }),
    });
  }

  for (const source of readModels.sources) {
    entries.push({
      key: keys.health(source.source),
      value: JSON.stringify(source),
    });
  }

  return entries;
}

export interface LayerReadModel {
  layer: Layer;
  events: DomainEventView[];
  sources: SourceHealth[];
  constellations: Constellation[];
}
