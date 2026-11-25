import assert from 'node:assert/strict';
import test from 'node:test';

import {policy} from '../src/sg-graph/policy.ts';
import {analysisTemplate, listTemplate} from '../src/sg-graph/templates.ts';

// 仅独立的本机空测试库；所有夹具写入同一未提交事务，永不调用 commit。
const enabled = process.env.SATEGRAPH_F1_LOCAL === '1';
test(
    '隔离 Neo4j：在真实查询引擎执行 F1 与短路径干扰反例', {
      skip: enabled ? false : '未显式启用本机空 Neo4j 测试实例',
    },
    async () => {
      const port = process.env.SATEGRAPH_F1_PORT ?? '7474';
      assert.match(port, /^[1-9][0-9]{0,4}$/);
      assert.ok(Number(port) <= 65535);
      const endpoint = 'http://127.0.0.1:' + port + '/db/neo4j/query/v2/tx';
      const headers = {'content-type': 'application/json'};
      if (process.env.SATEGRAPH_F1_AUTH)
        headers.authorization = process.env.SATEGRAPH_F1_AUTH;
      const send = async (url, body, method = 'POST') => {
        const res = await fetch(url, {
          method,
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
          body: body === undefined ? undefined : JSON.stringify(body)
        });
        assert.ok(res.ok, '本机 Query API 返回 ' + res.status);
        if (method === 'DELETE') return;
        const b = await res.json();
        assert.deepEqual(b.errors ?? [], []);
        return b;
      };
      const opened = await send(endpoint, {
        statement: 'MATCH (n) RETURN count(n) AS count',
        maxExecutionTime: 60
      });
      const tx = opened.transaction?.id;
      assert.match(tx, /^[a-zA-Z0-9_-]+$/);
      const url = endpoint + '/' + tx;
      const query = async (statement, parameters = {}) =>
          (await send(url, {statement, parameters})).data.values;
      const from = 'T-A', to = 'T-B',
            scope = ['T-A', 'T-B', 'T-C', 'T-D', 'T-E'];
      const input = {
        from,
        to,
        scenario_id: 'F1',
        purpose: 'research',
        orbit_manifest_id: 'F1-input',
        model_version: 'v1',
        analysis_time: '2026-01-01T00:00:00Z'
      };
      const at = Date.parse(input.analysis_time), instance = 'F1-only',
            sources = ['fixture'];
      async function run(op, overrides = {}) {
        const data = {...input, ...overrides};
        if (op === 'neighbors' || op === 'degree') delete data.to;
        const p = policy(op, data);
        const [[r]] = await query(
            analysisTemplate(op, p), {...p, instance, sources, now: at});
        return r;
      }
      try {
        assert.deepEqual(opened.data.values, [[0]], '非空库不得装载测试数据');
        await query(
            'CREATE (:GraphControl {key:\'orbit\',instance_id:$instance,cursor:9}) CREATE (:TopologyScenario {scenario_id:\'F1\',state:\'READY\',edge_count:5,coverage_complete:true,analysis_ms:$at,scope_ids:$scope,source_ids:$sources,purposes:[\'research\'],orbit_manifest_id:\'F1-input\',model_version:\'v1\'})',
            {instance, sources, at, scope});
        await query(
            'UNWIND $scope AS id CREATE (:Entity {entity_id:id,source_ids:$sources})',
            {scope, sources});
        await query(
            'CREATE (s:Entity:System {entity_id:\'SYS-X\',source_ids:$sources}) WITH s UNWIND [\'T-A\',\'T-B\'] AS id MATCH (n:Entity {entity_id:id}) CREATE (n)-[:MEMBER_OF {edge_id:id,source_ids:$sources,evidence_refs:[\'E-system\']}]->(s)',
            {sources});
        const props = {
          scenario_id: 'F1',
          analysis_ms: at,
          purpose: 'research',
          model_version: 'v1',
          input_manifest_id: 'F1-input',
          source_ids: sources,
          evidence_type: 'DECLARED',
          evidence_refs: ['E-fixture']
        };
        const makeEdges = (rows) => query(
            'UNWIND $rows AS row MATCH (a:Entity {entity_id:row.a}), (b:Entity {entity_id:row.b}) CREATE (a)-[r:COMM_LINK]->(b) SET r=row.props',
            {rows});
        const row = (a, b, id, extra = {}) =>
            ({a, b, props: {...props, edge_id: id, ...extra}});
        await makeEdges([
          row(from, 'T-C', 'ac'), row('T-C', 'T-D', 'cd'), row('T-D', to, 'db'),
          row(from, 'T-E', 'ae'), row('T-E', to, 'eb')
        ]);
        const path = async (args = {}) => {
          const r = await run('path', args);
          assert.equal(r.gate, 'READY');
          return r.items.map(item => item.ids);
        };
        assert.deepEqual(await path(), [[from, 'T-E', to]]);
        assert.deepEqual(
            await path({exclude_nodes: ['T-E']}), [[from, 'T-C', 'T-D', to]]);
        assert.deepEqual(
            await path({exclude_edges: ['eb']}), [[from, 'T-C', 'T-D', to]]);
        assert.deepEqual(await path({from: to, to: from}), []);
        assert.deepEqual(
            await path({from: to, to: from, direction: 'IN'}),
            [[to, 'T-E', from]]);
        assert.deepEqual(await path({to: from}), [[from]]);
        assert.deepEqual(await path({to: 'T-E'}), [[from, 'T-E']]);
        assert.deepEqual(await path({max_hops: 1}), []);
        assert.deepEqual(
            (await run('neighbors', {max_hops: 2})).items.map(x => x.id).sort(),
            ['T-B', 'T-C', 'T-D', 'T-E']);
        assert.deepEqual(
            (await run('neighbors', {max_hops: 2, mode: 'exact'}))
                .items.map(x => x.id)
                .sort(),
            ['T-B', 'T-D']);
        assert.deepEqual(
            (await run('common-neighbors', {from: 'T-C', to: 'T-E'})).items,
            []);
        assert.deepEqual(
            (await run('degree')).items, [{edge_count: 2, neighbor_count: 2}]);
        const [[members]] = await query(listTemplate('members', false), {
          instance,
          sources,
          root: 'SYS-X',
          type: '',
          at: null,
          after: '',
          take: 3
        });
        assert.deepEqual(members.items.map(x => x.entity_id), [from, to]);
        await makeEdges([
          row(from, to, 'wrong-time', {analysis_ms: at - 1}),
          row(from, to, 'wrong-purpose', {purpose: 'other'}),
          row(from, to, 'wrong-model', {model_version: 'other'}),
          row(from, to, 'wrong-input', {input_manifest_id: 'other'}),
          row(from, to, 'modeled', {evidence_type: 'MODELED'})
        ]);
        await query('MATCH (s:TopologyScenario) SET s.edge_count=10');
        assert.deepEqual(
            await path({evidence_types: ['DECLARED']}), [[from, 'T-E', to]]);
        await query('MATCH (s:TopologyScenario) SET s.state=\'BUILDING\'');
        assert.equal(
            (await run('path', {to: from})).gate, 'SCENARIO_NOT_READY');
        await query(
            'MATCH (s:TopologyScenario) SET s.state=\'READY\',s.edge_count=11');
        assert.equal((await run('path')).gate, 'DATA_INSUFFICIENT');
      } finally {
        await send(url, undefined, 'DELETE');
      }
    });
