import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {activateWriter, applyOrbit} from '../src/sg-sync/storage/orbit_store.ts';
import {archiveSource} from '../src/sg-sync/archive_step.ts';
import {authorizeArchive} from '../src/sg-sync/b2_archive.ts';
import {indexGp, readGpSpan, sha256} from '../src/sg-sync/gp_chunks.ts';
import {advanceGp as dispatchGp, commitGpChunk, prepareGp} from '../src/sg-sync/gp_ingest.ts';
import {fetchSnapshot} from '../src/sg-sync/source_snapshot.ts';

import {setupProjection, writer} from './projector_fixture.js';

const enc = new TextEncoder(), bucketId = 'b'.repeat(24);
const row = (id, extra = {}) => ({
  NORAD_CAT_ID: id,
  EPOCH: '2026-01-01T00:00:00.123456',
  MEAN_MOTION: 14,
  ECCENTRICITY: 0.001,
  INCLINATION: 75,
  RA_OF_ASC_NODE: 20,
  ARG_OF_PERICENTER: 30,
  MEAN_ANOMALY: 40,
  ...extra
});
const rows = n => Array.from({length: n}, (_, i) => row(i + 1));
const noRead = () => assert.fail('不应再次读取归档');
const advanceGp = (db, writer, chunk, read) => dispatchGp(
    db, writer, chunk, read, (w, c, bytes) => commitGpChunk(db, w, c, bytes));
const count = (db, table) =>
    db.prepare('SELECT count(*) AS n FROM ' + table).first('n');
async function database(t) {
  const {db} = await setupProjection(t);
  for (const name of ['0003_source_archive.sql', '0004_gp_manifest.sql', '0005_catalog.sql']) {
    const sql = await readFile(
        new URL('../src/sg-sync/storage/migrations/' + name, import.meta.url),
        'utf8');
    await db.batch(sql.split(';')
                       .map(s => s.trim())
                       .filter(Boolean)
                       .map(s => db.prepare(s)));
  }
  return db;
}
async function pin(db, w, records) {
  const snap =
      await fetchSnapshot(undefined, async () => Response.json(records));
  const fileId = 'version-' + snap.sha256;
  await archiveSource(
      db, w, {bucketId, find: async () => null, upload: async () => fileId},
      async () => snap);
  const ranges = [];
  const read = async (version, start, end) => {
    assert.deepEqual(
        version, {bucketId, fileId, byteLength: snap.bytes.length});
    ranges.push([start, end]);
    return snap.bytes.slice(start, end);
  };
  return {read, ranges, snap};
}

test(
    '整份 UTF-8 JSON 按字节和行数分片，保留转义、多字节字符与微秒历元',
    async () => {
      const rec = rows(205);
      rec[0].OBJECT_NAME = '甲}"{,乙';
      rec[1].note = '星'.repeat(65000);
      rec[2].note = '月'.repeat(65000);
      const raw = enc.encode(
          String.fromCharCode(0xfeff) + JSON.stringify(rec, null, 2));
      const spans = await indexGp(raw, await sha256(raw), 205);
      const result = [];
      for (const s of spans) {
        assert.ok(s.count <= 100 && s.end - s.start + 2 <= 256 * 1024);
        assert.equal(s.first, result.length);
        result.push(...await readGpSpan(raw.subarray(s.start, s.end), s));
      }
      assert.ok(spans.length >= 4);
      assert.deepEqual(
          result.map(r => r.id), rec.map(r => String(r.NORAD_CAT_ID)));
      assert.equal(
          result[0].epoch, Date.parse('2026-01-01T00:00:00Z') * 1000 + 123456);
    });

test(
    '坏尾部、跨块重复、数量或摘要不符、超大单行均不能产生可用清单',
    async () => {
      const bad = [
        ['[]', 0], ['[' + JSON.stringify(row(1)) + ',]', 1],
        [JSON.stringify(rows(2)) + 'x', 2],
        [JSON.stringify([...rows(101), row('1')]), 102],
        [JSON.stringify([row(1, {EPOCH: '2026-02-31T00:00:00'})]), 1],
        [JSON.stringify([row(1, {REF_FRAME: 'other'})]), 1],
        [JSON.stringify([row(1, {MEAN_MOTION: null})]), 1],
        [JSON.stringify([row(1, {note: 'a'.repeat(256 * 1024)})]), 1],
        [JSON.stringify(rows(2)), 1]
      ];
      for (const [txt, n] of bad) {
        const b = enc.encode(txt);
        const h = await sha256(b);
        await assert.rejects(indexGp(b, h, n));
      }
      await assert.rejects(
          indexGp(enc.encode(JSON.stringify(rows(1))), 'wrong', 1),
          /GP_INPUT_MISMATCH/);
    });

