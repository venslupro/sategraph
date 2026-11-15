/**
 * Declarative relation rules. Each rule has a stable id and version, produces
 * relation assertions for the seed/D1 path, and can emit the equivalent Cypher
 * for the compute-pushdown path in Neo4j.
 */
import type {
  Confidence,
  OrbitSummary,
  Relation as RelationView,
  RelationType,
} from '@sategraph/contracts';
import type { ConstellationView } from './rule-types';

export interface RuleSatellite {
  id: string;
  name: string;
  constellationId: string | null;
  layerId: string | null;
  orbitSummary: OrbitSummary | null;
  meanAnomalyDeg: number | null;
  raanDeg: number | null;
  inclinationDeg: number | null;
  planeIndex: number | null;
  slotIndex: number | null;
  slotCount: number | null;
}

export interface CuratedRelay {
  relayId: string;
  relayName: string;
  userId: string;
  userName: string;
  system: string;
  evidence: { label: string; source: string; url?: string }[];
}

export interface RuleContext {
  satellites: RuleSatellite[];
  constellations: ConstellationView[];
  relays: CuratedRelay[];
  graphVersion: string;
}

export interface RelationAssertion {
  type: RelationType;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  confidence: Confidence;
  method: string;
  evidence: { label: string; source: string; url?: string }[];
}

export interface RelationRule {
  readonly id: string;
  readonly version: number;
  readonly method: string;
  evaluate(context: RuleContext): RelationAssertion[];
  toCypher(): string[];
}

export interface IslArchitecture {
  constellationId: string;
  /** Adjacent planes are not connected across the seam. */
  seam: boolean;
  adjacentPlaneLinks: boolean;
  evidence: { label: string; source: string; url?: string }[];
}

export const ISL_ARCHITECTURES: IslArchitecture[] = [
  {
    constellationId: 'gps',
    seam: false,
    adjacentPlaneLinks: true,
    evidence: [
      {
        label: 'GPS III crosslink capability described in public program material',
        source: 'curation',
        url: 'https://www.gps.gov/',
      },
    ],
  },
  {
    constellationId: 'bds',
    seam: false,
    adjacentPlaneLinks: true,
    evidence: [
      {
        label: 'BeiDou-3 inter-satellite link architecture',
        source: 'curation',
        url: 'https://www.beidou.gov.cn/',
      },
    ],
  },
  {
    constellationId: 'iridium',
    seam: true,
    adjacentPlaneLinks: true,
    evidence: [
      {
        label: 'Iridium NEXT crosslink architecture',
        source: 'curation',
        url: 'https://www.iridium.com/',
      },
    ],
  },
  {
    constellationId: 'starlink',
    seam: false,
    adjacentPlaneLinks: true,
    evidence: [
      {
        label: 'Starlink laser inter-satellite link public statements',
        source: 'curation',
        url: 'https://www.starlink.com/',
      },
    ],
  },
];

/**
 * Same-plane neighbours plus adjacent-plane neighbours with the same slot
 * index. Iridium's seam between the first and last plane is not connected.
 */
export class GridIslTopologyRule implements RelationRule {
  readonly id = 'GridIslTopologyRule';
  readonly version = 1;
  readonly method = `${this.id}@${this.version}`;

  constructor(private readonly architectures: IslArchitecture[] = ISL_ARCHITECTURES) {}

  evaluate(context: RuleContext): RelationAssertion[] {
    const assertions: RelationAssertion[] = [];
    for (const architecture of this.architectures) {
      const constellation = context.constellations.find(
        (item) => item.id === architecture.constellationId,
      );
      if (!constellation) {
        continue;
      }
      for (const [planeIndex, plane] of constellation.planes.entries()) {
        const size = plane.slots.length;
        if (size < 4) {
          continue;
        }
        for (const [slotIndex, slot] of plane.slots.entries()) {
          const samePlaneNext = plane.slots[(slotIndex + 1) % size];
          if (samePlaneNext) {
            assertions.push(
              this.assertion(
                slot.satelliteId,
                slot.name,
                samePlaneNext.satelliteId,
                samePlaneNext.name,
                architecture,
              ),
            );
          }
          // Only planes that actually carry an ISL mesh are adjacent; sparse
          // GEO/IGSO planes in mixed constellations are skipped.
          const nextPlane = architecture.adjacentPlaneLinks
            ? this.nextMeshPlane(constellation.planes, planeIndex)
            : undefined;
          const candidate = nextPlane?.slots[slotIndex];
          if (nextPlane && nextPlane.slots.length === size && candidate) {
            assertions.push(
              this.assertion(
                slot.satelliteId,
                slot.name,
                candidate.satelliteId,
                candidate.name,
                architecture,
              ),
            );
          }
        }
      }
    }
    return assertions;
  }

  /** Next plane, in RAAN order, that can carry a cross-plane slot link. */
  private nextMeshPlane(
    planes: ConstellationView['planes'],
    planeIndex: number,
  ): ConstellationView['planes'][number] | undefined {
    for (let index = planeIndex + 1; index < planes.length; index += 1) {
      if (planes[index].slots.length >= 4) {
        return planes[index];
      }
    }
    return undefined;
  }

  private assertion(
    fromId: string,
    fromName: string,
    toId: string,
    toName: string,
    architecture: IslArchitecture,
  ): RelationAssertion {
    return {
      type: 'ISL_MODELED',
      fromId,
      fromName,
      toId,
      toName,
      confidence: 'MODELED',
      method: this.method,
      evidence: architecture.evidence,
    };
  }

