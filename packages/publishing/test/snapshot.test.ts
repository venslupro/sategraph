import { describe, expect, it } from 'vitest';
import { parseOmmCsv } from '@sategraph/orbit';
import { buildSeedDataset, buildSeedSnapshot } from '../src/index';
import { buildReadModels, readModelEntries, satelliteShard } from '../src/read-models';

const CONSTELLATION_SATELLITES =
  6 * 4 + // gps
  (3 * 8 + 3 + 3) + // bds: MEO + GEO + IGSO
  3 * 8 + // galileo
  3 * 8 + // glonass
  6 * 11 + // iridium
  8 * 12 + // starlink
  4 * 8; // oneweb
const NAMED_SATELLITES = 14;
const EXPECTED_SATELLITES = CONSTELLATION_SATELLITES + NAMED_SATELLITES;
const EXPECTED_ISL =
  (6 * 4 + 5 * 4) + // gps: ring + adjacent planes
  (3 * 8 + 2 * 8) + // bds MEO
  (6 * 11 + 5 * 11) + // iridium
  (8 * 12 + 7 * 12); // starlink

describe('buildSeedSnapshot', () => {
  it('builds every satellite with orbit summary and OMM elements', () => {
    const snapshot = buildSeedSnapshot();
    expect(snapshot.satellites).toHaveLength(EXPECTED_SATELLITES);
    for (const satellite of snapshot.satellites) {
      expect(satellite.orbit.summary.orbitClass).toBeTruthy();
      expect(satellite.omm.NORAD_CAT_ID).toBe(satellite.id);
    }
  });

  it('is deterministic across builds', () => {
    const first = JSON.stringify(buildSeedSnapshot());
    const second = JSON.stringify(buildSeedSnapshot());
    expect(first).toBe(second);
  });

  it('round-trips the orbit CSV through the OMM parser', () => {
    const snapshot = buildSeedSnapshot();
    const records = parseOmmCsv(snapshot.orbitCsv);
    expect(records).toHaveLength(snapshot.satellites.length);
  });

  it('assigns plane and slot indices to constellation members', () => {
    const snapshot = buildSeedSnapshot();
    const gps = snapshot.satellites.filter((item) => item.constellationId === 'gps');
    expect(gps).toHaveLength(24);
    expect(gps.every((item) => item.planeIndex !== null)).toBe(true);
    expect(gps.every((item) => item.slotIndex !== null)).toBe(true);
    const gpsView = snapshot.constellations.find((item) => item.id === 'gps');
    expect(gpsView?.planes).toHaveLength(6);
    expect(gpsView?.planes.every((plane) => plane.slots.length === 4)).toBe(true);
  });

  it('derives GEO slot longitudes for geostationary members', () => {
    const snapshot = buildSeedSnapshot();
    const geo = snapshot.satellites.filter(
      (item) => item.orbit.summary.orbitClass === 'GEO',
    );
    expect(geo.length).toBeGreaterThanOrEqual(8);
    const longitudes = geo.map((item) => item.orbit.summary.geoLongitudeDeg);
    expect(longitudes.every((value) => value !== null)).toBe(true);
    expect(longitudes).toContainEqual(expect.closeTo(77, 0));
    expect(longitudes).toContainEqual(expect.closeTo(-62, 0));
  });

  it('emits the expected modeled ISL mesh counts', () => {
    const snapshot = buildSeedSnapshot();
    const isl = snapshot.relations.filter((item) => item.type === 'ISL_MODELED');
    expect(isl).toHaveLength(EXPECTED_ISL);
    expect(isl.every((item) => item.confidence === 'MODELED')).toBe(true);
    expect(isl.every((item) => item.method === 'GridIslTopologyRule@1')).toBe(true);
  });

  it('emits declared relay and curated relations', () => {
    const snapshot = buildSeedSnapshot();
    expect(
      snapshot.relations.filter((item) => item.type === 'RELAY_SERVES'),
    ).toHaveLength(5);
    expect(
      snapshot.relations.filter((item) => item.type === 'DOCKED_TO'),
    ).toHaveLength(1);
    expect(
      snapshot.relations.filter((item) => item.type === 'FORMATION_WITH'),
    ).toHaveLength(2);
    // No two curated GEO slots are within 0.1 degrees.
    expect(
      snapshot.relations.filter((item) => item.type === 'CO_LOCATED'),
    ).toHaveLength(0);
  });

  it('keeps relation ids unique and free of self links', () => {
    const snapshot = buildSeedSnapshot();
    const ids = new Set<string>();
    for (const relation of snapshot.relations) {
      expect(ids.has(relation.id)).toBe(false);
      ids.add(relation.id);
      expect(relation.from.id).not.toBe(relation.to.id);
    }
  });

  it('builds layers that reference existing satellites and links', () => {
    const snapshot = buildSeedSnapshot();
    const satelliteIds = new Set(snapshot.satellites.map((item) => item.id));
    const linkIds = new Set(snapshot.links.map((item) => item.id));
    expect(snapshot.layers).toHaveLength(10);
    for (const layer of snapshot.layers) {
      expect(layer.count).toBeGreaterThan(0);
      expect(layer.count).toBe(layer.satelliteIds.length);
      for (const id of layer.satelliteIds) {
        expect(satelliteIds.has(id)).toBe(true);
      }
      for (const id of layer.defaultLinks) {
        expect(linkIds.has(id)).toBe(true);
      }
    }
    // Homepage defaults: modeled ISL on navigation layers, relay and docking.
    const relayLayer = snapshot.layers.find((item) => item.id === 'relay');
    expect(relayLayer?.defaultLinks.length).toBe(5);
    const stationsLayer = snapshot.layers.find((item) => item.id === 'stations');
    expect(stationsLayer?.defaultLinks.length).toBe(1);
  });

  it('links only satellite endpoints that exist', () => {
    const snapshot = buildSeedSnapshot();
    const satelliteIds = new Set(snapshot.satellites.map((item) => item.id));
    for (const link of snapshot.links) {
      expect(satelliteIds.has(link.fromId)).toBe(true);
      expect(satelliteIds.has(link.toId)).toBe(true);
    }
  });
});

