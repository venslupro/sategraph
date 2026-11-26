import {failure, id, isObj, keys, type Obj, ReadError, readJson, requestObject} from '../sg-api-gateway/read_contract.ts';
import {displaySources} from '../sg-data/policy.ts';
import {validGraphTarget} from '../sg-projector/target.ts';

import {isAnalysis, policy, type Policy, utcMillis} from './policy.ts';
import {analysisTemplate, infoTypes, type Listing, listTemplate} from './templates.ts';

export interface GraphEnv {
  GRAPH_ORIGIN: string;
  GRAPH_DATABASE: string;
  GRAPH_INSTANCE: string;
  GRAPH_READ_AUTH: string;
  DISPLAY_SOURCES?: string;
}
function listItem(
    kind: Listing, row: Obj, root: string, direction: string, type: string,
    now: number): Obj {
  const bad = () => new ReadError('GRAPH_INCOMPLETE', 503);
  if (kind === 'relations') {
    if (!id(row.from) || !id(row.to) ||
        row[direction === 'IN' ? 'to' : 'from'] !== root ||
        !infoTypes.includes(String(row.type)) || typeof row.type !== 'string' ||
        (type && row.type !== type) || !Array.isArray(row.evidence_refs) ||
        !row.evidence_refs.length || !row.evidence_refs.every(id)) {
      throw bad();
    }
    const {edge_id, type: relationType, from, to, evidence_refs} = row;
    return {edge_id, type: relationType, from, to, evidence_refs};
  }
  if (kind === 'system' || kind === 'members') {
    if (row.display_name != null && typeof row.display_name !== 'string') {
      throw bad();
    }
    return row.display_name == null ?
        {entity_id: row.entity_id} :
        {entity_id: row.entity_id, display_name: row.display_name};
  }
  const {
    scenario_id,
    state,
    analysis_ms,
    valid_from_ms,
    valid_to_ms,
    expires_ms,
    orbit_manifest_id,
    model_version,
    purposes
  } = row;
  if (typeof state !== 'string' ||
      !['DRAFT', 'BUILDING', 'VALIDATING', 'READY', 'FAILED'].includes(state) ||
      ![analysis_ms, valid_from_ms, valid_to_ms, expires_ms].every(
          v => v == null || Number.isSafeInteger(v)) ||
      (state === 'READY' &&
       (!id(orbit_manifest_id) || !id(model_version) ||
        !Array.isArray(purposes) || !purposes.length || !purposes.every(id) ||
        (analysis_ms == null &&
         !(typeof valid_from_ms === 'number' &&
           typeof valid_to_ms === 'number' && valid_from_ms < valid_to_ms))))) {
    throw bad();
  }
  return {
    scenario_id,
    state,
    analysis_ms,
    valid_from_ms,
    valid_to_ms,
    expires_ms,
    orbit_manifest_id,
    model_version,
    purposes,
    availability: state !== 'READY' ? 'SCENARIO_NOT_READY' :
        (typeof expires_ms === 'number' && now >= expires_ms) ?
                                      'SCENARIO_EXPIRED' :
                                      'READY'
  };
}

