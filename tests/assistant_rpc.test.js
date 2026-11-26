import {Miniflare} from 'miniflare';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

import {renderConfigs} from '../scripts/worker_configs.js';
import {issueCookie} from '../src/sg-api-gateway/session.ts';
import {MODEL} from '../src/sg-assistant/assistant.ts';
import {workspace} from '../src/sg-pages/online_workspace.ts';

const root = new URL('../src/', import.meta.url);
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
const links = (unit, selected) => Object.fromEntries(
    unit.services.filter(s => selected.includes(s.binding))
        .map(s => [s.binding, {name: s.service, entrypoint: s.entrypoint}]));

test(
    '临时 workerd：Pages 经鉴权进入命名助手，由目录读取临时 D1；不访问外部模型',
    async t => {
      const host = 'sg.example.test';
      const origin = 'https://' + host;
      const {'api-gateway': gateway, assistant, data} = await renderConfigs(
          {
            environment: 'prd',
            account_id: 'a'.repeat(32),
            public_hostname: host,
            turnstile_site_key: 'fixture',
            d1_database_id: '11111111-2222-3333-4444-555555555555',
            d1_database_name: 'sategraph-prd-core',
            existing_services: {
              b2_bucket_id: 'b'.repeat(24),
              neo4j_origin: 'https://fixture.databases.neo4j.io',
              neo4j_database: 'neo4j'
            }
          },
          'dist/config/prd', 'isolated');
      const keys = JSON.stringify({
        current: {id: 'test', secret: Buffer.alloc(32, 4).toString('base64url')}
      });
      const modelName = 'test-only-planner';
      const opts = {
        compatibilityDate: gateway.compatibility_date,
        outboundService: () => new Response(null, {status: 503})
      };
      const mf = new Miniflare({
        cf: false,
        d1Persist: false,
        durableObjectsPersist: false,
        workers: [
          {
            ...opts,
            name: gateway.name,
            modules: await modules([
              'sg-api-gateway/index.ts', 'sg-api-gateway/session.ts',
              'sg-api-gateway/read_contract.ts'
            ]),
            bindings: {PUBLIC_HOSTNAME: host, SESSION_KEYS: keys},
            serviceBindings: links(gateway, ['ASSISTANT', 'DATA'])
          },
          {
            ...opts,
            name: assistant.name,
            modules: await modules([
              'sg-assistant/index.ts', 'sg-assistant/assistant.ts',
              'sg-assistant/tools.ts', 'sg-graph/policy.ts',
              'sg-api-gateway/read_contract.ts'
            ]),
            bindings: {APPROVED_MODEL: MODEL},
            serviceBindings: {
              ...links(assistant, ['DATA']),
              AI: {name: modelName, entrypoint: 'TestModel'}
            }
          },
          {...opts, name: modelName, modules: true, script: ENUMERATED_MODEL}, {
            ...opts,
            name: data.name,
            modules: await modules([
              'sg-data/index.ts', 'sg-data/catalog.ts', 'sg-data/policy.ts',
              'sg-sync/gp_ingest.ts', 'sg-sync/gp_chunks.ts',
              'sg-sync/archive_step.ts', 'sg-sync/source_snapshot.ts',
              'sg-sync/storage/orbit_store.ts'
            ]),
            d1Databases: ['CORE'],
            bindings: data.vars,
            durableObjects:
                {COMMAND: {className: 'FactCommand', useSQLite: true}}
          }
        ]
      });
      t.after(() => mf.dispose());
      const db = await mf.getD1Database('CORE', data.name);
      const dir = new URL('sg-sync/storage/migrations/', root);
      for (const file of (await readdir(dir))
               .filter(f => f.endsWith('.sql'))
               .sort()) {
        const sql = await readFile(new URL(file, dir), 'utf8');
        await db.batch(sql.split(';')
                           .map(s => s.trim())
                           .filter(Boolean)
                           .map(s => db.prepare(s)));
      }
      const url = origin + '/api/v1/assistant/query';
      const headers = {origin, 'content-type': 'application/json'};
      const body = JSON.stringify({message: '目录统计', context_revision: 0});
      const direct = await (await mf.getWorker(assistant.name)).fetch(url);
      assert.equal(direct.status, 404, await direct.text());
      assert.equal(
          (await mf.dispatchFetch(url, {method: 'POST', headers, body})).status,
          401);
      const cookie = (await issueCookie(keys, host)).split(';')[0];
      let state;
      const ws = workspace({
        fields: () => ({context: {}, q: '', id: ''}),
        render: s => state = s,
        send: (path, init) => mf.dispatchFetch(
            origin + path,
            {...init, headers: {...init.headers, cookie, origin}})
      });
      await ws.ask('查询目录统计');
      assert.equal(state.status, 'COMPLETED', state.status);
      assert.equal(state.records[0].tool, 'catalog_statistics');
      assert.equal(state.records[0].data.objects_with_orbit, 0);
      await ws.manual('statistics');
      assert.equal(state.records[0].data.objects_with_orbit, 0);
    });

// 仅存在于测试 Worker，不是备用推理路径。
const ENUMERATED_MODEL =
    'import {WorkerEntrypoint} from \'cloudflare:workers\';' +
    'export class TestModel extends WorkerEntrypoint {run(_, options) {const r=JSON.parse(options.messages[1].content).results;return {response: r.length ? {finish:[1]} : {calls:[{name:\'catalog_statistics\',args:{}}]}};}} export default {fetch:()=>new Response(null,{status:404})};';
