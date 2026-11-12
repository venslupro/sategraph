import { describe, expect, it } from 'vitest';
import type { LifecycleStatus } from '@sategraph/contracts';
import {
  Constellation,
  clusterPlanes,
  type ConstellationMember,
} from '../src/domain/constellation';
import {
  GeoCoLocationRule,
  GridIslTopologyRule,
  RelayCatalogRule,
  evaluateRules,
  type RuleContext,
  type RuleSatellite,
} from '../src/domain/rules';
import type { ConstellationView } from '../src/domain/rule-types';

function member(
  index: number,
  overrides: Partial<ConstellationMember> = {},
): ConstellationMember {
  return {
    satelliteId: `sat-${index}`,
    name: `SAT ${index}`,
    status: 'ACTIVE' as LifecycleStatus,
    inclinationDeg: 55,
    raanDeg: 0,
    meanAnomalyDeg: 0,
    planeIndex: null,
    slotIndex: null,
    ...overrides,
  };
}

describe('clusterPlanes', () => {
  it('groups members by inclination and RAAN within tolerance', () => {
    const planes = clusterPlanes([
      member(1, { raanDeg: 20 }),
      member(2, { raanDeg: 21.5 }),
      member(3, { raanDeg: 80 }),
      member(4, { raanDeg: 80, inclinationDeg: 57 }),
    ]);
    expect(planes).toHaveLength(3);
    expect(planes[0].members.map((item) => item.satelliteId)).toEqual([
      'sat-1',
      'sat-2',
    ]);
  });

  it('handles RAAN wrap-around across 0/360', () => {
    const planes = clusterPlanes([
      member(1, { raanDeg: 359.5 }),
      member(2, { raanDeg: 0.8 }),
    ]);
    expect(planes).toHaveLength(1);
  });
});

describe('Constellation.assignSlots', () => {
  it('orders slots by mean anomaly and counts statuses', () => {
    const constellation = new Constellation({
      id: 'gps',
      name: 'GPS',
      designPattern: 'Walker',
      healthNote: null,
      members: [
        member(1, { meanAnomalyDeg: 180 }),
        member(2, { meanAnomalyDeg: 10 }),
        member(3, { meanAnomalyDeg: 90, status: 'INACTIVE' }),
      ],
    });
    const view = constellation.assignSlots();
    expect(view.planes).toHaveLength(1);
    expect(view.planes[0].slots.map((slot) => slot.satelliteId)).toEqual([
      'sat-2',
      'sat-3',
      'sat-1',
    ]);
    expect(view.activeCount).toBe(2);
    expect(view.inactiveCount).toBe(1);
    expect(view.slotCount).toBe(3);
  });
});

describe('Constellation.relationViews', () => {
  it('projects MEMBER_OF / IN_PLANE / IN_SLOT per member', () => {
    const constellation = new Constellation({
      id: 'gps',
      name: 'GPS',
      designPattern: null,
      healthNote: null,
      members: [member(1), member(2, { meanAnomalyDeg: 90 })],
    });
    const relations = constellation.relationViews('v1');
    expect(relations).toHaveLength(6);
    expect(relations.filter((item) => item.type === 'MEMBER_OF')).toHaveLength(2);
    expect(relations.filter((item) => item.type === 'IN_PLANE')).toHaveLength(2);
    expect(relations.filter((item) => item.type === 'IN_SLOT')).toHaveLength(2);
    expect(relations.every((item) => item.updatedVersion === 'v1')).toBe(true);
  });
});

function planeView(
  planeCount: number,
  slotsPerPlane: number,
  constellationId = 'gps',
): ConstellationView {
  return {
    id: constellationId,
    name: constellationId.toUpperCase(),
    designPattern: null,
    planes: Array.from({ length: planeCount }, (_, planeIndex) => ({
      index: planeIndex,
      inclinationDeg: 55,
      raanDeg: (360 / planeCount) * planeIndex,
      slots: Array.from({ length: slotsPerPlane }, (_, slotIndex) => ({
        index: slotIndex,
        satelliteId: `${constellationId}-${planeIndex}-${slotIndex}`,
        name: `P${planeIndex}S${slotIndex}`,
        status: 'ACTIVE' as LifecycleStatus,
      })),
    })),
    slotCount: planeCount * slotsPerPlane,
    activeCount: planeCount * slotsPerPlane,
    inactiveCount: 0,
    healthNote: null,
  };
}

