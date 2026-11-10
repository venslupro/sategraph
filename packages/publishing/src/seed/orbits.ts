/**
 * Seed orbit elements in OMM form. The browser parses the generated CSV with
 * satellite.js; Neo4j would consume the same CSV through LOAD CSV.
 */
import type { OmmRecord } from '@satgraph/orbit';
import { OMM_COLUMNS } from '@satgraph/orbit';
import { summarizeForSeed } from './omm-builder';
import type { SeedSatellite } from './dataset';

export interface SeedOrbitBundle {
  records: OmmRecord[];
  csv: string;
}

function toOmm(satellite: SeedSatellite): OmmRecord {
  const summary = summarizeForSeed(satellite.orbit);
  return {
    objectName: satellite.name,
    objectId: satellite.cosparId,
    epoch: '2026-11-10T00:00:00Z',
    meanMotion: summary.meanMotion,
    eccentricity: satellite.orbit.eccentricity,
    inclinationDeg: satellite.orbit.inclinationDeg,
    raanDeg: ((satellite.orbit.raanDeg % 360) + 360) % 360,
    argPericenterDeg: 0,
    meanAnomalyDeg: ((satellite.orbit.meanAnomalyDeg % 360) + 360) % 360,
    ephemerisType: 0,
    classificationType: 'U',
    noradId: satellite.id,
    elementSetNo: 999,
    revAtEpoch: 0,
    bstar: 0,
    meanMotionDot: 0,
    meanMotionDdot: 0,
  };
}

export function buildSeedOrbits(satellites: readonly SeedSatellite[]): SeedOrbitBundle {
  const records = satellites.map(toOmm);
  const header = OMM_COLUMNS.join(',');
  const lines = records.map((record) =>
    [
      record.objectName,
      record.objectId ?? '',
      '2026-11-10T00:00:00.000000',
      record.meanMotion.toFixed(8),
      record.eccentricity.toFixed(7),
      record.inclinationDeg.toFixed(4),
      record.raanDeg.toFixed(4),
      record.argPericenterDeg.toFixed(4),
      record.meanAnomalyDeg.toFixed(4),
      '0',
      'U',
      record.noradId,
      '999',
      '0',
      '0.0000000e+0',
      '0.0000000e+0',
      '0.0000000e+0',
    ].join(','),
  );
  return { records, csv: [header, ...lines].join('\n') };
}
