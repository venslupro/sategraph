import {Miniflare} from 'miniflare';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

import {catalog} from '../src/sg-data/catalog.ts';
import {archiveSource, GP_SOURCE} from '../src/sg-sync/archive_step.ts';
import {advanceGp, prepareGp} from '../src/sg-sync/gp_ingest.ts';
import {fetchSnapshot} from '../src/sg-sync/source_snapshot.ts';
import {activateWriter, applyOrbit} from '../src/sg-sync/storage/orbit_store.ts';

const root = new URL('../src/', import.meta.url);
const host = 'https://catalog.example.test/api/v1/';
const writer = {runId: 'local-gp', epoch: 1};

async function moduleFile(path) {
  const source = await readFile(new URL(path, root), 'utf8');
  const {outputText} = ts.transpileModule(source, {compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  }});
  return {type: 'ESModule', path, contents: outputText};
}

async function serviceConfig(unit) {
  return JSON.parse(await readFile(new URL(unit + '/wrangler.jsonc', root), 'utf8'));
}

async function fixture(t) {
  const [data, gateway, sync] = await Promise.all(
      ['sg-data', 'sg-api-gateway', 'sg-sync'].map(serviceConfig));
  const actualBinding = (unit, name) => {
    const {service, entrypoint} = unit.services.find(link => link.binding === name);
    return {name: service, entrypoint};
  };
  // 调用端仅注入被测角色的命名绑定；全部脚本仅在临时 workerd 中运行。
  const mf = new Miniflare({
    cf: false,
    d1Persist: false,
    durableObjectsPersist: false,
    workers: [
      {
        name: 'reader-test',
        modules: true,
        compatibilityDate: gateway.compatibility_date,
        serviceBindings: {DATA: actualBinding(gateway, 'DATA')},
        script: `export default {async fetch(req, env) {
         if (new URL(req.url).pathname === '/check-command') {
           try { await env.DATA.commit(); } catch (e) {return Response.json({error: e.message});}
           return Response.json({error: null});
         }
         return env.DATA.fetch(req);
       }};`
      },
      {
        name: 'writer-test',
        modules: true,
        compatibilityDate: sync.compatibility_date,
        serviceBindings: {FACTS: actualBinding(sync, 'FACTS')},
        script: `export default {async fetch(req, env) {
         const p = new URL(req.url).searchParams;
         try {
           const result = await env.FACTS.commit({runId: p.get('run'), epoch: Number(p.get('epoch'))},
               Number(p.get('chunk')), new Uint8Array(await req.arrayBuffer()));
           return Response.json(result);
         } catch (e) { return Response.json({error: e.message}, {status: 409}); }
       }};`
      },
      {
        name: data.name,
        compatibilityDate: data.compatibility_date,
        d1Databases: ['CORE'],
        bindings: {DISPLAY_SOURCES: GP_SOURCE},
        durableObjects: {
          COMMAND: {
            className: data.durable_objects.bindings[0].class_name,
            useSQLite: true
          }
        },
        modules: await Promise.all([
          'sg-data/index.ts',
          'sg-data/catalog.ts',
          'sg-data/policy.ts',
          'sg-sync/gp_ingest.ts',
          'sg-sync/gp_chunks.ts',
          'sg-sync/archive_step.ts',
          'sg-sync/source_snapshot.ts',
          'sg-sync/storage/orbit_store.ts',
        ].map(moduleFile))
      },
    ],
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('CORE', data.name);
  const dir = new URL('sg-sync/storage/migrations/', root);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(file, dir), 'utf8');
    await db.batch(sql.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  }
  const reader = await mf.getWorker('reader-test');
  const commands = await mf.getWorker('writer-test');
  const commit = async (w, chunk, bytes) => {
    const p = new URLSearchParams({run: w.runId, epoch: String(w.epoch), chunk: String(chunk)});
    const res = await commands.fetch('https://rpc.example.test/?' + p, {method: 'POST', body: bytes});
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
  };
  return {db, reader, commit, get: path => reader.fetch(host + path)};
}

async function pin(db, w, ids) {
  const records = ids.map(id => ({
    NORAD_CAT_ID: id, OBJECT_NAME: 'Example ' + id, OBJECT_ID: 'TEST-' + id,
    EPOCH: '2026-01-01T00:00:00Z', MEAN_MOTION: 14, ECCENTRICITY: 0.01,
    INCLINATION: 70, RA_OF_ASC_NODE: 10, ARG_OF_PERICENTER: 15, MEAN_ANOMALY: 30,
  }));
  const snap = await fetchSnapshot(undefined, async () => Response.json(records));
  await activateWriter(db, w);
  await archiveSource(db, w, {bucketId: 'b'.repeat(24), find: async () => null,
    upload: async () => 'test-' + snap.sha256}, async () => snap);
  const read = async (_, start, end) => snap.bytes.slice(start, end);
  await prepareGp(db, w, read);
  return {read, hash: snap.sha256};
}

test('本地命名绑定、事实命令和目录查询', async t => {
  const {db, reader, commit, get} = await fixture(t);
  const {read, hash} = await pin(db, writer, [3, 12, 1]);
  const search = async path => (await get('catalog/search' + path)).json();
  const detail = async path => (await get(path)).json();
  await t.test('只读入口无提交方法；命令端复核摘要与代际，重放不重复写', async () => {
    const res = await reader.fetch('https://catalog.example.test/check-command');
    assert.match((await res.json()).error, /not implemented|does not (exist|implement)|not a function|no such method|not found/i);
    assert.equal((await reader.fetch(host + 'catalog/search', {method: 'POST'})).status, 405);
    assert.equal((await get('datasets/current')).status, 404);
    await assert.rejects(commit(writer, 0, new Uint8Array([0])), /GP_RANGE_MISMATCH/);
    await assert.rejects(commit({...writer, epoch: 2}, 0, new Uint8Array([0])), /GP_INPUT_NOT_ACTIVE/);
    assert.equal(await db.prepare('SELECT next_row FROM gp_checkpoint').first('next_row'), 0);
    const result = await advanceGp(db, writer, 0, read, commit);
    assert.deepEqual(result, {nextChunk: 1, processed: 3, total: 3, complete: true});
    assert.deepEqual(await commit(writer, 0, new Uint8Array()), result);
    assert.equal(await db.prepare('SELECT count(*) AS n FROM projection_outbox').first('n'), 3);
    assert.equal((await detail('datasets/current')).manifest_id, hash);
    assert.equal((await detail('datasets/' + hash)).manifest_id, hash);
  });
  await t.test('展示白名单覆盖列表、详情、统计、证据和清单，不泄露其他来源', async () => {
    await applyOrbit(db, {writer, operationId: 'hidden', entityId: 'hidden:1', expectedRevision: 0,
      epochUs: 1, sourceId: 'private', evidenceId: 'hidden-evidence', objectId: 'hidden-object',
      format: 'OMM', frame: 'TEME'});
    const evidence = (await detail('satellites/norad%3A1')).evidence_id;
    assert.ok(evidence);
    assert.equal((await detail('evidence/' + evidence)).source_id, GP_SOURCE);
    assert.equal((await detail('catalog/statistics')).objects_with_orbit, 3);
    for (const path of ['satellites/hidden:1', 'evidence/hidden-evidence'])
      assert.equal((await get(path)).status, 404);
    for (const policy of [undefined, '', '*']) {
      const denied = path => catalog(db, policy, new URL(host + path));
      assert.deepEqual((await (await denied('catalog/search')).json()).items, []);
      assert.equal((await (await denied('catalog/statistics')).json()).objects_with_orbit, 0);
      for (const path of ['satellites/norad:1', 'evidence/' + evidence, 'datasets/current', 'datasets/' + hash])
        assert.equal((await denied(path)).status, 404);
    }
  });
  await t.test('按稳定编号翻页，并按编号、名称或国际编号检索', async () => {
    const first = await search('?limit=2');
    assert.deepEqual(first.items.map(x => x.entity_id), ['norad:1', 'norad:12']);
    assert.equal(first.next_cursor, 'norad:12');
    const second = await search('?limit=2&after=' + encodeURIComponent(first.next_cursor));
    assert.deepEqual(second.items.map(x => x.entity_id), ['norad:3']);
    assert.equal(second.next_cursor, null);
    for (const q of ['12', 'norad:12', 'TEST-12', 'example 12'])
      assert.deepEqual((await search('?q=' + encodeURIComponent(q))).items.map(x => x.entity_id), ['norad:12']);
    assert.equal((await detail('satellites/norad:12')).omm.MEAN_MOTION, 14);
    for (const query of ['?limit=0', '?limit=101', '?q=a&q=b', '?foo=x', '?after=%2F'])
      assert.equal((await get('catalog/search' + query)).status, 422);
  });
  await t.test('新输入未写完时不覆盖可见清单，历史摘要不回退到当前', async () => {
    const next = {runId: 'later', epoch: 2};
    const candidate = await pin(db, next, Array.from({length: 101}, (_, i) => i + 1));
    await advanceGp(db, next, 0, candidate.read, commit);
    assert.equal((await detail('datasets/current')).manifest_id, hash);
    assert.equal((await get('datasets/' + candidate.hash)).status, 404);
    await advanceGp(db, next, 1, candidate.read, commit);
    assert.equal((await detail('datasets/current')).manifest_id, candidate.hash);
    assert.equal((await detail('datasets/' + hash)).manifest_id, hash);
    assert.equal((await get('datasets/missing')).status, 404);
  });
});
