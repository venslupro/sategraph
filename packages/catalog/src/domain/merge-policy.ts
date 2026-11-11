/**
 * Field-level fusion policy. Every source writes prefixed properties; the
 * policy picks a winning value per field category and keeps all candidates.
 * Adjusting priorities is configuration only, mirroring the design intent.
 */
import type { ProvenanceEntry } from '@sategraph/contracts';
import { toIsoUtc } from '@sategraph/shared-kernel';

export type FieldCategory =
  | 'identity'
  | 'orbit'
  | 'catalog'
  | 'physical'
  | 'frequency'
  | 'relation';

export interface FieldCandidate {
  field: string;
  value: string;
  source: string;
  license: string;
  url?: string;
  retrievedAt: Date;
}

export type SourcePriority = Record<FieldCategory, string[]>;

export const DEFAULT_SOURCE_PRIORITY: SourcePriority = {
  identity: ['curation', 'gcat', 'wikidata', 'celestrak'],
  orbit: ['celestrak', 'gcat', 'satnogs'],
  catalog: ['gcat', 'celestrak', 'wikidata', 'curation'],
  physical: ['wikidata', 'gcat', 'curation'],
  frequency: ['satnogs', 'curation', 'gcat'],
  relation: ['curation', 'gcat', 'wikidata', 'celestrak'],
};

export interface MergedField {
  field: string;
  value: string;
  source: string;
  candidates: ProvenanceEntry['candidates'];
  provenance: ProvenanceEntry;
}

/**
 * Chooses the highest priority candidate, falling back to source order when a
 * category lists an unknown source.
 */
export function mergeField(
  category: FieldCategory,
  candidates: readonly FieldCandidate[],
  priority: SourcePriority = DEFAULT_SOURCE_PRIORITY,
): MergedField | null {
  if (candidates.length === 0) {
    return null;
  }
  const order = priority[category];
  const ranked = [...candidates].sort((a, b) => {
    const aRank = order.indexOf(a.source);
    const bRank = order.indexOf(b.source);
    return (aRank === -1 ? order.length : aRank) -
      (bRank === -1 ? order.length : bRank);
  });
  const winner = ranked[0];
  const provenance: ProvenanceEntry = {
    field: winner.field,
    value: winner.value,
    source: winner.source,
    license: winner.license,
    url: winner.url,
    retrievedAt: toIsoUtc(winner.retrievedAt),
    candidates: ranked.map((candidate) => ({
      value: candidate.value,
      source: candidate.source,
    })),
  };
  return {
    field: winner.field,
    value: winner.value,
    source: winner.source,
    candidates: provenance.candidates,
    provenance,
  };
}

export interface MergeCypherField {
  /** Target node property, e.g. `name`. */
  property: string;
  category: FieldCategory;
  /** Column in the LOAD CSV row. */
  column: string;
  /** Source-specific prefix, e.g. `gcat`. */
  source: string;
}

export interface MergeCypherSpec {
  cypher: string;
  properties: string[];
}

/**
 * Generates a deterministic MERGE/SET clause. All candidate values are kept in
 * `s.provenance` so the UI can show "field-level source and multiple values".
 */
export function generateMergeCypher(
  alias: string,
  rowAlias: string,
  fields: readonly MergeCypherField[],
  graphVersionParam = '$graphVersion',
): MergeCypherSpec {
  const sets = fields.map((field) => {
    const prefixed = `${field.source}_${field.property}`;
    return `${alias}.${prefixed} = ${rowAlias}.${field.column}`;
  });
  const provenance = fields.map(
    (field) =>
      `{field: '${field.property}', source: '${field.source}', value: toString(${rowAlias}.${field.column})}`,
  );
  sets.push(`${alias}.provenance = coalesce(${alias}.provenance, []) + [${provenance.join(', ')}]`);
  sets.push(`${alias}.updatedVersion = ${graphVersionParam}`);
  return {
    cypher: `SET ${sets.join(',\n    ')}`,
    properties: fields.map((field) => `${field.source}_${field.property}`),
  };
}
