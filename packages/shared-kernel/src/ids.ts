/**
 * Stable identifiers shared across bounded contexts.
 *
 * NORAD catalog numbers are strings so that future 9-digit identifiers are
 * preserved without loss of leading zeros.
 */

export type NoradId = string;
export type CosparId = string;
export type JcatId = string;
export type WikidataId = string;
export type SatelliteId = NoradId;
export type ConstellationId = string;
export type RelationId = string;

const NORAD_PATTERN = /^[0-9]{1,9}$/;

/** Returns true when the value can be used as a NORAD catalog number. */
export function isNoradId(value: string): boolean {
  return NORAD_PATTERN.test(value);
}

/** Normalizes a NORAD identifier by trimming spaces and leading zeros. */
export function normalizeNoradId(value: string | number): NoradId {
  const raw = String(value).trim();
  if (!NORAD_PATTERN.test(raw)) {
    throw new Error(`Invalid NORAD identifier: ${value}`);
  }
  return raw.replace(/^0+(?=\d)/, '');
}

/** Formats a COSPAR international designator, e.g. 1998-067A. */
export function normalizeCosparId(value: string): CosparId {
  return value.trim().toUpperCase();
}

/** Builds a deterministic relation identifier from its endpoints. */
export function relationKey(
  type: string,
  fromId: string,
  toId: string,
): RelationId {
  return `${type}:${fromId}:${toId}`;
}
