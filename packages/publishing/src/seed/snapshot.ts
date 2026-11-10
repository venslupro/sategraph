/**
 * Builds the in-memory graph snapshot from the seed dataset. The snapshot is
 * the degraded-mode equivalent of a Neo4j read: every read model, graph query
 * and agent answer in seed mode is derived from it.
 */
import type {
  Constellation as ConstellationView,
  DomainEventView,
  Layer,
  Link,
  Relation,
  SourceHealth,
} from '@satgraph/contracts';
import { relationKey, toIsoUtc } from '@satgraph/shared-kernel';
import { computeOrbitSummary, toSatrecJson } from '@satgraph/orbit';
import { Constellation as ConstellationAggregate } from '@satgraph/graph';
import type { ConstellationMember } from '@satgraph/graph';
import {
  evaluateRules,
  type CuratedRelay,
  type RuleContext,
  type RuleSatellite,
} from '@satgraph/graph';
import type { GraphSnapshot, SnapshotSatellite } from '../model';
import {
  buildSeedDataset,
  LAYERS,
  SEED_EPOCH,
  type SeedDataset,
  type SeedSatellite,
} from './dataset';
import { buildSeedOrbits } from './orbits';

export const SEED_ORBIT_VERSION = 'seed-orbits-2026-11-10T00Z';
export const SEED_GRAPH_VERSION = 'seed-graph-v1';

function satelliteProvenance(satellite: SeedSatellite): SnapshotSatellite['provenance'] {
  const retrievedAt = toIsoUtc(new Date(SEED_EPOCH.replace('Z', '').concat('Z')));
  const fields: [string, string][] = [
    ['name', satellite.name],
    ['cosparId', satellite.cosparId ?? ''],
    ['purpose', satellite.purpose],
    ['country', satellite.country],
  ];
  const provenance: SnapshotSatellite['provenance'] = [];
  for (const [field, value] of fields) {
    if (!value) {
      continue;
    }
    for (const source of satellite.sources) {
      provenance.push({
        field,
        value,
        source: source.source,
        license: source.license,
        url: source.url,
        retrievedAt,
        candidates: [{ value, source: source.source }],
      });
    }
  }
  return provenance;
}

function buildSnapshotSatellites(
  dataset: SeedDataset,
): { satellites: SnapshotSatellite[]; orbitCsv: string } {
  const { records, csv } = buildSeedOrbits(dataset.satellites);
  const recordById = new Map(records.map((record) => [record.noradId, record]));
  const organizationNames = new Map(
    dataset.organizations.map((organization) => [organization.id, organization.name]),
  );
  const busNames = new Map(dataset.buses.map((bus) => [bus.id, bus.name]));
  const satellites = dataset.satellites.map((satellite) => {
    const record = recordById.get(satellite.id);
    if (!record) {
      throw new Error(`Missing OMM record for seed satellite ${satellite.id}`);
    }
    const summary = computeOrbitSummary(record);
    const snapshot: SnapshotSatellite = {
      id: satellite.id,
      name: satellite.name,
      aliases: satellite.aliases,
      cosparId: satellite.cosparId,
      jcatId: satellite.jcatId,
      wikidataId: satellite.wikidataId,
      status: satellite.status,
      purpose: satellite.purpose,
      country: satellite.country,
      operatorId: satellite.operatorId,
      operatorName: satellite.operatorId
        ? organizationNames.get(satellite.operatorId) ?? null
        : null,
      manufacturerId: satellite.manufacturerId,
      manufacturerName: satellite.manufacturerId
        ? organizationNames.get(satellite.manufacturerId) ?? null
        : null,
      busId: satellite.busId,
      busName: satellite.busId ? busNames.get(satellite.busId) ?? null : null,
      launchId: satellite.launchId,
      constellationId: satellite.constellationId,
      layerId: satellite.layerId,
      system: satellite.system,
      orbit: {
        epoch: record.epoch,
        summary,
        meanAnomalyDeg: record.meanAnomalyDeg,
        raanDeg: record.raanDeg,
        inclinationDeg: record.inclinationDeg,
      },
      omm: toSatrecJson(record),
      planeIndex: null,
      slotIndex: null,
      slotCount: null,
      provenance: satelliteProvenance(satellite),
    };
    return snapshot;
  });
  return { satellites, orbitCsv: csv };
}

