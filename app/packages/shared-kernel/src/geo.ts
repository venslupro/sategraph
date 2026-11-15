/**
 * Geodesy helpers shared by the browser propagator and server-side queries.
 * All angles are in degrees unless the name says otherwise.
 */

export const EARTH_RADIUS_KM = 6371.0088;
export const EARTH_MU_KM3_S2 = 398600.4418;
export const EARTH_SIDEREAL_DAY_MIN = 1436.068;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export interface GeodeticPoint {
  latDeg: number;
  lonDeg: number;
  heightKm: number;
}

export interface EcefVector {
  x: number;
  y: number;
  z: number;
}

export function degToRad(deg: number): number {
  return deg * DEG_TO_RAD;
}

export function radToDeg(rad: number): number {
  return rad * RAD_TO_DEG;
}

/** Wraps a longitude into [-180, 180). */
export function normalizeLongitude(deg: number): number {
  const wrapped = ((deg + 180) % 360 + 360) % 360 - 180;
  return wrapped;
}

/** Converts an ECEF position to geodetic coordinates assuming a sphere. */
export function ecefToGeodetic(position: EcefVector): GeodeticPoint {
  const distance = Math.hypot(position.x, position.y, position.z);
  return {
    latDeg: radToDeg(Math.asin(position.z / distance)),
    lonDeg: normalizeLongitude(radToDeg(Math.atan2(position.y, position.x))),
    heightKm: distance - EARTH_RADIUS_KM,
  };
}

/** Returns the chord distance between two ECEF points in kilometres. */
export function chordDistanceKm(a: EcefVector, b: EcefVector): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * True when the segment between two Earth-centred points passes through the
 * solid Earth. Used to hide occluded inter-satellite links.
 */
export function segmentHitsEarth(
  a: EcefVector,
  b: EcefVector,
  radiusKm = EARTH_RADIUS_KM,
): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  if (lengthSquared === 0) {
    return false;
  }
  const t = Math.min(
    1,
    Math.max(0, -(a.x * dx + a.y * dy + a.z * dz) / lengthSquared),
  );
  const px = a.x + t * dx;
  const py = a.y + t * dy;
  const pz = a.z + t * dz;
  return px * px + py * py + pz * pz < radiusKm * radiusKm;
}

/** Circular orbital speed for a radius measured from the Earth's centre. */
export function circularSpeedKmS(radiusKm: number): number {
  return Math.sqrt(EARTH_MU_KM3_S2 / radiusKm);
}

/** Renders a coordinate pair as `12.34° N 56.78° E`. */
export function formatLatLon(latDeg: number, lonDeg: number): string {
  const lat = `${Math.abs(latDeg).toFixed(2)}° ${latDeg >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(lonDeg).toFixed(2)}° ${lonDeg >= 0 ? 'E' : 'W'}`;
  return `${lat} ${lon}`;
}