describe('buildReadModels', () => {
  it('covers every satellite in the detail map', () => {
    const snapshot = buildSeedSnapshot();
    const bundle = buildReadModels(snapshot);
    expect(bundle.satelliteDetails.size).toBe(snapshot.satellites.length);
    for (const satellite of snapshot.satellites) {
      expect(bundle.satelliteDetails.has(satellite.id)).toBe(true);
    }
    expect(bundle.layers).toHaveLength(snapshot.layers.length);
    expect(bundle.orbitCsv).toBe(snapshot.orbitCsv);
  });
});

describe('satelliteShard', () => {
  it('is deterministic and bounded to 64 buckets', () => {
    const buckets = new Set<string>();
    for (let id = 0; id < 5000; id += 1) {
      buckets.add(satelliteShard(String(id)));
    }
    expect(satelliteShard('25544')).toBe(satelliteShard('25544'));
    expect(buckets.size).toBeLessThanOrEqual(64);
    for (const bucket of buckets) {
      expect(/^[0-9a-f]{2}$/.test(bucket)).toBe(true);
    }
  });
});

describe('readModelEntries', () => {
  it('emits KV entries whose values parse back to JSON', () => {
    const snapshot = buildSeedSnapshot();
    const dataset = buildSeedDataset();
    expect(dataset.satellites).toHaveLength(EXPECTED_SATELLITES);
    const entries = readModelEntries(snapshot, { graph: 'seed', agent: 'fake' });
    expect(entries.length).toBeGreaterThan(0);
    for (const { key, value } of entries) {
      if (key.includes('orbits') || key.startsWith('ptr:')) {
        continue;
      }
      expect(() => JSON.parse(value), key).not.toThrow();
    }
  });
});