function buildConstellationViews(
  dataset: SeedDataset,
  satellites: SnapshotSatellite[],
): ConstellationView[] {
  const views: ConstellationView[] = [];
  for (const definition of dataset.constellations) {
    const members: ConstellationMember[] = satellites
      .filter((satellite) => satellite.constellationId === definition.id)
      .map((satellite) => ({
        satelliteId: satellite.id,
        name: satellite.name,
        status: satellite.status,
        inclinationDeg: satellite.orbit.inclinationDeg,
        raanDeg: satellite.orbit.raanDeg,
        meanAnomalyDeg: satellite.orbit.meanAnomalyDeg,
        altitudeKm:
          (satellite.orbit.summary.perigeeKm +
            satellite.orbit.summary.apogeeKm) /
          2,
        planeIndex: null,
        slotIndex: null,
      }));
    const aggregate = new ConstellationAggregate({
      id: definition.id,
      name: definition.name,
      designPattern: definition.designPattern,
      members,
      healthNote: definition.healthNote,
    });
    const view = aggregate.assignSlots();
    for (const plane of view.planes) {
      for (const slot of plane.slots) {
        const satellite = satellites.find((item) => item.id === slot.satelliteId);
        if (satellite) {
          satellite.planeIndex = plane.index;
          satellite.slotIndex = slot.index;
          satellite.slotCount = plane.slots.length;
        }
      }
    }
    views.push(view);
  }
  return views;
}

function endpointName(dataset: SeedDataset, id: string): string {
  return (
    dataset.organizations.find((organization) => organization.id === id)?.name ??
    dataset.launches.find((launch) => launch.id === id)?.name ??
    dataset.buses.find((bus) => bus.id === id)?.name ??
    id
  );
}

function endpointKind(id: string): Relation['from']['kind'] {
  if (id.startsWith('org-')) {
    return 'Organization';
  }
  if (id.startsWith('launch-')) {
    return 'Launch';
  }
  if (id.startsWith('bus-')) {
    return 'Bus';
  }
  return 'Satellite';
}

/** Declared organization / bus / launch relations from the seed columns. */
function declaredStructuralRelations(
  dataset: SeedDataset,
  satellites: readonly SnapshotSatellite[],
  graphVersion: string,
): Relation[] {
  const relations: Relation[] = [];
  const push = (
    type: Relation['type'],
    satellite: SnapshotSatellite,
    targetId: string,
    method: string,
  ): void => {
    relations.push({
      id: relationKey(type, satellite.id, targetId),
      type,
      from: { id: satellite.id, name: satellite.name, kind: 'Satellite' },
      to: {
        id: targetId,
        name: endpointName(dataset, targetId),
        kind: endpointKind(targetId),
      },
      confidence: 'DECLARED',
      method,
      evidence: [
        {
          label: 'Recorded in the operator and manufacturer reference lists',
          source: 'curation',
        },
      ],
      validFrom: null,
      validTo: null,
      updatedVersion: graphVersion,
    });
  };
  for (const satellite of satellites) {
    if (satellite.operatorId) {
      push('OPERATED_BY', satellite, satellite.operatorId, 'CuratedOrganization@1');
    }
    if (satellite.manufacturerId) {
      push('BUILT_BY', satellite, satellite.manufacturerId, 'CuratedOrganization@1');
    }
    if (satellite.busId) {
      push('USES_BUS', satellite, satellite.busId, 'CuratedBus@1');
    }
    if (satellite.launchId) {
      push('LAUNCHED_IN', satellite, satellite.launchId, 'GcatLaunch@1');
    }
  }
  return relations;
}

function membershipRelations(
  dataset: SeedDataset,
  satellites: readonly SnapshotSatellite[],
  graphVersion: string,
): Relation[] {
  const relations: Relation[] = [];
  for (const definition of dataset.constellations) {
    const members: ConstellationMember[] = satellites
      .filter((satellite) => satellite.constellationId === definition.id)
      .map((satellite) => ({
        satelliteId: satellite.id,
        name: satellite.name,
        status: satellite.status,
        inclinationDeg: satellite.orbit.inclinationDeg,
        raanDeg: satellite.orbit.raanDeg,
        meanAnomalyDeg: satellite.orbit.meanAnomalyDeg,
        planeIndex: satellite.planeIndex,
        slotIndex: satellite.slotIndex,
      }));
    const aggregate = new ConstellationAggregate({
      id: definition.id,
      name: definition.name,
      designPattern: definition.designPattern,
      members,
      healthNote: definition.healthNote,
    });
    relations.push(...aggregate.relationViews(graphVersion));
  }
  return relations;
}

