/**
 * OMM to TLE projection. The SGP4 implementation in the browser accepts TLE
 * records, so the worker formats OMM fields into the fixed-width two-line form
 * without a second network source. Lines are generated, not archived.
 */
import type { OmmRecord } from './omm';

function checksum(line: string): number {
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

function pad(value: string, width: number): string {
  return value.length > width ? value.slice(value.length - width) : value.padStart(width, ' ');
}

function fixed(value: number, width: number, decimals: number): string {
  const rounded = Object.is(value, -0) ? 0 : value;
  return rounded.toFixed(decimals).padStart(width, ' ');
}

/** Formats a value as the TLE sign/mantissa/exponent field (8 columns). */
function exponential(value: number): string {
  if (!Number.isFinite(value) || value === 0) {
    return ' 00000-0';
  }
  const sign = value < 0 ? '-' : ' ';
  const magnitude = Math.abs(value);
  // TLE writes the field as 0.<mantissa> x 10^exponent, e.g. 21027-4.
  let exponent = Math.floor(Math.log10(magnitude)) + 1;
  let mantissa = Math.round((magnitude / 10 ** exponent) * 1e5);
  if (mantissa >= 1e5) {
    mantissa = Math.round(mantissa / 10);
    exponent += 1;
  }
  const exponentSign = exponent < 0 ? '-' : '+';
  return `${sign}${String(mantissa).padStart(5, '0')}${exponentSign}${Math.abs(exponent) % 10}`;
}

function epochFields(epoch: string): { year: string; day: string } {
  const date = new Date(epoch.includes('Z') ? epoch : `${epoch}Z`);
  if (Number.isNaN(date.getTime())) {
    return { year: '00', day: '001.00000000' };
  }
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const dayOfYear = (date.getTime() - start) / 86_400_000 + 1;
  const whole = Math.floor(dayOfYear);
  const fraction = Math.round((dayOfYear - whole) * 1e8);
  return {
    year: String(year % 100).padStart(2, '0'),
    day: `${String(whole).padStart(3, '0')}.${String(fraction).padStart(8, '0')}`,
  };
}

function internationalDesignator(objectId: string | null): string {
  if (!objectId) {
    return '00001A  ';
  }
  const match = objectId.match(/^(\d{4})-(\d{1,3})([A-Z]{1,3})$/);
  if (!match) {
    return '00001A  ';
  }
  return `${match[1].slice(2)}${match[2].padStart(3, '0')}${match[3].padEnd(3, ' ')}`;
}

function normalizeAngle(value: number): number {
  return ((value % 360) + 360) % 360;
}

/** Projects an OMM record into TLE lines accepted by SGP4. */
export function toTleLines(record: OmmRecord): [string, string] {
  const { year, day } = epochFields(record.epoch);
  const satnum = pad(record.noradId, 5);
  const line1Body = [
    `1 ${satnum}${record.classificationType || 'U'} ${internationalDesignator(record.objectId)} `,
    `${year}${day} `,
    fixed(record.meanMotionDot, 10, 8),
    ' ',
    exponential(record.meanMotionDdot),
    ' ',
    exponential(record.bstar),
    ' ',
    String(record.ephemerisType).slice(0, 1),
    ' ',
    pad(String(record.elementSetNo), 4),
  ].join('');
  const line1 = `${line1Body}${checksum(line1Body)}`;

  const eccentricity = String(Math.round(record.eccentricity * 1e7)).padStart(7, '0').slice(-7);
  const line2Body = [
    `2 ${satnum} `,
    fixed(normalizeAngle(record.inclinationDeg), 8, 4),
    ' ',
    fixed(normalizeAngle(record.raanDeg), 8, 4),
    ' ',
    eccentricity,
    ' ',
    fixed(normalizeAngle(record.argPericenterDeg), 8, 4),
    ' ',
    fixed(normalizeAngle(record.meanAnomalyDeg), 8, 4),
    ' ',
    fixed(record.meanMotion, 11, 8),
    pad(String(record.revAtEpoch), 5),
  ].join('');
  const line2 = `${line2Body}${checksum(line2Body)}`;
  return [line1, line2];
}