test(
    '205 行只有末块完成才报齐；并发重放和重启从持久断点续读，不重新下载整份文件',
    async t => {
      const db = await database(t), f = await pin(db, writer, rows(205));
      assert.deepEqual(
          await prepareGp(db, writer, f.read),
          {nextChunk: 0, processed: 0, total: 205, complete: false});
      await assert.rejects(advanceGp(db, writer, 1, noRead), /OUT_OF_ORDER/);
      const both = await Promise.all(
          [advanceGp(db, writer, 0, f.read), advanceGp(db, writer, 0, f.read)]);
      assert.deepEqual(both[0], both[1]);
      assert.equal(both[0].processed, 100);
      assert.equal(both[0].complete, false);
      assert.deepEqual(await prepareGp(db, writer, noRead), both[0]);
      assert.deepEqual(await advanceGp(db, writer, 0, noRead), both[0]);
      assert.equal((await advanceGp(db, writer, 1, f.read)).processed, 200);
      const done = {nextChunk: 3, processed: 205, total: 205, complete: true};
      assert.deepEqual(await advanceGp(db, writer, 2, f.read), done);
      assert.deepEqual(await advanceGp(db, writer, 2, noRead), done);
      assert.deepEqual(await advanceGp(db, writer, 3, noRead), done);
      for (const table
               of ['orbit_current', 'command_receipt', 'projection_outbox'])
        assert.equal(await count(db, table), 205);
      assert.deepEqual(
          (await db
               .prepare(
                   'SELECT entity_id FROM projection_outbox ORDER BY event_seq')
               .all())
              .results.map(x => x.entity_id),
          rows(205).map(x => 'norad:' + x.NORAD_CAT_ID));
      assert.equal(
          f.ranges.filter(([s, e]) => s === 0 && e === f.snap.bytes.length)
              .length,
          1);
    });

test(
    '尾行预检失败零业务写；分片损坏和 outbox 错误不推进断点，修复后可继续',
    async t => {
      const db = await database(t),
            a = await pin(
                db, writer, [...rows(100), row(101, {ECCENTRICITY: 1})]);
      await assert.rejects(
          prepareGp(db, writer, a.read), /INVALID_GP_ELEMENTS/);
      for (const table
               of ['gp_manifest', 'gp_checkpoint', 'orbit_current',
                   'projection_outbox'])
        assert.equal(await count(db, table), 0);
      const w = {runId: 'valid', epoch: writer.epoch + 1};
      await activateWriter(db, w);
      const f = await pin(db, w, rows(4));
      await prepareGp(db, w, f.read);
      await assert.rejects(
          advanceGp(
              db, w, 0, async (...args) => (await f.read(...args)).fill(32)),
          /GP_RANGE_MISMATCH/);
      await db
          .prepare(
              'CREATE TRIGGER fault BEFORE INSERT ON projection_outbox WHEN NEW.entity_id=\'norad:4\' BEGIN SELECT RAISE(ABORT,\'outbox_fault\'); END')
          .run();
      await assert.rejects(advanceGp(db, w, 0, f.read), /outbox_fault/);
      for (const table
               of ['command_receipt', 'orbit_current', 'projection_outbox'])
        assert.equal(await count(db, table), 0);
      assert.equal((await prepareGp(db, w, noRead)).processed, 0);
      await db.prepare('DROP TRIGGER fault').run();
      assert.equal((await advanceGp(db, w, 0, f.read)).processed, 4);
    });

test('新快照只投影真实轨道变化；等值写法、旧历元和一次缺失均不改原事实', async t => {
  const db = await database(t), f = await pin(db, writer, rows(4));
  await prepareGp(db, writer, f.read);
  await advanceGp(db, writer, 0, f.read);
  const w = {runId: 'second', epoch: 2};
  await activateWriter(db, w);
  const s = await pin(db, w, [
    row('1', {
      OBJECT_NAME: '改名',
      MEAN_MOTION: '14.0',
      EPOCH: '2026-01-01T00:00:00.123456Z'
    }),
    row(2, {EPOCH: '2026-01-01T00:00:00.123455Z'}), row(3, {MEAN_ANOMALY: 42}),
    row(5)
  ]);
  await prepareGp(db, w, s.read);
  await advanceGp(db, w, 0, s.read);
  const data =
      (await db
           .prepare(
               'SELECT entity_id,revision FROM orbit_current ORDER BY entity_id')
           .all())
          .results;
  assert.deepEqual(data.map(x => x.revision), [1, 1, 2, 1, 1]);
  assert.equal(await count(db, 'projection_outbox'), 6);
  assert.deepEqual(
      (await db
           .prepare(
               'SELECT outcome FROM command_receipt WHERE run_id=? ORDER BY entity_id')
           .bind(w.runId)
           .all())
          .results.map(r => r.outcome),
      ['UNCHANGED', 'OLDER', 'APPLIED', 'APPLIED']);
});

