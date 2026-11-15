import { twoline2satrec } from 'satellite.js';
import { describe, expect, it } from 'vitest';
import type { OmmRecord } from '../src/omm';
import { toTleLines } from '../src/tle';

function ommRecord(overrides: Partial<OmmRecord> = {}): OmmRecord {
  return {
    objectName: 'ISS (ZARYA)',
    objectId: '1998-067A',
    epoch: '2026-11-09T00:00:00Z',
    meanMotion: 15.4931,
    eccentricity: 0.0006317,
    inclinationDeg: 51.6416,
    raanDeg: 322.3123,
    argPericenterDeg: 329.4032,
    meanAnomalyDeg: 30.5228,
    ephemerisType: 0,
    classificationType: 'U',
    noradId: '25544',
    elementSetNo: 999,
    revAtEpoch: 52600,
    bstar: 0.000021027,
    meanMotionDot: 0.0000758,
    meanMotionDdot: 0,
    ...overrides,
  };
}

function tleChecksum(line: string): number {
  let total = 0;
  for (const char of line.slice(0, 68)) {
    if (char >= '0' && char <= '9') {
      total += Number(char);
    } else if (char === '-') {
      total += 1;
    }
  }
  return total % 10;
}

describe('toTleLines', () => {
  it('produces two 69-column lines with valid checksums', () => {
    const [line1, line2] = toTleLines(ommRecord());
    expect(line1).toHaveLength(69);
    expect(line2).toHaveLength(69);
    expect(Number(line1[68])).toBe(tleChecksum(line1));
    expect(Number(line2[68])).toBe(tleChecksum(line2));
    expect(line1.startsWith('1 25544U')).toBe(true);
    expect(line2.startsWith('2 25544')).toBe(true);
  });

  it('round-trips through satellite.js twoline2satrec', () => {
    const record = ommRecord();
    const [line1, line2] = toTleLines(record);
    const satrec = twoline2satrec(line1, line2);
    expect(satrec.error).toBe(0);
    // satrec.no is the Kozai-corrected mean motion in radians per minute, so it
    // differs from the raw TLE value by the J2 correction.
    const expectedMeanMotion = (record.meanMotion * 2 * Math.PI) / 1440;
    expect(satrec.no).toBeCloseTo(expectedMeanMotion, 4);
    expect(satrec.ecco).toBeCloseTo(record.eccentricity, 7);
    expect(satrec.inclo).toBeCloseTo((record.inclinationDeg * Math.PI) / 180, 6);
    expect(satrec.nodeo).toBeCloseTo((record.raanDeg * Math.PI) / 180, 6);
    expect(satrec.argpo).toBeCloseTo((record.argPericenterDeg * Math.PI) / 180, 6);
    expect(satrec.mo).toBeCloseTo((record.meanAnomalyDeg * Math.PI) / 180, 6);
    expect(satrec.bstar).toBeCloseTo(record.bstar, 7);
  });

  it('handles zero drag fields without NaN', () => {
    const [line1] = toTleLines(ommRecord({ bstar: 0, meanMotionDot: 0 }));
    expect(line1).not.toContain('NaN');
  });
});
