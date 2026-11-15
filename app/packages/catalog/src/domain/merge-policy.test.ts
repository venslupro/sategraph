import { describe, expect, it } from 'vitest';
import { mergeField, type FieldCandidate } from './merge-policy';

const retrievedAt = new Date('2026-11-10T00:00:00Z');

function candidate(
  source: string,
  value: string,
  field = 'name',
): FieldCandidate {
  return { field, value, source, license: 'test', retrievedAt };
}

describe('mergeField', () => {
  it('prefers the higher priority source per category', () => {
    const merged = mergeField('catalog', [
      candidate('celestrak', 'ISS (ZARYA)'),
      candidate('gcat', 'ISS'),
    ]);
    expect(merged?.value).toBe('ISS');
    expect(merged?.source).toBe('gcat');
  });

  it('uses a different priority order for orbit fields', () => {
    const merged = mergeField('orbit', [
      candidate('gcat', '15.4', 'meanMotion'),
      candidate('celestrak', '15.5', 'meanMotion'),
    ]);
    expect(merged?.value).toBe('15.5');
  });

  it('keeps every candidate for provenance display', () => {
    const merged = mergeField('catalog', [
      candidate('wikidata', 'International Space Station'),
      candidate('gcat', 'ISS'),
      candidate('celestrak', 'ISS (ZARYA)'),
    ]);
    expect(merged?.candidates).toEqual([
      { value: 'ISS', source: 'gcat' },
      { value: 'ISS (ZARYA)', source: 'celestrak' },
      { value: 'International Space Station', source: 'wikidata' },
    ]);
    expect(merged?.provenance.retrievedAt).toBe('2026-11-10T00:00:00Z');
  });

  it('falls back to insertion order for unknown sources', () => {
    const merged = mergeField('identity', [
      candidate('unknown-a', 'a'),
      candidate('unknown-b', 'b'),
    ]);
    expect(merged?.value).toBe('a');
  });

  it('returns null when there is nothing to merge', () => {
    expect(mergeField('catalog', [])).toBeNull();
  });
});