function curatedRelations(
  dataset: SeedDataset,
  satellites: readonly SnapshotSatellite[],
  graphVersion: string,
): Relation[] {
  const nameOf = (id: string): string =>
    satellites.find((satellite) => satellite.id === id)?.name ??
    endpointName(dataset, id);
  return dataset.curatedRelations.map((relation) => ({
    id: relationKey(relation.type, relation.fromId, relation.toId),
    type: relation.type,
    from: {
      id: relation.fromId,
      name: nameOf(relation.fromId),
      kind: endpointKind(relation.fromId),
    },
    to: {
      id: relation.toId,
      name: nameOf(relation.toId),
      kind: endpointKind(relation.toId),
    },
    confidence: relation.confidence,
    method: relation.method,
    evidence: relation.evidence,
    validFrom: null,
    validTo: null,
    updatedVersion: graphVersion,
  }));
}

function buildRelations(
  dataset: SeedDataset,
  satellites: readonly SnapshotSatellite[],
  constellations: readonly ConstellationView[],
  graphVersion: string,
): Relation[] {
  const nameOf = (id: string): string =>
    satellites.find((satellite) => satellite.id === id)?.name ?? id;
  const relays: CuratedRelay[] = dataset.relays.map((relay) => ({
    relayId: relay.relayId,
    relayName: nameOf(relay.relayId),
    userId: relay.userId,
    userName: nameOf(relay.userId),
    system: relay.system,
    evidence: relay.evidence,
  }));
  const ruleSatellites: RuleSatellite[] = satellites.map((satellite) => ({
    id: satellite.id,
    name: satellite.name,
    constellationId: satellite.constellationId,
    layerId: satellite.layerId,
    orbitSummary: satellite.orbit.summary,
    meanAnomalyDeg: satellite.orbit.meanAnomalyDeg,
    raanDeg: satellite.orbit.raanDeg,
    inclinationDeg: satellite.orbit.inclinationDeg,
    planeIndex: satellite.planeIndex,
    slotIndex: satellite.slotIndex,
    slotCount: satellite.slotCount,
  }));
  const context: RuleContext = {
    satellites: ruleSatellites,
    constellations: [...constellations],
    relays,
    graphVersion,
  };
  const ruled = evaluateRules(context).map((assertion) => ({
    id: relationKey(assertion.type, assertion.fromId, assertion.toId),
    type: assertion.type,
    from: { id: assertion.fromId, name: assertion.fromName, kind: 'Satellite' as const },
    to: { id: assertion.toId, name: assertion.toName, kind: 'Satellite' as const },
    confidence: assertion.confidence,
    method: assertion.method,
    evidence: assertion.evidence,
    validFrom: null,
    validTo: null,
    updatedVersion: graphVersion,
  }));
  const all = [
    ...membershipRelations(dataset, satellites, graphVersion),
    ...declaredStructuralRelations(dataset, satellites, graphVersion),
    ...curatedRelations(dataset, satellites, graphVersion),
    ...ruled,
  ];
  const seen = new Set<string>();
  return all.filter((relation) => {
    if (seen.has(relation.id)) {
      return false;
    }
    seen.add(relation.id);
    return true;
  });
}

function buildLayers(
  dataset: SeedDataset,
  satellites: readonly SnapshotSatellite[],
  links: readonly Link[],
): Layer[] {
  return LAYERS.map((layer) => {
    const satelliteIds = satellites
      .filter((satellite) => satellite.layerId === layer.id)
      .map((satellite) => satellite.id);
    const isConstellation = dataset.constellations.some(
      (constellation) => constellation.id === layer.id,
    );
    const defaultLinks = links
      .filter((link) => link.layerId === layer.id)
      .filter(
        (link) =>
          link.type === 'ISL_MODELED' ||
          link.type === 'RELAY_SERVES' ||
          link.type === 'DOCKED_TO',
      )
      .map((link) => link.id);
    return {
      id: layer.id,
      name: layer.name,
      description: isConstellation
        ? dataset.constellations.find((item) => item.id === layer.id)?.description ??
          layer.name
        : layer.name,
      color: layer.color,
      kind: isConstellation ? ('constellation' as const) : ('group' as const),
      count: satelliteIds.length,
      satelliteIds,
      defaultLinks,
      colorBy: 'layer' as const,
    };
  });
}

