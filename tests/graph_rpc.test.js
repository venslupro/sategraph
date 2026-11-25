import {Miniflare} from 'miniflare';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

import {issueCookie} from '../src/sg-api-gateway/session.ts';

const root = new URL('../src/', import.meta.url);
const config = async role =>
    JSON.parse(await readFile(new URL(role + '/wrangler.jsonc', root), 'utf8'));
async function modules(paths) {
  return Promise.all(paths.map(
      async path => ({
        type: 'ESModule',
        path,
        contents:
            ts.transpileModule(await readFile(new URL(path, root), 'utf8'), {
                compilerOptions: {
                  module: ts.ModuleKind.ESNext,
                  target: ts.ScriptTarget.ES2022
                }
              }).outputText
      })));
}

test(
    '临时 workerd：鉴权 API 网关 经真实命名绑定读取图，图默认入口不可用',
    async t => {
      const [gateway, graph] =
          await Promise.all(['sg-api-gateway', 'sg-graph'].map(config));
      const binding = gateway.services.find(b => b.binding === 'GRAPH');
      const host = 'sg.example.test';
      const keys = JSON.stringify({
        current: {id: 'test', secret: Buffer.alloc(32, 2).toString('base64url')}
      });
      let calls = 0, redirect = false;
      const mf = new Miniflare({
        cf: false,
        workers: [
          {
            name: gateway.name,
            compatibilityDate: gateway.compatibility_date,
            modules: await modules([
              'sg-api-gateway/index.ts', 'sg-api-gateway/session.ts',
              'sg-api-gateway/read_contract.ts'
            ]),
            bindings: {PUBLIC_HOSTNAME: host, SESSION_KEYS: keys},
            serviceBindings:
                {GRAPH: {name: binding.service, entrypoint: binding.entrypoint}}
          },
          {
            name: graph.name,
            compatibilityDate: graph.compatibility_date,
            modules: await modules([
              'sg-graph/index.ts', 'sg-graph/query.ts', 'sg-graph/policy.ts',
              'sg-graph/templates.ts', 'sg-data/policy.ts',
              'sg-api-gateway/read_contract.ts', 'sg-projector/target.ts'
            ]),
            bindings: {
              GRAPH_ORIGIN: 'https://fixture.databases.neo4j.io',
              GRAPH_READ_AUTH: 'Basic dGVzdA==',
              GRAPH_INSTANCE: 'test',
              GRAPH_DATABASE: 'neo4j',
              ...graph.vars
            },
            outboundService: async req => {
              calls++;
              assert.equal(
                  req.url,
                  'https://fixture.databases.neo4j.io/db/neo4j/query/v2');
              if (redirect)
                return new Response(null, {
                  status: 307,
                  headers: {location: 'https://refused.example.test/'}
                });
              assert.equal(req.headers.get('cookie'), null);
              assert.equal(req.headers.get('authorization'), 'Basic dGVzdA==');
              const input = await req.json();
              assert.equal(input.accessMode, 'Read');
              assert.deepEqual(input.parameters.sources, []);
              return Response.json({
                bookmarks: ['local'],
                data: {
                  fields: ['result'],
                  values: [[{gate: 'DATA_INSUFFICIENT', items: [], cursor: 0}]]
                }
              });
            }
          },
        ]
      });
      t.after(() => mf.dispose());
      const disabled = await mf.getWorker(graph.name);
      const url = 'https://' + host + '/api/v1/analysis/path';
      const send = (cookie) => mf.dispatchFetch(url, {
        method: 'POST',
        headers: {
          origin: 'https://' + host,
          cookie,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          from: 'T-A',
          to: 'T-B',
          scenario_id: 'F1',
          purpose: 'research',
          orbit_manifest_id: 'F1-data',
          model_version: 'v1',
          analysis_time: '2026-01-01T00:00:00Z'
        })
      });
      assert.equal((await disabled.fetch(url)).status, 404);
      const denied = await send('');
      assert.equal(denied.status, 401, await denied.text());
      assert.equal(calls, 0);
      const res = await send((await issueCookie(keys, host)).split(';')[0]);
      const result = await res.json();
      assert.equal(
          result.status, 'DATA_INSUFFICIENT', '已发出模拟图请求数：' + calls);
      assert.equal(result.query_execution_complete, false);
      assert.equal(calls, 1);
      redirect = true;
      const stopped = await send((await issueCookie(keys, host)).split(';')[0]);
      assert.equal(stopped.status, 503);
      assert.equal((await stopped.json()).status, 'GRAPH_UNAVAILABLE');
      assert.equal(calls, 2);
    });
