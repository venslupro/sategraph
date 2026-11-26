import {id, keys, type Obj, ReadError} from '../sg-api-gateway/read_contract.ts';

export type Analysis = 'path'|'neighbors'|'common-neighbors'|'degree';
export function isAnalysis(v: string): v is Analysis {
  return ['path', 'neighbors', 'common-neighbors', 'degree'].includes(v);
}
export const evidenceKinds = ['DECLARED', 'DERIVED', 'MODELED'];
export function utcMillis(value: unknown): number {
  if (typeof value !== 'string' ||
      !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{3})?Z$/
           .test(value)) {
    throw new ReadError('INVALID_TIME');
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at) ||
      new Date(at).toISOString() !==
          (value.length === 20 ? value.slice(0, -1) + '.000Z' : value)) {
    throw new ReadError('INVALID_TIME');
  }
  return at;
}
function ids(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || !value.every(id)) {
    throw new ReadError('INVALID_QUERY');
  }
  return [...new Set<string>(value)];
}
export function policy(op: Analysis, obj: Obj) {
  const pair = op === 'path' || op === 'common-neighbors';
  keys(obj, [
    'from', ...(pair ? ['to'] : []), 'scenario_id', 'analysis_time', 'purpose',
    'orbit_manifest_id', 'model_version', 'direction', 'evidence_types',
    'exclude_nodes', 'exclude_edges',
    ...(op === 'path' || op === 'neighbors' ? ['max_hops'] : []),
    ...(op === 'neighbors' ? ['mode'] : []), 'context_revision'
  ]);
  for (const k
           of ['from', ...(pair ? ['to'] : []), 'scenario_id', 'purpose',
               'orbit_manifest_id', 'model_version']) {
    if (!id(obj[k])) {
      throw new ReadError('INVALID_QUERY');
    }
  }
  const ev = ids(obj.evidence_types ?? evidenceKinds, 3);
  const excluded = ids(obj.exclude_nodes ?? [], 32);
  const direction = obj.direction ?? 'OUT';
  const hops = Number(obj.max_hops ?? (op === 'path' ? 12 : 1));
  if ((direction !== 'OUT' && direction !== 'IN') || !ev.length ||
      !ev.every(v => evidenceKinds.includes(v)) || !Number.isInteger(hops) ||
      hops < 1 || hops > 12 ||
      (obj.max_hops !== undefined && typeof obj.max_hops !== 'number') ||
      (obj.mode !== undefined && obj.mode !== 'exact' &&
       obj.mode !== 'within') ||
      excluded.includes(String(obj.from)) ||
      excluded.includes(String(obj.to)) ||
      !Number.isSafeInteger(obj.context_revision ?? 0) ||
      Number(obj.context_revision ?? 0) < 0) {
    throw new ReadError('INVALID_QUERY');
  }
  return {
    from: String(obj.from),
    to: String(pair ? obj.to : obj.from),
    scenario: String(obj.scenario_id),
    at: utcMillis(obj.analysis_time),
    purpose: String(obj.purpose),
    manifest: String(obj.orbit_manifest_id),
    model: String(obj.model_version),
    direction,
    hops,
    evidence: ev,
    exclude: excluded,
    excludeEdges: ids(obj.exclude_edges ?? [], 32),
    mode: obj.mode ?? 'within',
    revision: Number(obj.context_revision ?? 0),
    pair
  };
}
export type Policy = ReturnType<typeof policy>;
