import { describe, expect, it } from 'vitest';
import { OMM_COLUMNS, parseOmmCsv, serializeOmmCsv, splitCsvLine } from '../src/omm';

const HEADER = OMM_COLUMNS.join(',');
const ISS_ROW = [
  'ISS (ZARYA)',
  '1998-067A',
  '2026-11-09T00:00:00.000000',
  '15.49310000',
  '0.0006317',
  '51.6416',
  '322.3123',
  '329.4032',
  '30.5228',
  '0',
  'U',
  '25544',
  '999',
  '52600',
  '2.1027000e-05',
  '7.5800000e-05',
  '0.0000000e+00',
].join(',');

describe('splitCsvLine', () => {
  it('handles quoted fields with embedded commas and quotes', () => {
    expect(splitCsvLine('a,"b,c","d""e"')).toEqual(['a', 'b,c', 'd"e']);
  });

  it('trims whitespace around fields', () => {
    expect(splitCsvLine(' a , b ')).toEqual(['a', 'b']);
  });
});

describe('parseOmmCsv', () => {
  it('parses a CelesTrak GP style CSV', () => {
    const records = parseOmmCsv(`${HEADER}\n${ISS_ROW}`);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.objectName).toBe('ISS (ZARYA)');
    expect(record.objectId).toBe('1998-067A');
    expect(record.epoch).toBe('2026-11-09T00:00:00Z');
    expect(record.meanMotion).toBeCloseTo(15.4931, 8);
    expect(record.eccentricity).toBeCloseTo(0.0006317, 10);
    expect(record.noradId).toBe('25544');
    expect(record.bstar).toBeCloseTo(2.1027e-5, 12);
  });

  it('returns an empty list for header-only CSV', () => {
    expect(parseOmmCsv(HEADER)).toEqual([]);
  });
});

describe('serializeOmmCsv', () => {
  it('round-trips records through parse', () => {
    const original = parseOmmCsv(`${HEADER}\n${ISS_ROW}`);
    const csv = serializeOmmCsv(original);
    const reparsed = parseOmmCsv(csv);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0]).toEqual(original[0]);
  });

  it('escapes names that contain commas', () => {
    const original = parseOmmCsv(`${HEADER}\n${ISS_ROW}`);
    original[0].objectName = 'STARLINK-3000, GROUP 4';
    const csv = serializeOmmCsv(original);
    expect(parseOmmCsv(csv)[0].objectName).toBe('STARLINK-3000, GROUP 4');
  });
});
