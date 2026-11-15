import { describe, expect, it } from 'vitest';
import { groupByEntity, matchRecord } from '../src/domain/matching';
import { generateMergeCypher, mergeField } from '../src/domain/merge-policy';
import { Satellite, type SatelliteProps } from '../src/domain/satellite';

describe('matchRecord', () => {
  it('prefers NORAD, then COSPAR, then JCAT, then Wikidata', () => {
    expect(
      matchRecord({ source: 'gcat', noradId: '25544', cosparId: '1998-067A' }),
    ).toEqual({ matchedBy: 'norad', key: '25544' });
    expect(matchRecord({ source: 'gcat', cosparId: '1998-067a' })).toEqual({
      matchedBy: 'cospar',
      key: '1998-067A',
    });
    expect(matchRecord({ source: 'gcat', jcatId: 'J00001' }).matchedBy).toBe('jcat');
    expect(matchRecord({ source: 'wikidata', wikidataId: 'Q25271' }).matchedBy).toBe(
      'wikidata',
    );
    expect(matchRecord({ source: 'satnogs' }).matchedBy).toBe('none');
  });
});

describe('groupByEntity', () => {
  it('groups records that share an entity key', () => {
    const groups = groupByEntity([
      { source: 'celestrak', noradId: '25544' },
      { source: 'gcat', noradId: '25544', cosparId: '1998-067A' },
      { source: 'wikidata', wikidataId: 'Q25271' },
      { source: 'satnogs' },
    ]);
    expect(groups.get('25544')).toHaveLength(2);
    expect(groups.get('Q25271')).toHaveLength(1);
    expect(groups.size).toBe(2);
  });
});

describe('mergeField', () => {
  const candidates = [
    {
      field: 'name',
      value: 'ISS (ZARYA)',
      source: 'celestrak',
      license: 'CelesTrak terms',
      retrievedAt: new Date('2026-11-09T00:00:00Z'),
    },
    {
      field: 'name',
      value: 'International Space Station',
      source: 'wikidata',
      license: 'CC0 1.0',
      retrievedAt: new Date('2026-11-09T00:00:00Z'),
    },
    {
      field: 'name',
      value: 'ISS',
      source: 'curation',
      license: 'CC BY 4.0',
      retrievedAt: new Date('2026-11-09T00:00:00Z'),
    },
  ];

  it('picks the highest priority source for the category', () => {
    const merged = mergeField('identity', candidates);
    expect(merged?.value).toBe('ISS');
    expect(merged?.source).toBe('curation');
  });

  it('keeps every candidate in provenance order', () => {
    const merged = mergeField('identity', candidates);
    expect(merged?.provenance.candidates).toEqual([
      { value: 'ISS', source: 'curation' },
      { value: 'International Space Station', source: 'wikidata' },
      { value: 'ISS (ZARYA)', source: 'celestrak' },
    ]);
    expect(merged?.provenance.retrievedAt).toBe('2026-11-09T00:00:00Z');
  });

  it('uses catalog priorities differently from identity', () => {
    const merged = mergeField('catalog', candidates);
    // gcat is first for catalog; unknown gcat absent, celestrak precedes curation.
    expect(merged?.source).toBe('celestrak');
  });

  it('returns null for empty candidate lists', () => {
    expect(mergeField('identity', [])).toBeNull();
  });
});

describe('generateMergeCypher', () => {
  it('emits prefixed properties, provenance and the graph version', () => {
    const spec = generateMergeCypher('s', 'row', [
      { property: 'name', category: 'identity', column: 'NAME', source: 'gcat' },
      { property: 'massKg', category: 'physical', column: 'MASS', source: 'gcat' },
    ]);
    expect(spec.cypher).toContain('s.gcat_name = row.NAME');
    expect(spec.cypher).toContain('s.gcat_massKg = row.MASS');
    expect(spec.cypher).toContain('s.provenance');
    expect(spec.cypher).toContain('s.updatedVersion = $graphVersion');
    expect(spec.properties).toEqual(['gcat_name', 'gcat_massKg']);
  });
});

function satelliteProps(overrides: Partial<SatelliteProps> = {}): SatelliteProps {
  return {
    objectId: '25544',
    cosparId: '1998-067A',
    jcatId: null,
    wikidataId: null,
    names: [
      { value: 'ISS', language: 'en', source: 'curation' },
      { value: '空间站', language: 'zh', source: 'curation' },
    ],
    status: 'ACTIVE',
    profile: {
      purpose: 'Crewed station',
      country: 'International',
      operator: 'NASA',
      manufacturer: 'Boeing',
      bus: null,
      massKg: null,
      powerWatts: null,
      launchDate: '1998-11-20',
      constellationId: null,
      layerId: 'stations',
    },
    orbitSummary: {
      semiMajorAxisKm: 6793,
      perigeeKm: 420,
      apogeeKm: 422,
      periodMin: 92.9,
      inclinationDeg: 51.64,
      eccentricity: 0.0005,
      orbitClass: 'LEO',
      geoLongitudeDeg: null,
    },
    provenance: [],
    updatedVersion: 'v1',
    ...overrides,
  };
}

describe('Satellite aggregate', () => {
  it('rejects illegal lifecycle transitions', () => {
    const satellite = new Satellite(satelliteProps({ status: 'DECAYED' }));
    expect(() =>
      satellite.changeStatus('ACTIVE', new Date(), 'v2'),
    ).toThrow(/Illegal satellite transition/);
  });

  it('emits a domain event on legal transitions', () => {
    const satellite = new Satellite(satelliteProps());
    const event = satellite.changeStatus('INACTIVE', new Date('2026-11-10T01:00:00Z'), 'v2');
    expect(event.type).toBe('SatelliteStatusChanged');
    expect(event.from).toBe('ACTIVE');
    expect(event.to).toBe('INACTIVE');
    expect(event.graphVersion).toBe('v2');
    expect(satellite.status).toBe('INACTIVE');
  });

  it('prefers the requested display language', () => {
    const satellite = new Satellite(satelliteProps());
    expect(satellite.displayName('zh')).toBe('空间站');
    expect(satellite.displayName('en')).toBe('ISS');
  });

  it('only renders active satellites with orbit summaries', () => {
    expect(new Satellite(satelliteProps()).isRenderable()).toBe(true);
    expect(new Satellite(satelliteProps({ status: 'INACTIVE' })).isRenderable()).toBe(
      false,
    );
    expect(
      new Satellite(satelliteProps({ orbitSummary: null })).isRenderable(),
    ).toBe(false);
  });

  it('writes orbit summaries back only on meaningful change', () => {
    const satellite = new Satellite(satelliteProps());
    const base = satellite.orbitSummary!;
    expect(satellite.needsOrbitSummaryWrite({ ...base, perigeeKm: 421 })).toBe(false);
    expect(satellite.needsOrbitSummaryWrite({ ...base, perigeeKm: 430 })).toBe(true);
    expect(satellite.needsOrbitSummaryWrite({ ...base, orbitClass: 'MEO' })).toBe(true);
  });
});