test('跨来源冲突和读取期间的写者接管不允许整块写入', async t => {
  const db = await database(t), f = await pin(db, writer, rows(2));
  await prepareGp(db, writer, f.read);
  await applyOrbit(db, {
    writer,
    operationId: 'external',
    entityId: 'norad:2',
    expectedRevision: 0,
    epochUs: 0,
    sourceId: 'another',
    evidenceId: 'reference',
    objectId: 'other',
    format: 'OMM',
    frame: 'TEME'
  });
  await assert.rejects(advanceGp(db, writer, 0, f.read), /GP_INPUT_CONFLICT/);
  assert.equal((await prepareGp(db, writer, noRead)).processed, 0);
  assert.equal(await count(db, 'orbit_current'), 1);
  await assert.rejects(advanceGp(db, writer, 0, async (...args) => {
                         await activateWriter(
                             db, {runId: 'new-owner', epoch: 2});
                         return f.read(...args);
                       }), /GP_INPUT_NOT_ACTIVE/);
  assert.equal(await count(db, 'command_receipt'), 1);
  assert.equal(await count(db, 'projection_outbox'), 1);
});

async function downloadPort(
    handler, downloadUrl = 'https://f001.backblazeb2.com',
    capabilities = ['listFiles', 'writeFiles', 'readFiles']) {
  return authorizeArchive(bucketId, 'fixture', 'fixture', async (url, init) => {
    if (url.endsWith('b2_authorize_account'))
      return Response.json({
        authorizationToken: 'fixture',
        apiInfo: {
          storageApi: {
            apiUrl: 'https://api001.backblazeb2.com',
            downloadUrl,
            allowed: {buckets: [{id: bucketId}], capabilities}
          }
        }
      });
    return handler(url, init);
  });
}

test(
    '私有 B2 只按固定版本读取；完整返回 200，分段必须匹配 206、区间和实际字节数',
    async () => {
      const v = {bucketId, fileId: 'version+1', byteLength: 4};
      const port = await downloadPort((url, init) => {
        assert.equal(new URL(url).searchParams.get('fileId'), v.fileId);
        assert.equal(init.headers.Authorization, 'fixture');
        assert.equal(init.redirect, 'manual');
        assert.equal(init.headers['Accept-Encoding'], 'identity');
        const full = init.headers.Range === 'bytes=0-3';
        if (!full) assert.equal(init.headers.Range, 'bytes=1-2');
        return new Response(full ? 'abcd' : 'bc', {
          status: full ? 200 : 206,
          headers: {
            'content-length': full ? '4' : '2',
            'x-bz-file-id': v.fileId,
            ...(full ? {} : {'content-range': 'bytes 1-2/4'})
          }
        });
      });
      assert.equal(
          new TextDecoder().decode(await port.readRange(v, 0, 4)), 'abcd');
      assert.equal(
          new TextDecoder().decode(await port.readRange(v, 1, 3)), 'bc');
      for (const [status, headers, body] of [
               [200, {}, 'bc'], [206, {'content-range': 'bytes 0-1/4'}, 'bc'],
               [206, {'x-bz-file-id': 'other'}, 'bc'],
               [206, {'content-encoding': 'gzip'}, 'bc'], [206, {}, 'b'],
               [206, {}, 'bcd']]) {
        const bad = await downloadPort(() => new Response(body, {
                                         status,
                                         headers: {
                                           'content-length': '2',
                                           'x-bz-file-id': v.fileId,
                                           'content-range': 'bytes 1-2/4',
                                           ...headers
                                         }
                                       }));
        await assert.rejects(bad.readRange(v, 1, 3), /RANGE_MISMATCH/);
      }
    });

test('错误下载域、错桶、缺读权限及越界读取均在发送令牌前拒绝', async () => {
  const v = {bucketId, fileId: 'pinned', byteLength: 4},
        good = await downloadPort(noRead);
  await assert.rejects(
      good.readRange({...v, bucketId: 'elsewhere'}, 0, 4), /DOWNLOAD_SCOPE/);
  for (const [start, end] of [[0, 0], [0, 5], [-1, 2], [0, 1.5]])
    await assert.rejects(good.readRange(v, start, end), /INVALID_RANGE/);
  const wrong = await downloadPort(noRead, 'https://invalid.example.test'),
        noCap =
            await downloadPort(noRead, undefined, ['listFiles', 'writeFiles']);
  for (const p of [wrong, noCap])
    await assert.rejects(p.readRange(v, 0, 4), /DOWNLOAD_SCOPE/);
});
