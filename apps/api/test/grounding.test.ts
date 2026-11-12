import { describe, expect, it } from 'vitest';
import { checkGrounding } from '../src/application/agent/grounding';

describe('checkGrounding', () => {
  it('verifies answers whose numbers appear in tool evidence', () => {
    const report = checkGrounding(
      'The GPS constellation has 6 planes and 24 active satellites.',
      ['{"name":"GPS","planes":6,"activeCount":24}'],
    );
    expect(report.verified).toBe(true);
    expect(report.unverifiedClaims).toEqual([]);
  });

  it('flags sentences with numbers missing from evidence', () => {
    const report = checkGrounding(
      'The GPS constellation has 6 planes. BeiDou has 99 satellites.',
      ['{"planes":6}'],
    );
    expect(report.verified).toBe(false);
    expect(report.unverifiedClaims).toEqual(['BeiDou has 99 satellites.']);
  });

  it('ignores calendar years and tiny ordinals', () => {
    const report = checkGrounding(
      'Launched in 2018, the 2 satellites remain healthy.',
      ['{"launch":"block"}'],
    );
    expect(report.verified).toBe(true);
  });

  it('matches numbers across formatting in the evidence', () => {
    const report = checkGrounding(
      'Apogee is 42164.2 km.',
      ['semiMajorAxisKm: 42164.2'],
    );
    expect(report.verified).toBe(true);
  });

  it('caps unverified claims at four sentences', () => {
    const answer = Array.from(
      { length: 8 },
      (_, index) => `Claim ${100 + index} satellites.`,
    ).join(' ');
    const report = checkGrounding(answer, ['nothing relevant']);
    expect(report.unverifiedClaims.length).toBeLessThanOrEqual(4);
  });
});
