import assert from 'node:assert/strict';
import test from 'node:test';

import {handle} from '../src/sg-api-gateway/index.ts';
import {issueCookie} from '../src/sg-api-gateway/session.ts';
import {graphRequest} from '../src/sg-graph/query.ts';
import {makeChunk} from '../src/sg-projector/chunk.ts';
import {graphPort} from '../src/sg-projector/graph.ts';
import {orbitPayload} from '../src/sg-sync/storage/orbit_store.ts';

const origin = 'https://sg.example.test';
const env = {
  GRAPH_ORIGIN: 'https://fixture.databases.neo4j.io',
  GRAPH_DATABASE: 'neo4j',
  GRAPH_INSTANCE: 'isolated',
  GRAPH_READ_AUTH: 'Basic dGVzdA==',
  DISPLAY_SOURCES: 'fixture'
};
const input = {
  from: 'T-A',
  to: 'T-B',
  scenario_id: 'F1',
  purpose: 'research',
  analysis_time: '2026-01-01T00:00:00Z',
  orbit_manifest_id: 'F1-input',
  model_version: 'v1',
  context_revision: 7
};
const edge = (from, to) => ({
  id: from + ':' + to,
  from,
  to,
  evidence_type: 'DECLARED',
  evidence: ['evidence-1']
});
const good = {
  gate: 'READY',
  cursor: 9,
  items: [{
    ids: ['T-A', 'T-E', 'T-B'],
    edges: [edge('T-A', 'T-E'), edge('T-E', 'T-B')]
  }]
};
const wrap = result => ({
  data: {fields: ['result'], values: [[result]]},
  bookmarks: ['fixture-bookmark'],
  queryType: 'r'
});
const post = (body = input, op = 'path', init = {}) =>
    new Request(origin + '/api/v1/analysis/' + op, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
      ...init
    });
const reply = body => async () => Response.json(body, {status: 202});

