/**
 * Helpers that turn a seed orbit description into OMM mean motion. Kept apart
 * from the dataset so the OMM builder has no circular dependency.
 */
import { EARTH_RADIUS_KM, EARTH_MU_KM3_S2 } from '@satgraph/shared-kernel';
import type { SeedOrbit } from './dataset';

const SECONDS_PER_DAY = 86400;
const REVOLUTIONS_PER_DAY = 1440;

export interface SeedOrbitDerived {
  meanMotion: number;
  periodMin: number;
}

export function summarizeForSeed(orbit: SeedOrbit): SeedOrbitDerived {
  const semiMajorAxis = EARTH_RADIUS_KM + orbit.altitudeKm;
  const periodSeconds =
    2 * Math.PI * Math.sqrt((semiMajorAxis ** 3) / EARTH_MU_KM3_S2);
  return {
    meanMotion: SECONDS_PER_DAY / periodSeconds,
    periodMin: periodSeconds / 60,
  };
}

export { REVOLUTIONS_PER_DAY };
