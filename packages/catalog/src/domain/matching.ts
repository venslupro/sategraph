/**
 * Entity matching strategy: NORAD number is the primary key, while COSPAR,
 * JCAT and Wikidata identifiers resolve records from other sources.
 */
export interface MatchableRecord {
  source: string;
  noradId?: string | null;
  cosparId?: string | null;
  jcatId?: string | null;
  wikidataId?: string | null;
}

export interface MatchResult {
  matchedBy: 'norad' | 'cospar' | 'jcat' | 'wikidata' | 'none';
  key: string | null;
}

export function matchRecord(record: MatchableRecord): MatchResult {
  if (record.noradId) {
    return { matchedBy: 'norad', key: record.noradId };
  }
  if (record.cosparId) {
    return { matchedBy: 'cospar', key: record.cosparId.toUpperCase() };
  }
  if (record.jcatId) {
    return { matchedBy: 'jcat', key: record.jcatId };
  }
  if (record.wikidataId) {
    return { matchedBy: 'wikidata', key: record.wikidataId };
  }
  return { matchedBy: 'none', key: null };
}

/** Groups records that resolve to the same entity key. */
export function groupByEntity<T extends MatchableRecord>(
  records: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const match = matchRecord(record);
    if (!match.key) {
      continue;
    }
    const bucket = groups.get(match.key) ?? [];
    bucket.push(record);
    groups.set(match.key, bucket);
  }
  return groups;
}
