/**
 * Source adapter (anti-corruption layer). One adapter per external source; it
 * declares the request, the refresh cadence, the license and the mapping from
 * external columns to domain fields. Import Cypher is generated from mappings.
 */
import type { FieldCategory } from '@satgraph/catalog';

export type SourceFormat = 'csv' | 'tsv' | 'json' | 'html' | 'curation';

export type SourceCadence = '2h' | '48h' | 'daily' | 'weekly' | 'on-deploy';

export interface FieldMapping {
  /** External column name. */
  column: string;
  /** Domain field, e.g. `name`. */
  field: string;
  category: FieldCategory;
  /** Source prefix used on Neo4j properties. */
  source: string;
}

export interface SourceAdapter {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly format: SourceFormat;
  readonly cadence: SourceCadence;
  readonly license: string;
  readonly attribution: string;
  /** Ordered mapping from source columns to domain fields. */
  readonly mapping: readonly FieldMapping[];
  /** Selects the node label or edge handled by this source. */
  readonly target: string;
  /** Idempotency key derived from response headers or data time. */
  requestHeaders(): Record<string, string>;
}

export class HttpSourceAdapter implements SourceAdapter {
  constructor(
    readonly id: string,
    readonly label: string,
    readonly url: string,
    readonly format: SourceFormat,
    readonly cadence: SourceCadence,
    readonly license: string,
    readonly attribution: string,
    readonly mapping: FieldMapping[],
    readonly target: string,
    private readonly extraHeaders: Record<string, string> = {},
  ) {}

  requestHeaders(): Record<string, string> {
    return {
      'User-Agent': 'SatGraph/1.0 (+https://satgraph.example; public research)',
      Accept: this.format === 'csv' ? 'text/csv' : '*/*',
      ...this.extraHeaders,
    };
  }
}

export const CELESTRAK_GP = new HttpSourceAdapter(
  'celestrak-gp',
  'CelesTrak GP (active)',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=csv',
  'csv',
  '2h',
  'CelesTrak GP data, free to redistribute with attribution',
  'CelesTrak',
  [
    { column: 'OBJECT_NAME', field: 'name', category: 'catalog', source: 'celestrak' },
    { column: 'OBJECT_ID', field: 'cosparId', category: 'identity', source: 'celestrak' },
    { column: 'NORAD_CAT_ID', field: 'objectId', category: 'identity', source: 'celestrak' },
    { column: 'MEAN_MOTION', field: 'meanMotion', category: 'orbit', source: 'celestrak' },
    { column: 'ECCENTRICITY', field: 'eccentricity', category: 'orbit', source: 'celestrak' },
    { column: 'INCLINATION', field: 'inclination', category: 'orbit', source: 'celestrak' },
    { column: 'RA_OF_ASC_NODE', field: 'raan', category: 'orbit', source: 'celestrak' },
    { column: 'ARG_OF_PERICENTER', field: 'argPericenter', category: 'orbit', source: 'celestrak' },
    { column: 'MEAN_ANOMALY', field: 'meanAnomaly', category: 'orbit', source: 'celestrak' },
  ],
  'Satellite',
);

export const CELESTRAK_SATCAT = new HttpSourceAdapter(
  'celestrak-satcat',
  'CelesTrak SATCAT',
  'https://celestrak.org/pub/satcat.csv',
  'csv',
  '48h',
  'CelesTrak SATCAT, free to redistribute with attribution',
  'CelesTrak',
  [
    { column: 'NORAD_CAT_ID', field: 'objectId', category: 'identity', source: 'celestrak' },
    { column: 'OBJECT_NAME', field: 'name', category: 'catalog', source: 'celestrak' },
    { column: 'OBJECT_ID', field: 'cosparId', category: 'identity', source: 'celestrak' },
    { column: 'COUNTRY', field: 'country', category: 'catalog', source: 'celestrak' },
    { column: 'LAUNCH_DATE', field: 'launchDate', category: 'catalog', source: 'celestrak' },
    { column: 'DECAY_DATE', field: 'decayDate', category: 'catalog', source: 'celestrak' },
  ],
  'Satellite',
);

export const GCAT = new HttpSourceAdapter(
  'gcat',
  'GCAT satellite catalog',
  'https://planet4589.org/space/gcat/tsv/cat/satcat.tsv',
  'tsv',
  '48h',
  'CC-BY 4.0',
  'Jonathan McDowell, GCAT',
  [
    { column: 'Satcat', field: 'objectId', category: 'identity', source: 'gcat' },
    { column: 'Name', field: 'name', category: 'catalog', source: 'gcat' },
    { column: 'Owner', field: 'owner', category: 'catalog', source: 'gcat' },
    { column: 'Bus', field: 'bus', category: 'physical', source: 'gcat' },
    { column: 'Launch_Tag', field: 'launchTag', category: 'catalog', source: 'gcat' },
  ],
  'Satellite',
);

export const WIKIDATA = new HttpSourceAdapter(
  'wikidata',
  'Wikidata satellite export',
  'https://query.wikidata.org/sparql?format=csv&query=SELECT%20%3Fitem%20%3FitemLabel%20%3Fnorad%20WHERE%20%7B%3Fitem%20wdt%3AP377%20%3Fnorad%7D',
  'csv',
  '48h',
  'CC0 1.0',
  'Wikidata contributors',
  [
    { column: 'norad', field: 'objectId', category: 'identity', source: 'wikidata' },
    { column: 'itemLabel', field: 'name', category: 'catalog', source: 'wikidata' },
  ],
  'Satellite',
);

export const SATNOGS = new HttpSourceAdapter(
  'satnogs',
  'SatNOGS DB (optional)',
  'https://db.satnogs.org/api/satellites/?format=json',
  'json',
  '48h',
  'CC BY-SA 4.0',
  'SatNOGS contributors',
  [
    { column: 'norad_cat_id', field: 'objectId', category: 'identity', source: 'satnogs' },
    { column: 'name', field: 'name', category: 'catalog', source: 'satnogs' },
  ],
  'Satellite',
);

export const GNSS_STATUS = new HttpSourceAdapter(
  'gnss-status',
  'GNSS official constellation status',
  'https://www.navcen.uscg.gov/gps-constellation',
  'html',
  '48h',
  'Public government pages',
  'USCG NAVCEN and partner agencies',
  [],
  'Constellation',
);

export const CURATION = new HttpSourceAdapter(
  'curation',
  'SatGraph curated relations',
  '/curation/relations.csv',
  'curation',
  'on-deploy',
  'CC BY 4.0 (curated by SatGraph)',
  'SatGraph curation team',
  [
    { column: 'from_id', field: 'from', category: 'relation', source: 'curation' },
    { column: 'to_id', field: 'to', category: 'relation', source: 'curation' },
    { column: 'type', field: 'type', category: 'relation', source: 'curation' },
  ],
  'Relation',
);

export const SOURCE_ADAPTERS: SourceAdapter[] = [
  CELESTRAK_GP,
  CELESTRAK_SATCAT,
  GCAT,
  WIKIDATA,
  SATNOGS,
  GNSS_STATUS,
  CURATION,
];
