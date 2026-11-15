/**
 * Orbit summary formulas. This module is the single source of truth: the
 * browser calls these functions directly, while `cypher.ts` generates the
 * equivalent Cypher expressions from the published constants.
 */
import {
  EARTH_RADIUS_KM,
  EARTH_SIDEREAL_DAY_MIN,
  normalizeLongitude,
  radToDeg,
} from '@sategraph/shared-kernel';
import type { OrbitClass, OrbitSummary } from '@sategraph/contracts';
import { parseOmmEpoch } from '@sategraph/shared-kernel';
import type { OmmRecord } from './omm';

export const EARTH_MU = 398600.4418;
export const SECONDS_PER_DAY = 86400;
export const REVOLUTIONS_PER_DAY = 1440;

/** Semi-major axis in km from mean motion in revolutions per day. */
export function meanMotionToSemiMajorAxis(meanMotionRevPerDay: number): number {
  const radiansPerSecond = (meanMotionRevPerDay * 2 * Math.PI) / SECONDS_PER_DAY;
  return Math.cbrt(EARTH_MU / (radiansPerSecond * radiansPerSecond));
}

/** Greenwich mean sidereal time in degrees for an instant. */
export function greenwichSiderealDegrees(date: Date): number {
  const julianDate = date.getTime() / 86400000 + 2440587.5;
  const days = julianDate - 2451545;
  const centuries = days / 36525;
  const degrees =
    280.46061837 +
    360.98564736629 * days +
    0.000387933 * centuries * centuries -
    (centuries * centuries * centuries) / 38710000;
  return ((degrees % 360) + 360) % 360;
}

export function classifyOrbit(
  perigeeKm: number,
  apogeeKm: number,
  inclinationDeg: number,
  periodMin: number,
  eccentricity: number,
): OrbitClass {
  const meanAltitude = (perigeeKm + apogeeKm) / 2;
  if (eccentricity > 0.25 || meanAltitude > 35000 && eccentricity > 0.05) {
    return 'HEO';
  }
  if (
    Math.abs(periodMin - EARTH_SIDEREAL_DAY_MIN) < 15 &&
    eccentricity < 0.02
  ) {
    return inclinationDeg < 2 ? 'GEO' : 'IGSO';
  }
  if (meanAltitude < 2000) {
    return inclinationDeg > 94 && inclinationDeg < 102 ? 'SSO' : 'LEO';
  }
  return 'MEO';
}

/** Derives the summary and GEO slot longitude from a single OMM record. */
export function computeOrbitSummary(record: OmmRecord): OrbitSummary {
  const semiMajorAxisKm = meanMotionToSemiMajorAxis(record.meanMotion);
  const perigeeKm =
    semiMajorAxisKm * (1 - record.eccentricity) - EARTH_RADIUS_KM;
  const apogeeKm =
    semiMajorAxisKm * (1 + record.eccentricity) - EARTH_RADIUS_KM;
  const periodMin =
    record.meanMotion > 0 ? REVOLUTIONS_PER_DAY / record.meanMotion : 0;
  const orbitClass = classifyOrbit(
    perigeeKm,
    apogeeKm,
    record.inclinationDeg,
    periodMin,
    record.eccentricity,
  );
  let geoLongitudeDeg: number | null = null;
  if (orbitClass === 'GEO' || orbitClass === 'IGSO') {
    const epoch = parseOmmEpoch(record.epoch);
    const argumentOfLatitude =
      record.raanDeg + record.argPericenterDeg + record.meanAnomalyDeg;
    geoLongitudeDeg = normalizeLongitude(
      argumentOfLatitude - greenwichSiderealDegrees(epoch),
    );
  }
  return {
    semiMajorAxisKm: round(semiMajorAxisKm, 3),
    perigeeKm: round(perigeeKm, 1),
    apogeeKm: round(apogeeKm, 1),
    periodMin: round(periodMin, 1),
    inclinationDeg: round(record.inclinationDeg, 3),
    eccentricity: record.eccentricity,
    orbitClass,
    geoLongitudeDeg:
      geoLongitudeDeg === null ? null : round(geoLongitudeDeg, 3),
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function altitudeBand(orbitClass: OrbitClass): string {
  switch (orbitClass) {
    case 'LEO':
      return 'Low Earth orbit';
    case 'SSO':
      return 'Sun-synchronous orbit';
    case 'MEO':
      return 'Medium Earth orbit';
    case 'GEO':
      return 'Geostationary orbit';
    case 'IGSO':
      return 'Inclined geosynchronous orbit';
    case 'HEO':
      return 'Highly elliptical orbit';
  }
}

/** Converts an ECI position to ECEF using GMST. */
export function eciToEcef(
  position: { x: number; y: number; z: number },
  gmstDeg: number,
): { x: number; y: number; z: number } {
  const theta = (gmstDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return {
    x: position.x * cos + position.y * sin,
    y: -position.x * sin + position.y * cos,
    z: position.z,
  };
}

/** Latitude in degrees for an ECEF vector. */
export function ecefLatitudeDeg(position: {
  x: number;
  y: number;
  z: number;
}): number {
  const radius = Math.hypot(position.x, position.y, position.z);
  return radToDeg(Math.asin(position.z / radius));
}
