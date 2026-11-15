/**
 * Time primitives. The domain never reads the system clock directly; callers
 * inject a Clock so that simulations and tests stay deterministic.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Formats a date as an ISO-8601 UTC instant with second precision. */
export function toIsoUtc(value: Date | number): string {
  const date = typeof value === 'number' ? new Date(value) : value;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Parses an OMM epoch such as `2026-11-09T00:00:00.000000` as UTC. */
export function parseOmmEpoch(value: string): Date {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = /Z$|[+-]\d{2}:?\d{2}$/.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const date = new Date(withZone);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid OMM epoch: ${value}`);
  }
  return date;
}

/** Returns the ISO week key used by backups, e.g. 2026-W45. */
export function isoWeekKey(date: Date): string {
  const utc = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
