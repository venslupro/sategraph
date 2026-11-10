/**
 * CCSDS OMM (Orbit Mean-elements Message) in CSV form. OMM replaces TLE as the
 * canonical element format because NORAD identifiers are about to exceed five
 * digits. The same CSV feeds the browser propagator and Neo4j LOAD CSV.
 */
import { parseOmmEpoch, toIsoUtc } from '@satgraph/shared-kernel';

export const OMM_COLUMNS = [
  'OBJECT_NAME',
  'OBJECT_ID',
  'EPOCH',
  'MEAN_MOTION',
  'ECCENTRICITY',
  'INCLINATION',
  'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER',
  'MEAN_ANOMALY',
  'EPHEMERIS_TYPE',
  'CLASSIFICATION_TYPE',
  'NORAD_CAT_ID',
  'ELEMENT_SET_NO',
  'REV_AT_EPOCH',
  'BSTAR',
  'MEAN_MOTION_DOT',
  'MEAN_MOTION_DDOT',
] as const;

export interface OmmRecord {
  objectName: string;
  /** COSPAR international designator. */
  objectId: string | null;
  epoch: string;
  meanMotion: number;
  eccentricity: number;
  inclinationDeg: number;
  raanDeg: number;
  argPericenterDeg: number;
  meanAnomalyDeg: number;
  ephemerisType: number;
  classificationType: string;
  noradId: string;
  elementSetNo: number;
  revAtEpoch: number;
  bstar: number;
  meanMotionDot: number;
  meanMotionDdot: number;
}

/** Splits a CSV line, honouring double-quoted fields with doubled quotes. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

function numeric(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseOmmCsv(csv: string): OmmRecord[] {
  const lines = csv
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return [];
  }
  const header = splitCsvLine(lines[0]);
  const index = new Map(header.map((column, position) => [column, position]));
  const get = (row: string[], column: string): string =>
    row[index.get(column) ?? -1] ?? '';

  return lines.slice(1).map((line) => {
    const row = splitCsvLine(line);
    const record: OmmRecord = {
      objectName: get(row, 'OBJECT_NAME'),
      objectId: get(row, 'OBJECT_ID') || null,
      epoch: toIsoUtc(parseOmmEpoch(get(row, 'EPOCH'))),
      meanMotion: numeric(get(row, 'MEAN_MOTION')),
      eccentricity: numeric(get(row, 'ECCENTRICITY')),
      inclinationDeg: numeric(get(row, 'INCLINATION')),
      raanDeg: numeric(get(row, 'RA_OF_ASC_NODE')),
      argPericenterDeg: numeric(get(row, 'ARG_OF_PERICENTER')),
      meanAnomalyDeg: numeric(get(row, 'MEAN_ANOMALY')),
      ephemerisType: numeric(get(row, 'EPHEMERIS_TYPE')),
      classificationType: get(row, 'CLASSIFICATION_TYPE') || 'U',
      noradId: get(row, 'NORAD_CAT_ID'),
      elementSetNo: numeric(get(row, 'ELEMENT_SET_NO')),
      revAtEpoch: numeric(get(row, 'REV_AT_EPOCH')),
      bstar: numeric(get(row, 'BSTAR')),
      meanMotionDot: numeric(get(row, 'MEAN_MOTION_DOT')),
      meanMotionDdot: numeric(get(row, 'MEAN_MOTION_DDOT')),
    };
    return record;
  });
}

function escapeCsv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function serializeOmmCsv(records: readonly OmmRecord[]): string {
  const rows = records.map((record) =>
    [
      escapeCsv(record.objectName),
      record.objectId ?? '',
      record.epoch,
      record.meanMotion.toFixed(8),
      record.eccentricity.toFixed(7),
      record.inclinationDeg.toFixed(4),
      record.raanDeg.toFixed(4),
      record.argPericenterDeg.toFixed(4),
      record.meanAnomalyDeg.toFixed(4),
      String(record.ephemerisType),
      record.classificationType,
      record.noradId,
      String(record.elementSetNo),
      String(record.revAtEpoch),
      record.bstar.toExponential(7),
      record.meanMotionDot.toExponential(7),
      record.meanMotionDdot.toExponential(7),
    ].join(','),
  );
  return [OMM_COLUMNS.join(','), ...rows].join('\n');
}

/**
 * satellite.js `json2satrec` input. Field names match the SGP4 JSON schema so
 * no translation is needed in the browser worker.
 */
export function toSatrecJson(record: OmmRecord): Record<string, string | number> {
  return {
    OBJECT_NAME: record.objectName,
    OBJECT_ID: record.objectId ?? '',
    EPOCH: record.epoch,
    MEAN_MOTION: record.meanMotion,
    ECCENTRICITY: record.eccentricity,
    INCLINATION: record.inclinationDeg,
    RA_OF_ASC_NODE: record.raanDeg,
    ARG_OF_PERICENTER: record.argPericenterDeg,
    MEAN_ANOMALY: record.meanAnomalyDeg,
    EPHEMERIS_TYPE: record.ephemerisType,
    CLASSIFICATION_TYPE: record.classificationType,
    NORAD_CAT_ID: record.noradId,
    ELEMENT_SET_NO: record.elementSetNo,
    REV_AT_EPOCH: record.revAtEpoch,
    BSTAR: record.bstar,
    MEAN_MOTION_DOT: record.meanMotionDot,
    MEAN_MOTION_DDOT: record.meanMotionDdot,
  };
}