function pathResult(items: Obj[], p: Policy) {
  const bad = () => new ReadError('GRAPH_INCOMPLETE', 503);
  if (!items.length && p.from !== p.to) {
    return {status: 'NO_PATH_OBSERVED'};
  }
  const ids = items[0]?.ids;
  const raw = items[0]?.edges;
  if (items.length !== 1 || !Array.isArray(ids) || !ids.every(id) ||
      ids[0] !== p.from || ids.at(-1) !== p.to ||
      new Set(ids).size !== ids.length ||
      ids.some(n => p.exclude.includes(n)) || !Array.isArray(raw) ||
      raw.length !== ids.length - 1 || raw.length > p.hops) {
    throw bad();
  }
  const seen = new Set<string>();
  const edges = raw.map((e: unknown, i: number) => {
    if (!isObj(e) || !id(e.id) || seen.has(e.id) ||
        p.excludeEdges.includes(e.id) ||
        e.from !== ids[p.direction === 'OUT' ? i : i + 1] ||
        e.to !== ids[p.direction === 'OUT' ? i + 1 : i] ||
        typeof e.evidence_type !== 'string' ||
        !p.evidence.includes(e.evidence_type) || !Array.isArray(e.evidence) ||
        !e.evidence.length || !e.evidence.every(id)) {
      throw bad();
    }
    seen.add(e.id);
    return {
      id: e.id,
      from: e.from,
      to: e.to,
      evidence_type: e.evidence_type,
      evidence: e.evidence
    };
  });
  return {
    status: 'FOUND',
    ordered_node_ids: ids,
    ordered_edge_ids: [...seen],
    nodes: ids.map(entity_id => ({entity_id})),
    edges,
    relay_ids: ids.slice(1, -1),
    evidence_refs: [...new Set(edges.flatMap(e => e.evidence))],
    hop_count: edges.length
  };
}
async function query(
    env: GraphEnv, statement: string, parameters: Obj, abort: AbortSignal,
    send: typeof fetch) {
  if (!validGraphTarget(env.GRAPH_ORIGIN, env.GRAPH_DATABASE) ||
      !id(env.GRAPH_INSTANCE) ||
      !/^Basic [A-Za-z0-9+/]+=*$/.test(env.GRAPH_READ_AUTH)) {
    throw new ReadError('GRAPH_UNAVAILABLE', 503);
  }
  const signal = AbortSignal.any([abort, AbortSignal.timeout(6000)]);
  const incomplete = () => new ReadError('GRAPH_INCOMPLETE', 503);
  try {
    signal.throwIfAborted();
    const res = await send(
        env.GRAPH_ORIGIN + '/db/' + env.GRAPH_DATABASE + '/query/v2', {
          method: 'POST',
          redirect: 'manual',
          signal,
          headers: {
            authorization: env.GRAPH_READ_AUTH,
            'content-type': 'application/json',
            accept: 'application/json'
          },
          body: JSON.stringify({
            statement,
            parameters: {
              ...parameters,
              sources: displaySources(env.DISPLAY_SOURCES),
              instance: env.GRAPH_INSTANCE
            },
            accessMode: 'Read',
            maxExecutionTime: 4
          })
        });
    if (!res.ok) {
      await res.body?.cancel();
      throw new ReadError(
          res.status === 429 ? 'LIMIT_REACHED' : 'GRAPH_UNAVAILABLE',
          res.status === 429 ? 429 : 503);
    }
    const b = await readJson(res, 128 * 1024).catch(() => {
      throw incomplete();
    });
    if (!isObj(b) ||
        (b.errors !== undefined &&
         (!Array.isArray(b.errors) || b.errors.length)) ||
        b.transaction != null || !Array.isArray(b.bookmarks) ||
        !b.bookmarks.length ||
        !b.bookmarks.every(x => typeof x === 'string' && x.length > 0) ||
        (b.queryType !== undefined && b.queryType !== 'r') || !isObj(b.data) ||
        JSON.stringify(b.data.fields) !== '["result"]' ||
        !Array.isArray(b.data.values) || b.data.values.length !== 1) {
      if (isObj(b) && Array.isArray(b.errors) &&
          b.errors.some(
              e => isObj(e) && typeof e.code === 'string' &&
                  /TimedOut|Timeout/.test(e.code))) {
        throw new ReadError('TIMEOUT', 504);
      }
      throw incomplete();
    }
    const row = b.data.values[0];
    if (!Array.isArray(row) || row.length !== 1 || !isObj(row[0]) ||
        !Array.isArray(row[0].items) || !Number.isSafeInteger(row[0].cursor) ||
        Number(row[0].cursor) < 0 || !row[0].items.every(isObj)) {
      throw incomplete();
    }
    return {
      gate: row[0].gate,
      items: row[0].items as Obj[],
      cursor: Number(row[0].cursor)
    };
  } catch (e) {
    if (signal.aborted) {
      throw new ReadError(
          abort.aborted ? 'CANCELLED' : 'TIMEOUT', abort.aborted ? 499 : 504);
    }
    throw e;
  }
}

