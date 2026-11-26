import {id, isObj, keys, type Obj, ReadError, readJson} from '../sg-api-gateway/read_contract.ts';
import {isAnalysis, policy} from '../sg-graph/policy.ts';

export interface Readers {
  DATA: Fetcher;
  GRAPH: Fetcher;
}
const lookups: Record<string, [keyof Readers, string]> = {
  get_entity: ['DATA', 'satellites'],
  get_evidence: ['DATA', 'evidence'],
  get_system: ['GRAPH', 'systems'],
  get_scenario: ['GRAPH', 'scenarios'],
};
export const toolGuide =
    'search_catalog(q), catalog_statistics(), get_entity(id), get_evidence(id), get_system(id), list_system_members(id), information_relations(id), list_scenarios(), get_scenario(id), find_path, neighbors, common_neighbors, degree。分析参数与手动分析一致：from、按需 to、scenario_id、analysis_time（UTC）、purpose、orbit_manifest_id、model_version，及可选 direction、evidence_types、exclude_nodes、exclude_edges、max_hops、mode。不得自行设定缺失场景。';

export async function readTool(
    env: Readers, base: string, name: string, args: Obj, revision: number,
    signal: AbortSignal, context: Obj) {
  let unit: keyof Readers = 'DATA';
  let route: string;
  let body: string|undefined;
  const params = new URLSearchParams();
  const op = name === 'find_path' ? 'path' :
      name === 'common_neighbors' ? 'common-neighbors' :
                                    name;
  if (isAnalysis(op) && name !== 'path' && name !== 'common-neighbors') {
    if ('context_revision' in args) {
      throw new ReadError('UNSUPPORTED_CONSTRAINT');
    }
    // 关键分析条件取自用户确认的工作台，不能让模型补造或替换。
    for (const key
             of ['from',
                 ...(op === 'path' || op === 'common-neighbors' ? ['to'] : []),
                 'scenario_id', 'analysis_time', 'purpose', 'orbit_manifest_id',
                 'model_version']) {
      if (!id(context[key]) || (key in args && args[key] !== context[key])) {
        throw new ReadError('CONDITIONS_REQUIRED');
      }
      args = {...args, [key]: context[key]};
    }
    const input = {...args, context_revision: revision};
    policy(op, input);
    unit = 'GRAPH';
    route = 'analysis/' + op;
    body = JSON.stringify(input);
  } else if (Object.hasOwn(lookups, name)) {
    keys(args, ['id']);
    if (!id(args.id)) {
      throw new ReadError('INVALID_QUERY');
    }
    const target = lookups[name]!;
    unit = target[0];
    route = target[1] + '/' + encodeURIComponent(args.id);
  } else if (name === 'search_catalog') {
    keys(args, ['q']);
    if (typeof args.q !== 'string' || args.q.length > 128) {
      throw new ReadError('INVALID_QUERY');
    }
    route = 'catalog/search';
    params.set('q', args.q);
    params.set('limit', '10');
  } else if (name === 'catalog_statistics' || name === 'list_scenarios') {
    keys(args, []);
    unit = name === 'list_scenarios' ? 'GRAPH' : 'DATA';
    route = unit === 'GRAPH' ? 'scenarios' : 'catalog/statistics';
    if (unit === 'GRAPH') {
      params.set('limit', '10');
    }
  } else if (
      name === 'list_system_members' || name === 'information_relations') {
    keys(args, ['id']);
    if (!id(args.id)) {
      throw new ReadError('INVALID_QUERY');
    }
    unit = 'GRAPH';
    params.set('limit', '10');
    route = name === 'list_system_members' ?
        'systems/' + encodeURIComponent(args.id) + '/members' :
        'graph/relations';
    if (name === 'information_relations') {
      params.set('root', args.id);
    }
  } else {
    throw new ReadError('TOOL_NOT_ALLOWED');
  }
  const url = new URL('/api/v1/' + route, base);
  url.search = params.toString();
  signal.throwIfAborted();
  const res = await env[unit].fetch(new Request(url.toString(), {
    method: body ? 'POST' : 'GET',
    redirect: 'manual',
    headers: body ? {'content-type': 'application/json'} : {},
    body,
    signal
  }));
  if (!res.ok) {
    await res.body?.cancel();
    throw new ReadError(
        res.status === 429     ? 'QUOTA_EXCEEDED' :
            res.status === 404 ? 'NOT_FOUND' :
                                 'TOOL_UNAVAILABLE',
        res.status === 404     ? 404 :
            res.status === 429 ? 429 :
                                 503);
  }
  const data = await readJson(res, 16384);
  if (!isObj(data) || name === 'get_entity' && data.entity_id !== args.id ||
      body && data.context_revision !== revision) {
    throw new ReadError('TOOL_INCOMPLETE', 503);
  }
  return data;
}