  /** Same-plane adjacency is persisted; cross-plane links are computed in the browser. */
  toCypher(): string[] {
    return [
      `MATCH (s:Satellite)
WHERE s.constellationId = $constellationId
  AND s.planeIndex IS NOT NULL AND s.slotIndex IS NOT NULL AND s.slotCount IS NOT NULL
MATCH (t:Satellite {
  constellationId: $constellationId,
  planeIndex: s.planeIndex,
  slotIndex: (s.slotIndex + 1) % s.slotCount
})
WHERE s.objectId < t.objectId
MERGE (s)-[r:ISL_MODELED]->(t)
SET r.confidence = 'MODELED',
    r.method = 'GridIslTopologyRule@1',
    r.updatedVersion = $graphVersion`,
    ];
  }
}

/** Marks geostationary satellites sharing a slot within 0.1 degrees. */
export class GeoCoLocationRule implements RelationRule {
  readonly id = 'GeoCoLocationRule';
  readonly version = 1;
  readonly method = `${this.id}@${this.version}`;

  evaluate(context: RuleContext): RelationAssertion[] {
    const geo = context.satellites.filter(
      (satellite) =>
        satellite.orbitSummary?.orbitClass === 'GEO' &&
        satellite.orbitSummary.geoLongitudeDeg !== null,
    );
    const assertions: RelationAssertion[] = [];
    for (let i = 0; i < geo.length; i += 1) {
      for (let j = i + 1; j < geo.length; j += 1) {
        const a = geo[i];
        const b = geo[j];
        const lonA = a.orbitSummary?.geoLongitudeDeg ?? null;
        const lonB = b.orbitSummary?.geoLongitudeDeg ?? null;
        if (lonA === null || lonB === null) {
          continue;
        }
        if (Math.abs(lonA - lonB) <= 0.1) {
          assertions.push({
            type: 'CO_LOCATED',
            fromId: a.id,
            fromName: a.name,
            toId: b.id,
            toName: b.name,
            confidence: 'DERIVED',
            method: this.method,
            evidence: [
              {
                label: 'GEO slot longitudes derived from public mean elements',
                source: 'celestrak',
              },
            ],
          });
        }
      }
    }
    return assertions;
  }

  toCypher(): string[] {
    return [
      `MATCH (a:Satellite), (b:Satellite)
WHERE a.objectId < b.objectId
  AND a.geoLongitudeDeg IS NOT NULL AND b.geoLongitudeDeg IS NOT NULL
  AND abs(a.geoLongitudeDeg - b.geoLongitudeDeg) <= 0.1
MERGE (a)-[r:CO_LOCATED]->(b)
SET r.confidence = 'DERIVED',
    r.method = 'GeoCoLocationRule@1',
    r.updatedVersion = $graphVersion`,
    ];
  }
}

/** Declared relay service relationships come from curated data only. */
export class RelayCatalogRule implements RelationRule {
  readonly id = 'RelayCatalogRule';
  readonly version = 1;
  readonly method = `${this.id}@${this.version}`;

  evaluate(context: RuleContext): RelationAssertion[] {
    return context.relays.map((relay) => ({
      type: 'RELAY_SERVES' as const,
      fromId: relay.relayId,
      fromName: relay.relayName,
      toId: relay.userId,
      toName: relay.userName,
      confidence: 'DECLARED' as const,
      method: 'CuratedRelay@1',
      evidence: relay.evidence,
    }));
  }

  toCypher(): string[] {
    return [
      `UNWIND $relays AS relay
MATCH (r:Satellite {objectId: relay.relayId})
MATCH (u:Satellite {objectId: relay.userId})
MERGE (r)-[rel:RELAY_SERVES {system: relay.system}]->(u)
SET rel.confidence = 'DECLARED',
    rel.method = 'CuratedRelay@1',
    rel.evidence = relay.evidence,
    rel.updatedVersion = $graphVersion`,
    ];
  }
}

export interface RuleSet {
  rules: RelationRule[];
}

export function defaultRuleSet(): RuleSet {
  return {
    rules: [
      new GridIslTopologyRule(),
      new GeoCoLocationRule(),
      new RelayCatalogRule(),
    ],
  };
}

/** Evaluates every rule and de-duplicates assertions by relation key. */
export function evaluateRules(context: RuleContext): RelationAssertion[] {
  const seen = new Set<string>();
  const assertions: RelationAssertion[] = [];
  for (const rule of defaultRuleSet().rules) {
    for (const assertion of rule.evaluate(context)) {
      const key = `${assertion.type}:${assertion.fromId}:${assertion.toId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      assertions.push(assertion);
    }
  }
  return assertions;
}

/** Converts assertions into the published relation shape. */
export function toRelationViews(
  assertions: readonly RelationAssertion[],
  graphVersion: string,
): RelationView[] {
  return assertions.map((assertion) => ({
    id: `${assertion.type}:${assertion.fromId}:${assertion.toId}`,
    type: assertion.type,
    from: {
      id: assertion.fromId,
      name: assertion.fromName,
      kind: 'Satellite',
    },
    to: {
      id: assertion.toId,
      name: assertion.toName,
      kind: 'Satellite',
    },
    confidence: assertion.confidence,
    method: assertion.method,
    evidence: assertion.evidence,
    validFrom: null,
    validTo: null,
    updatedVersion: graphVersion,
  }));
}
