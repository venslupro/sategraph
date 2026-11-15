/**
 * Generates LOAD CSV statements from a source mapping. Filtering happens before
 * MERGE so that a full GCAT dump never exceeds the free Neo4j node budget.
 */
import type { FieldMapping } from './source-adapter';

export interface LoadCsvSpec {
  sourceId: string;
  urlParameter: string;
  fieldTerminator: string;
  filter: string;
  nodeLabel: string;
  keyProperty: string;
  mapping: readonly FieldMapping[];
}

export interface GeneratedImport {
  cypher: string;
  properties: string[];
}

export function generateLoadCsv(spec: LoadCsvSpec): GeneratedImport {
  const sets = spec.mapping
    .filter((field) => field.field !== spec.keyProperty)
    .map(
      (field) =>
        `s.${field.source}_${field.field} = row.${field.column}`,
    );
  const provenance = spec.mapping.map(
    (field) =>
      `{field: '${field.field}', source: '${field.source}', value: toString(row.${field.column})}`,
  );
  sets.push(
    `s.provenance = coalesce(s.provenance, []) + [${provenance.join(', ')}]`,
  );
  sets.push('s.updatedVersion = $graphVersion');
  const fieldTerminator = spec.fieldTerminator === '\t' ? '\\t' : spec.fieldTerminator;
  const cypher = `LOAD CSV WITH HEADERS FROM ${spec.urlParameter} AS row FIELDTERMINATOR '${fieldTerminator}'
WITH row
WHERE ${spec.filter}
CALL {
  WITH row
  MERGE (s:${spec.nodeLabel} {${spec.keyProperty}: row.${keyColumn(spec)}})
  SET ${sets.join(',\n      ')}
} IN TRANSACTIONS OF 1000 ROWS`;
  return {
    cypher,
    properties: spec.mapping.map((field) => `${field.source}_${field.field}`),
  };
}

function keyColumn(spec: LoadCsvSpec): string {
  const key = spec.mapping.find((field) => field.field === spec.keyProperty);
  return key?.column ?? spec.keyProperty;
}