function buildLinks(
  relations: readonly Relation[],
  satellites: readonly SnapshotSatellite[],
): Link[] {
  const layerOf = new Map(
    satellites.map((satellite) => [satellite.id, satellite.layerId]),
  );
  return relations
    .filter(
      (relation) =>
        relation.from.kind === 'Satellite' && relation.to.kind === 'Satellite',
    )
    .map((relation) => ({
      id: relation.id,
      type: relation.type,
      fromId: relation.from.id,
      toId: relation.to.id,
      confidence: relation.confidence,
      layerId:
        relation.type === 'RELAY_SERVES'
          ? 'relay'
          : layerOf.get(relation.from.id) ?? layerOf.get(relation.to.id) ?? 'relay',
      method: relation.method,
    }));
}

function buildEvents(generatedAt: string, graphVersion: string): DomainEventView[] {
  const base = new Date(generatedAt).getTime();
  const at = (hoursAgo: number): string =>
    toIsoUtc(new Date(base - hoursAgo * 3600 * 1000));
  return [
    {
      id: 'evt-seed-cataloged-crew-dragon',
      type: 'SATELLITE_CATALOGED',
      occurredAt: at(4),
      aggregateId: '900501',
      title: 'Crew Dragon Endeavour cataloged in the public record',
      detail: 'New public catalog entry merged from CelesTrak GP and curated records.',
      graphVersion,
    },
    {
      id: 'evt-seed-maneuver-gps',
      type: 'SATELLITE_MANEUVERED',
      occurredAt: at(11),
      aggregateId: '900101',
      title: 'GPS III SV01 semi-major axis shift detected',
      detail: 'Semi-major axis changed beyond the maneuver threshold between refreshes.',
      graphVersion,
    },
    {
      id: 'evt-seed-relation-bds',
      type: 'RELATION_CREATED',
      occurredAt: at(21),
      aggregateId: 'bds',
      title: 'BeiDou-3 modeled inter-satellite links recomputed',
      detail: 'GridIslTopologyRule@1 regenerated same-plane adjacency for BeiDou-3.',
      graphVersion,
    },
    {
      id: 'evt-seed-decayed-noaa',
      type: 'SATELLITE_DECAYED',
      occurredAt: at(30),
      aggregateId: '43013',
      title: 'NOAA-20 flagged for decay watch (demonstration event)',
      detail: 'Demonstration of the decay event channel; the satellite remains active.',
      graphVersion,
    },
    {
      id: 'evt-seed-membership-galileo',
      type: 'CONSTELLATION_MEMBERSHIP_CHANGED',
      occurredAt: at(43),
      aggregateId: 'galileo',
      title: 'Galileo plane assignment refreshed',
      detail: 'PlaneClusteringRule@1 reassigned plane indices from the latest elements.',
      graphVersion,
    },
  ];
}

function buildSources(dataset: SeedDataset): SourceHealth[] {
  return dataset.sources.map((source) => ({
    source: source.id,
    status: source.status,
    lastSuccessAt: source.status === 'OK' ? source.dataTime : null,
    dataTime: source.dataTime,
    message: source.message,
    license: source.license,
  }));
}

/** Builds the complete demonstration snapshot. */
export function buildSeedSnapshot(): GraphSnapshot {
  const dataset = buildSeedDataset();
  const { satellites, orbitCsv } = buildSnapshotSatellites(dataset);
  const constellations = buildConstellationViews(dataset, satellites);
  const relations = buildRelations(dataset, satellites, constellations, SEED_GRAPH_VERSION);
  const links = buildLinks(relations, satellites);
  const generatedAt = toIsoUtc(new Date(SEED_EPOCH.replace('Z', '').concat('Z')));
  return {
    orbitVersion: SEED_ORBIT_VERSION,
    graphVersion: SEED_GRAPH_VERSION,
    generatedAt,
    satellites,
    relations,
    constellations,
    organizations: dataset.organizations.map((organization) => ({
      id: organization.id,
      name: organization.name,
      country: organization.country,
    })),
    launches: dataset.launches.map((launch) => ({
      id: launch.id,
      name: launch.name,
      date: launch.date,
      vehicle: launch.vehicle,
      site: launch.site,
    })),
    buses: dataset.buses.map((bus) => ({
      id: bus.id,
      name: bus.name,
      manufacturerId: bus.manufacturerId,
    })),
    layers: buildLayers(dataset, satellites, links),
    links,
    events: buildEvents(generatedAt, SEED_GRAPH_VERSION),
    sources: buildSources(dataset),
    orbitCsv,
  };
}
