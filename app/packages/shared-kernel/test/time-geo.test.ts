import { describe, expect, it } from 'vitest';
import {
  chordDistanceKm,
  ecefToGeodetic,
  formatLatLon,
  normalizeLongitude,
  segmentHitsEarth,
} from '../src/geo';
import { isoWeekKey, parseOmmEpoch, toIsoUtc } from '../src/time';

describe('parseOmmEpoch', () => {
  it('parses fractional OMM epochs as UTC', () => {
    const date = parseOmmEpoch('2026-11-09T00:00:00.000000');
    expect(date.toISOString()).toBe('2026-11-09T00:00:00.000Z');
  });

  it('parses space separated epochs', () => {
    const date = parseOmmEpoch('2026-11-09 12:30:00');
    expect(date.toISOString()).toBe('2026-11-09T12:30:00.000Z');
  });

  it('rejects invalid epochs', () => {
    expect(() => parseOmmEpoch('not-a-date')).toThrow(/Invalid OMM epoch/);
  });
});

describe('toIsoUtc', () => {
  it('drops millisecond precision', () => {
    expect(toIsoUtc(new Date('2026-11-10T01:02:03.456Z'))).toBe(
      '2026-11-10T01:02:03Z',
    );
  });
});

describe('isoWeekKey', () => {
  it('computes ISO week numbers across year boundaries', () => {
    expect(isoWeekKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    expect(isoWeekKey(new Date('2026-11-10T00:00:00Z'))).toBe('2026-W46');
    expect(isoWeekKey(new Date('2020-12-31T00:00:00Z'))).toBe('2020-W53');
    expect(isoWeekKey(new Date('2019-12-30T00:00:00Z'))).toBe('2020-W01');
  });
});

describe('normalizeLongitude', () => {
  it('wraps longitudes into [-180, 180)', () => {
    expect(normalizeLongitude(190)).toBe(-170);
    expect(normalizeLongitude(-190)).toBe(170);
    expect(normalizeLongitude(180)).toBe(-180);
    expect(normalizeLongitude(0)).toBe(0);
    expect(normalizeLongitude(360 + 77)).toBe(77);
  });
});

describe('ecefToGeodetic', () => {
  it('round-trips the equatorial radius', () => {
    const point = ecefToGeodetic({ x: 6371.0088, y: 0, z: 0 });
    expect(point.latDeg).toBeCloseTo(0, 6);
    expect(point.lonDeg).toBeCloseTo(0, 6);
    expect(point.heightKm).toBeCloseTo(0, 3);
  });

  it('resolves the north pole', () => {
    const point = ecefToGeodetic({ x: 0, y: 0, z: 7000 });
    expect(point.latDeg).toBeCloseTo(90, 6);
  });
});

describe('segmentHitsEarth', () => {
  it('detects occlusion through the solid Earth', () => {
    expect(
      segmentHitsEarth({ x: 7000, y: 0, z: 0 }, { x: -7000, y: 0, z: 0 }),
    ).toBe(true);
  });

  it('passes links that clear the surface', () => {
    expect(
      segmentHitsEarth({ x: 42164, y: 0, z: 0 }, { x: 0, y: 0, z: 42164 }),
    ).toBe(false);
  });
});

describe('chordDistanceKm / formatLatLon', () => {
  it('computes straight-line distance', () => {
    expect(
      chordDistanceKm({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }),
    ).toBeCloseTo(5, 6);
  });

  it('formats hemisphere labels', () => {
    expect(formatLatLon(12.345, -56.789)).toBe('12.35° N 56.79° W');
    expect(formatLatLon(-1, 1)).toBe('1.00° S 1.00° E');
  });
});
