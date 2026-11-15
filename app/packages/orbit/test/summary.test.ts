import { describe, expect, it } from 'vitest';
import type { OmmRecord } from '../src/omm';
import {
  classifyOrbit,
  computeOrbitSummary,
  eciToEcef,
  greenwichSiderealDegrees,
  meanMotionToSemiMajorAxis,
} from '../src/summary';

function ommRecord(overrides: Partial<OmmRecord>): OmmRecord {
  return {
    objectName: 'TEST',
    objectId: null,
    epoch: '2026-11-10T00:00:00Z',
    meanMotion: 15.5,
    eccentricity: 0.0005,
    inclinationDeg: 51.6,
    raanDeg: 120,
    argPericenterDeg: 0,
    meanAnomalyDeg: 0,
    ephemerisType: 0,
    classificationType: 'U',
    noradId: '99999',
    elementSetNo: 999,
    revAtEpoch: 1,
    bstar: 0,
    meanMotionDot: 0,
    meanMotionDdot: 0,
    ...overrides,
  };
}

describe('meanMotionToSemiMajorAxis', () => {
  it('matches the GEO radius at one revolution per sidereal day', () => {
    const radius = meanMotionToSemiMajorAxis(1.0027);
    expect(radius).toBeGreaterThan(42_100);
    expect(radius).toBeLessThan(42_230);
  });

  it('matches the ISS radius', () => {
    const radius = meanMotionToSemiMajorAxis(15.4931);
    expect(radius).toBeGreaterThan(6_750);
    expect(radius).toBeLessThan(6_850);
  });
});

describe('classifyOrbit', () => {
  it('classifies the standard regimes', () => {
    expect(classifyOrbit(400, 420, 51.6, 92.9, 0.0005)).toBe('LEO');
    expect(classifyOrbit(600, 620, 98.2, 96.8, 0.0002)).toBe('SSO');
    expect(classifyOrbit(20_000, 20_100, 55, 718, 0.005)).toBe('MEO');
    expect(classifyOrbit(35_780, 35_792, 0.05, 1436.1, 0.0001)).toBe('GEO');
    expect(classifyOrbit(35_780, 35_792, 55, 1436.1, 0.0001)).toBe('IGSO');
    expect(classifyOrbit(500, 39_000, 63.4, 700, 0.7)).toBe('HEO');
  });

  it('treats high eccentricity as HEO regardless of altitude', () => {
    expect(classifyOrbit(300, 20_000, 30, 400, 0.6)).toBe('HEO');
  });
});

describe('computeOrbitSummary', () => {
  it('summarizes a LEO record', () => {
    const summary = computeOrbitSummary(
      ommRecord({ meanMotion: 15.4931, eccentricity: 0.0006317 }),
    );
    expect(summary.orbitClass).toBe('LEO');
    expect(summary.perigeeKm).toBeGreaterThan(350);
    expect(summary.perigeeKm).toBeLessThan(500);
    expect(summary.periodMin).toBeGreaterThan(92);
    expect(summary.periodMin).toBeLessThan(94);
    expect(summary.geoLongitudeDeg).toBeNull();
  });

  it('derives the GEO slot longitude from RAAN at epoch', () => {
    const epoch = '2026-11-10T00:00:00Z';
    const gmst = greenwichSiderealDegrees(new Date(epoch));
    const summary = computeOrbitSummary(
      ommRecord({
        epoch,
        meanMotion: 1.0027,
        eccentricity: 0.0001,
        inclinationDeg: 0.05,
        raanDeg: (77 + gmst) % 360,
      }),
    );
    expect(summary.orbitClass).toBe('GEO');
    expect(summary.geoLongitudeDeg).not.toBeNull();
    expect(summary.geoLongitudeDeg!).toBeCloseTo(77, 1);
  });

  it('classifies near-geosynchronous inclined orbits as IGSO', () => {
    const summary = computeOrbitSummary(
      ommRecord({ meanMotion: 1.0027, eccentricity: 0.0001, inclinationDeg: 55 }),
    );
    expect(summary.orbitClass).toBe('IGSO');
    expect(summary.geoLongitudeDeg).not.toBeNull();
  });
});

describe('eciToEcef', () => {
  it('rotates about the z axis by GMST', () => {
    const rotated = eciToEcef({ x: 1, y: 0, z: 5 }, 90);
    expect(rotated.x).toBeCloseTo(0, 9);
    expect(rotated.y).toBeCloseTo(-1, 9);
    expect(rotated.z).toBe(5);
  });

  it('is identity at zero GMST', () => {
    const rotated = eciToEcef({ x: 3, y: 4, z: 5 }, 0);
    expect(rotated).toEqual({ x: 3, y: 4, z: 5 });
  });
});

describe('greenwichSiderealDegrees', () => {
  it('stays within [0, 360)', () => {
    for (const iso of [
      '2000-01-01T12:00:00Z',
      '2026-11-10T00:00:00Z',
      '2030-06-30T18:45:00Z',
    ]) {
      const value = greenwichSiderealDegrees(new Date(iso));
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(360);
    }
  });

  it('matches the J2000 reference value', () => {
    expect(greenwichSiderealDegrees(new Date('2000-01-01T12:00:00Z'))).toBeCloseTo(
      280.46,
      1,
    );
  });
});