export async function graphRequest(
    req: Request, env: GraphEnv, send: typeof fetch = fetch) {
  const started = new Date().toISOString();
  const url = new URL(req.url);
  const result = (data: Obj) => Response.json(
      {
        result_id: crypto.randomUUID(),
        query_started_at: started,
        query_finished_at: new Date().toISOString(),
        consistency_level: 'BEST_EFFORT',
        snapshot_guaranteed: false,
        read_failure_protection: 'NONE',
        phase_observed: 'UNKNOWN',
        last_run_status: 'UNKNOWN',
        data_quality: 'UNKNOWN',
        last_complete_success_at: null,
        last_complete_publication_id: null,
        source_sync_summary: null,
        nodes: [],
        edges: [],
        evidence_refs: [],
        warnings: [],
        retention: 'CLIENT_MEMORY_ONLY',
        graph_instance_id: env.GRAPH_INSTANCE,
        ...data
      },
      {headers: {'cache-control': 'no-store'}});
  try {
    const op = url.pathname.slice('/api/v1/analysis/'.length);
    if (url.pathname.startsWith('/api/v1/analysis/') && isAnalysis(op)) {
      if (req.method !== 'POST') {
        throw new ReadError('METHOD_NOT_ALLOWED', 405);
      }
      if (url.search) {
        throw new ReadError('INVALID_QUERY');
      }
      const p = policy(op, await requestObject(req, 8192));
      const r = await query(
          env, analysisTemplate(op, p), {...p, now: Date.now()}, req.signal,
          send);
      const meta = {
        graph_domain: 'TOPOLOGY',
        analysis_time: new Date(p.at).toISOString(),
        scenario_id: p.scenario,
        orbit_manifest_id: p.manifest,
        model_version: p.model,
        context_revision: p.revision,
        processed_cursor: r.cursor,
        execution_engine: 'NEO4J',
        query_template_id: op + '-v1',
        limits: {max_hops: p.hops, max_items: 100},
        query_policy_revision: 1
      };
      if (r.gate !== 'READY') {
        if (typeof r.gate !== 'string' ||
            !['DATA_INSUFFICIENT', 'SCENARIO_NOT_READY', 'SCENARIO_EXPIRED',
              'LIMIT_REACHED']
                 .includes(String(r.gate))) {
          throw new ReadError('GRAPH_INCOMPLETE', 503);
        }
        return result(
            {...meta, status: r.gate, query_execution_complete: false});
      }
      if (op === 'path') {
        const common = {
          ...meta,
          algorithm: 'MIN_HOPS',
          route_semantics: 'TOPOLOGICAL_REACHABILITY',
          relay_validation: 'NOT_VERIFIED',
          query_execution_complete: true
        };
        return result({...common, ...pathResult(r.items, p)});
      }
      if (op === 'degree' &&
          (r.items.length !== 1 ||
           !['edge_count', 'neighbor_count'].every(
               k => Number.isSafeInteger(r.items[0]?.[k]) &&
                   Number(r.items[0]?.[k]) >= 0) ||
           Number(r.items[0]?.neighbor_count) >
               Number(r.items[0]?.edge_count))) {
        throw new ReadError('GRAPH_INCOMPLETE', 503);
      }
      if (op !== 'degree' &&
          (r.items.length > 101 ||
           new Set(r.items.map(x => x.id)).size !== r.items.length ||
           !r.items.every(
               x => id(x.id) && x.id !== p.from && x.id !== p.to &&
                   !p.exclude.includes(x.id) &&
                   (op !== 'neighbors' ||
                    (Number.isSafeInteger(x.hops) && Number(x.hops) > 0 &&
                     Number(x.hops) <= p.hops &&
                     (p.mode !== 'exact' || x.hops === p.hops)))))) {
        throw new ReadError('GRAPH_INCOMPLETE', 503);
      }
      return result({
        ...meta,
        status: r.items.length > 100 ? 'LIMIT_REACHED' : 'OK',
        items: r.items.slice(0, 100).map(
            x => op === 'degree' ?
                {edge_count: x.edge_count, neighbor_count: x.neighbor_count} :
                op === 'neighbors' ? {id: x.id, hops: x.hops} :
                                     {id: x.id}),
        query_execution_complete: r.items.length <= 100
      });
    }
    const path = url.pathname.split('/');
    let kind: Listing;
    let root = '';
    if (path.slice(0, 3).join('/') !== '/api/v1') {
      throw new ReadError('NOT_FOUND', 404);
    }
    if (path[3] === 'scenarios' && (path.length === 4 || path.length === 5)) {
      kind = path.length === 4 ? 'scenarios' : 'scenario';
      root = decodeURIComponent(path[4] ?? '');
    } else if (
        path[3] === 'systems' &&
        (path.length === 5 || path.length === 6 && path[5] === 'members')) {
      kind = path.length === 5 ? 'system' : 'members';
      root = decodeURIComponent(path[4]!);
    } else if (url.pathname === '/api/v1/graph/relations') {
      kind = 'relations';
      root = url.searchParams.get('root') ?? '';
    } else {
      throw new ReadError('NOT_FOUND', 404);
    }
    if (req.method !== 'GET') {
      throw new ReadError('METHOD_NOT_ALLOWED', 405);
    }
    const params = Object.fromEntries(url.searchParams);
    const single = ['scenario', 'system'].includes(kind);
    keys(
        params,
        single ?
            [] :
            kind === 'relations' ?
            ['root', 'direction', 'type', 'analysis_time', 'after', 'limit'] :
            kind === 'members' ? ['after', 'limit', 'analysis_time'] :
                                 ['after', 'limit']);
    if ([...url.searchParams.keys()].some(
            k => url.searchParams.getAll(k).length !== 1)) {
      throw new ReadError('INVALID_QUERY');
    }
    const limit = Number(params.limit ?? 25);
    const after = params.after ?? '';
    const type = params.type ?? '';
    const direction = params.direction ?? 'OUT';
    const at = params.analysis_time === undefined ?
        null :
        utcMillis(params.analysis_time);
    if (params.limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(params.limit)) {
      throw new ReadError('INVALID_QUERY');
    }
    if (kind !== 'scenarios' && !id(root) || after !== '' && !id(after) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        type && !infoTypes.includes(type) ||
        !['IN', 'OUT'].includes(direction) ||
        at !== null && !Number.isFinite(at)) {
      throw new ReadError('INVALID_QUERY');
    }
    const r = await query(
        env, listTemplate(kind, direction === 'IN'),
        {root, after, type, at, take: limit + 1}, req.signal, send);
    if (single && !r.items.length) {
      throw new ReadError('NOT_FOUND', 404);
    }
    const field = kind === 'relations'              ? 'edge_id' :
        kind === 'scenario' || kind === 'scenarios' ? 'scenario_id' :
                                                      'entity_id';
    if (r.items.length > limit + 1 ||
        !r.items.every(
            (x, i) => id(x[field]) &&
                (single ? x[field] === root :
                          String(x[field]) >
                         (i ? String(r.items[i - 1]![field]) : after))) ||
        single && r.items.length !== 1) {
      throw new ReadError('GRAPH_INCOMPLETE', 503);
    }
    const items = r.items.map(
        row => listItem(kind, row, root, direction, type, Date.parse(started)));
    return result({
      graph_domain: kind.startsWith('scenario') ? 'TOPOLOGY' : 'INFORMATION',
      status: 'OK',
      processed_cursor: r.cursor,
      items: items.slice(0, limit),
      next_cursor: r.items.length > limit ? r.items[limit - 1]![field] : null,
      query_execution_complete: true
    });
  } catch (e) {
    return failure(
        e instanceof URIError ? new ReadError('INVALID_QUERY') : e,
        'GRAPH_UNAVAILABLE');
  }
}