describe('GridIslTopologyRule', () => {
  it('links ring neighbours and adjacent-plane slot partners', () => {
    const context: RuleContext = {
      satellites: [],
      constellations: [planeView(6, 4)],
      relays: [],
      graphVersion: 'v1',
    };
    const assertions = new GridIslTopologyRule().evaluate(context);
    // 6 planes x 4 same-plane ring links + 5 plane gaps x 4 slot partners.
    expect(assertions).toHaveLength(24 + 20);
    expect(assertions.every((item) => item.confidence === 'MODELED')).toBe(true);
    expect(assertions.every((item) => item.type === 'ISL_MODELED')).toBe(true);
  });

  it('skips planes with fewer than four members', () => {
    const context: RuleContext = {
      satellites: [],
      constellations: [planeView(2, 3)],
      relays: [],
      graphVersion: 'v1',
    };
    expect(new GridIslTopologyRule().evaluate(context)).toHaveLength(0);
  });

  it('skips constellations without a registered architecture', () => {
    const context: RuleContext = {
      satellites: [],
      constellations: [planeView(3, 8, 'galileo')],
      relays: [],
      graphVersion: 'v1',
    };
    expect(new GridIslTopologyRule().evaluate(context)).toHaveLength(0);
  });
});

function geoSatellite(id: string, longitudeDeg: number): RuleSatellite {
  return {
    id,
    name: id,
    constellationId: null,
    layerId: 'relay',
    orbitSummary: {
      semiMajorAxisKm: 42164,
      perigeeKm: 35780,
      apogeeKm: 35790,
      periodMin: 1436.1,
      inclinationDeg: 0.05,
      eccentricity: 0.0001,
      orbitClass: 'GEO',
      geoLongitudeDeg: longitudeDeg,
    },
    meanAnomalyDeg: 0,
    raanDeg: 0,
    inclinationDeg: 0.05,
    planeIndex: null,
    slotIndex: null,
    slotCount: null,
  };
}

describe('GeoCoLocationRule', () => {
  it('pairs GEO satellites within 0.1 degrees', () => {
    const context: RuleContext = {
      satellites: [geoSatellite('a', 77.0), geoSatellite('b', 77.05), geoSatellite('c', 80)],
      constellations: [],
      relays: [],
      graphVersion: 'v1',
    };
    const assertions = new GeoCoLocationRule().evaluate(context);
    expect(assertions).toHaveLength(1);
    expect(assertions[0].fromId).toBe('a');
    expect(assertions[0].toId).toBe('b');
    expect(assertions[0].confidence).toBe('DERIVED');
  });

  it('ignores non-GEO satellites', () => {
    const leo: RuleSatellite = {
      ...geoSatellite('leo', 77.0),
      orbitSummary: null,
    };
    const context: RuleContext = {
      satellites: [leo, geoSatellite('geo', 77.02)],
      constellations: [],
      relays: [],
      graphVersion: 'v1',
    };
    expect(new GeoCoLocationRule().evaluate(context)).toHaveLength(0);
  });
});

describe('RelayCatalogRule', () => {
  it('emits declared relay relations with evidence', () => {
    const context: RuleContext = {
      satellites: [],
      constellations: [],
      relays: [
        {
          relayId: '42915',
          relayName: 'TDRS-13',
          userId: '25544',
          userName: 'ISS',
          system: 'TDRS',
          evidence: [{ label: 'NASA TDRS page', source: 'curation' }],
        },
      ],
      graphVersion: 'v1',
    };
    const assertions = new RelayCatalogRule().evaluate(context);
    expect(assertions).toHaveLength(1);
    expect(assertions[0].type).toBe('RELAY_SERVES');
    expect(assertions[0].confidence).toBe('DECLARED');
    expect(assertions[0].method).toBe('CuratedRelay@1');
  });
});

describe('evaluateRules', () => {
  it('de-duplicates assertions by relation key', () => {
    const context: RuleContext = {
      satellites: [],
      constellations: [planeView(6, 4)],
      relays: [],
      graphVersion: 'v1',
    };
    const assertions = evaluateRules(context);
    const keys = assertions.map(
      (item) => `${item.type}:${item.fromId}:${item.toId}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