test('读参数、来源和凭据分离；只从完整有向边构造路径结果', async () => {
  let count = 0;
  const res = await graphRequest(post(), env, async (url, init) => {
    count++;
    assert.equal(url, env.GRAPH_ORIGIN + '/db/neo4j/query/v2');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.authorization, env.GRAPH_READ_AUTH);
    const q = JSON.parse(init.body);
    assert.deepEqual(q.parameters.sources, ['fixture']);
    assert.deepEqual(
        [
          q.parameters.instance, q.parameters.hops, q.accessMode,
          q.maxExecutionTime
        ],
        ['isolated', 12, 'Read', 4]);
    return Response.json(wrap(good));
  });
  assert.equal(count, 1);
  const result = await res.json();
  assert.deepEqual(
      [
        result.status, result.hop_count, result.relay_ids,
        result.context_revision
      ],
      ['FOUND', 2, ['T-E'], 7]);
  assert.deepEqual(result.ordered_edge_ids, good.items[0].edges.map(e => e.id));
  assert.deepEqual(result.evidence_refs, ['evidence-1']);
  assert.equal(result.snapshot_guaranteed, false);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test(
    '零跳、反向与排除均复核；只对完整的非同点空结果报告未观察到路径',
    async () => {
      const run = async (args, items) =>
          (await graphRequest(
               post({...input, ...args}), env, reply(wrap({...good, items}))))
              .json();
      assert.equal((await run({}, [])).status, 'NO_PATH_OBSERVED');
      assert.equal((await run({to: 'T-A'}, [])).status, 'GRAPH_INCOMPLETE');
      assert.equal(
          (await run({to: 'T-A'}, [{ids: ['T-A'], edges: []}])).hop_count, 0);
      assert.equal(
          (await run({direction: 'IN'}, good.items)).status,
          'GRAPH_INCOMPLETE');
      assert.equal(
          (await run({direction: 'IN', from: 'T-B', to: 'T-A'}, [{
                       ids: ['T-B', 'T-E', 'T-A'],
                       edges: [...good.items[0].edges].reverse()
                     }]))
              .status,
          'FOUND');
      for (const args
               of [{exclude_nodes: ['T-E']}, {exclude_edges: ['T-A:T-E']},
                   {max_hops: 1}, {evidence_types: ['MODELED']}])
        assert.equal((await run(args, good.items)).status, 'GRAPH_INCOMPLETE');
      const direct = edge('T-A', 'T-B');
      for (const broken
               of [{...direct, to: 'T-X'}, {...direct, evidence: []},
                   {...direct, id: ''}])
        assert.equal(
            (await run({}, [{ids: ['T-A', 'T-B'], edges: [broken]}])).status,
            'GRAPH_INCOMPLETE');
    });

test('不完整图响应、超时、数据不足与场景状态不能变成无路径', async () => {
  for (const gate
           of ['DATA_INSUFFICIENT', 'SCENARIO_NOT_READY', 'SCENARIO_EXPIRED',
               'LIMIT_REACHED']) {
    const b = await (await graphRequest(
                         post(), env, reply(wrap({...good, gate, items: []}))))
                  .json();
    assert.deepEqual([b.status, b.query_execution_complete], [gate, false]);
  }
  for (const [delta, status] of [
           [
             {
               errors:
                   [{code: 'Neo.ClientError.Transaction.TransactionTimedOut'}]
             },
             'TIMEOUT'
           ],
           [{bookmarks: []}, 'GRAPH_INCOMPLETE'],
           [{transaction: {id: 'open'}}, 'GRAPH_INCOMPLETE'],
           [{data: {fields: ['result'], values: []}}, 'GRAPH_INCOMPLETE'],
           [{queryType: 'rw'}, 'GRAPH_INCOMPLETE']]) {
    const b = await (await graphRequest(
                         post(), env, reply({...wrap(good), ...delta})))
                  .json();
    assert.deepEqual([b.status, b.query_execution_complete], [status, false]);
  }
});

test('歧义枚举、日期、任意语句与超限跳数在发送查询前拒绝', async () => {
  let n = 0;
  const none = async () => {
    n++;
    throw Error('不应调用');
  };
  for (const args
           of [{direction: ['IN']}, {cypher: '自由文本'},
               {analysis_time: '2026-02-30T12:00:00Z'}, {max_hops: 13},
               {max_hops: '2'}, {exclude_nodes: ['T-A']}, {evidence_types: []}])
    assert.equal(
        (await graphRequest(post({...input, ...args}), env, none)).status, 422);
  for (const path
           of ['/api/v1/scenarios?limit=1e1',
               '/api/v1/graph/relations?root=T-A&analysis_time=tomorrow',
               '/api/v1/scenarios?limit=1&limit=2'])
    assert.equal(
        (await graphRequest(new Request(origin + path), env, none)).status,
        422);
  assert.equal(n, 0);
});

test('目录来源默认为空；成员 keyset 仅在确有下一条时前移', async () => {
  const u = origin + '/api/v1/systems/SYS-X/members?limit=1';
  const b = await (await graphRequest(
                       new Request(u), {...env, DISPLAY_SOURCES: ''},
                       async (_, init) => {
                         const p = JSON.parse(init.body).parameters;
                         assert.deepEqual(p.sources, []);
                         assert.equal(p.take, 2);
                         return Response.json(wrap({cursor: 3, items: []}));
                       }))
                .json();
  assert.deepEqual([b.items, b.next_cursor], [[], null]);
  const page = await (await graphRequest(
                          new Request(u), env, reply(wrap({
                            cursor: 3,
                            items: [{entity_id: 'T-A'}, {entity_id: 'T-B'}]
                          }))))
                   .json();
  assert.deepEqual(page.items, [{entity_id: 'T-A'}]);
  assert.equal(page.next_cursor, 'T-A');
});

test('场景列出实际状态，信息关系必须有匹配端点、类型与证据', async () => {
  const list = async (path, items) =>
      (await graphRequest(
           new Request(origin + '/api/v1/' + path), env,
           reply(wrap({cursor: 1, items}))))
          .json();
  const scene = {
    scenario_id: 'F1',
    state: 'READY',
    analysis_ms: 0,
    model_version: 'v1',
    orbit_manifest_id: 'input',
    purposes: ['research'],
    expires_ms: 1
  };
  assert.equal(
      (await list('scenarios/F1', [scene])).items[0].availability,
      'SCENARIO_EXPIRED');
  assert.equal(
      (await list('scenarios', [{scenario_id: 'F1', state: 'BUILDING'}]))
          .items[0]
          .availability,
      'SCENARIO_NOT_READY');
  assert.equal(
      (await list('scenarios/F1', [{...scene, model_version: null}])).status,
      'GRAPH_INCOMPLETE');
  assert.equal(
      (await list('scenarios/F1', [{...scene, scenario_id: 'other'}])).status,
      'GRAPH_INCOMPLETE');
  const path = 'graph/relations?root=T-A&type=MEMBER_OF';
  const relation = {
    edge_id: 'm-a',
    type: 'MEMBER_OF',
    from: 'T-A',
    to: 'SYS-X',
    evidence_refs: ['E-A']
  };
  assert.deepEqual(
      (await list(path, [{...relation, internal_payload: 'hidden'}])).items,
      [relation]);
  for (const changes
           of [{type: 'COMM_LINK'}, {from: 'T-B'}, {evidence_refs: []}])
    assert.equal(
        (await list(path, [{...relation, ...changes}])).status,
        'GRAPH_INCOMPLETE');
});

test('邻居、交集与度数拒绝截断或不符合约束的集合', async () => {
  const run = async (op, args, items) => {
    const body = {...input, ...args};
    if (op !== 'common-neighbors') delete body.to;
    return (await graphRequest(
                post(body, op), env, reply(wrap({...good, items}))))
        .json();
  };
  assert.equal(
      (await run(
           'neighbors', {max_hops: 2, mode: 'exact'}, [{id: 'T-C', hops: 1}]))
          .status,
      'GRAPH_INCOMPLETE');
  assert.equal(
      (await run('degree', {}, [{edge_count: 1, neighbor_count: 2}])).status,
      'GRAPH_INCOMPLETE');
  assert.deepEqual(
      (await run('degree', {}, [{edge_count: 3, neighbor_count: 1}])).items,
      [{edge_count: 3, neighbor_count: 1}]);
  assert.equal(
      (await run('common-neighbors', {}, [{id: 'n'}, {id: 'n'}])).status,
      'GRAPH_INCOMPLETE');
  const limited = await run(
      'neighbors', {},
      Array.from({length: 101}, (_, i) => ({id: 'N' + i, hops: 1})));
  assert.deepEqual(
      [limited.status, limited.items.length, limited.query_execution_complete],
      ['LIMIT_REACHED', 100, false]);
});

test('轨道命令到图写参数保留来源和证据；不从轨道推导通信边', async () => {
  const {payload, hash} = await orbitPayload({
    entityId: 'T-A',
    sourceId: 'fixture',
    evidenceId: 'E-A',
    objectId: 'O-A',
    epochUs: 1,
    format: 'OMM',
    frame: 'TEME'
  });
  const chunk = await makeChunk('isolated', {cursor: 0, hash: ''}, [{
                                  entity_id: 'T-A',
                                  event_seq: 1,
                                  operation_id: 'op',
                                  revision: 1,
                                  payload,
                                  payload_hash: hash
                                }]);
  let sent = 0;
  const port = graphPort(
      env.GRAPH_ORIGIN, 'neo4j', env.GRAPH_READ_AUTH, 'isolated',
      async (_, init) => {
        sent++;
        const {statement, parameters: p} = JSON.parse(init.body);
        assert.equal(p.rows[0].source_id, 'fixture');
        assert.equal(p.rows[0].evidence_id, 'E-A');
        assert.match(statement, /n.source_ids = CASE/);
        assert.doesNotMatch(statement, /COMM_LINK|TopologyScenario/);
        return Response.json({
          bookmarks: ['b'],
          data: {
            fields: ['instance', 'runId', 'epoch', 'cursor', 'hash'],
            values: [['isolated', 'run', 1, 1, chunk.end.hash]]
          }
        });
      });
  await port.apply({runId: 'run', epoch: 1}, chunk);
  assert.equal(sent, 1);
});

test('网关先验证同源与会话，转发分析时剥离凭据和内部响应头', async () => {
  const keys = JSON.stringify({
    current: {id: 'test', secret: Buffer.alloc(32, 2).toString('base64url')}
  });
  const hostname = new URL(origin).hostname;
  const cookie = (await issueCookie(keys, hostname)).split(';')[0];
  let n = 0;
  const gateway = {
    PUBLIC_HOSTNAME: hostname,
    SESSION_KEYS: keys,
    GRAPH: {
      async fetch(r) {
        n++;
        assert.deepEqual([...r.headers.keys()], ['content-type']);
        assert.deepEqual(await r.json(), input);
        return Response.json(
            {status: 'DATA_INSUFFICIENT'},
            {headers: {'set-cookie': 'hidden=1'}});
      }
    }
  };
  const req = (headers) => post(
      input, 'path',
      {headers: {'content-type': 'application/json', origin, ...headers}});
  assert.equal((await handle(req({}), gateway)).status, 401);
  assert.equal(
      (await handle(req({cookie, origin: origin + '/other'}), gateway)).status,
      403);
  const res = await handle(req({cookie, authorization: 'private'}), gateway);
  assert.equal(n, 1);
  assert.equal(res.status, 200);
  assert.equal(res.headers.has('set-cookie'), false);
});
