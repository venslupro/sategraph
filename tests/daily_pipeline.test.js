import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {projectAt} from '../src/sg-projector/advance.ts';
import {snapshot} from '../src/sg-projector/journal.ts';
import {admit, DAILY_CRON, readStatus, resume} from '../src/sg-sync/coordinator.ts';
import {runStage} from '../src/sg-sync/pipeline.ts';
import {commitGpChunk} from '../src/sg-sync/gp_ingest.ts';
import {fetchSnapshot} from '../src/sg-sync/source_snapshot.ts';

import {instance, setupProjection} from './projector_fixture.js';

// 持久键值使用拷贝语义；D1 使用本地 workerd。真实 DO
// 的调度、并发及事务另有专项测试。
function controlStore() {
  const values = new Map();
  return {
    get: async k => structuredClone(values.get(k)),
    put: async (k, v) => values.set(k, structuredClone(v)),
    transaction(fn) {
      return fn(this);
    },
    setAlarm() {},
    deleteAlarm() {}
  };
}

async function fixture(t, fault) {
  const {db} = await setupProjection(t);
  // 预置较早代际，测试下一日换代，不复用测试夹具的运行身份。
  const store = controlStore();
  await store.put('current', {writer_epoch: 1, run_status: 'FAILED'});
  for (const name of ['0003_source_archive.sql', '0004_gp_manifest.sql', '0005_catalog.sql']) {
    const sql = await readFile(
        new URL('../src/sg-sync/storage/migrations/' + name, import.meta.url),
        'utf8');
    await db.batch(sql.split(';')
                       .map(s => s.trim())
                       .filter(Boolean)
                       .map(s => db.prepare(s)));
  }
  const rows = Array.from({length: 101}, (_, i) => ({
                                           NORAD_CAT_ID: i + 1,
                                           EPOCH: '2026-01-01T00:00:00Z',
                                           MEAN_MOTION: 14,
                                           ECCENTRICITY: 0.001,
                                           INCLINATION: 70,
                                           RA_OF_ASC_NODE: 20,
                                           ARG_OF_PERICENTER: 30,
                                           MEAN_ANOMALY: 40
                                         }));
  const raw = await fetchSnapshot(undefined, async () => Response.json(rows));
  let proof = {instance, runId: '', epoch: 0, cursor: 0, hash: ''};
  const calls = {uploads: 0, fetches: 0, ranges: 0, writes: 0};
  const graph = {
    inspect: async () => proof,
    claim: async w => (proof = {...proof, ...w}),
    apply: async (w, chunk) => {
      calls.writes++;
      assert.equal(proof.cursor, chunk.base.cursor);
      if (fault === 'before') throw Error('模拟图写入前断线');
      proof = {instance, ...w, ...chunk.end};
      if (fault === 'after') {
        fault = '';
        throw Error('模拟图提交后断线');
      }
      return proof;
    }
  };
  const archive = {
    bucketId: 'a'.repeat(24),
    find: async () => null,
    upload: async () => {
      calls.uploads++;
      return 'frozen-version';
    },
    readRange: async (v, start, end) => {
      assert.equal(v.fileId, 'frozen-version');
      calls.ranges++;
      return raw.bytes.slice(start, end);
    }
  };
  const ports = {
    db,
    commitGp: (w, c, bytes) => commitGpChunk(db, w, c, bytes),
    archive: async () => archive,
    load: async () => {
      calls.fetches++;
      return raw;
    },
    projector: {
      cursor: async w => (await snapshot(db, w, instance)).base.cursor,
      advance: (w, c, r) => projectAt(db, graph, w, instance, c, r)
    }
  };
  const clock = Date.UTC(2099, 0, 1);
  assert.equal(await admit(store, DAILY_CRON, clock, clock), 'STARTED');
  async function tick(now = clock) {
    await resume(
        store, l => runStage(ports, l), () => now,
        l => runStage(ports, l, true));
    return store.get('current');
  }
  return {store, db, ports, clock, calls, tick};
}

test(
    '定时运行串联 101 条记录；D1 提交后进程中断和图回执丢失均不重复写，未发布不报成功',
    async t => {
      const {store, db, ports, clock, calls, tick} = await fixture(t, 'after');
      for (const stage of ['archive', 'index', 'ingest'])
        assert.equal((await tick()).stage, stage);
      const saved = await store.get('current');
      const op = [saved.run_id, saved.attempt_no, saved.checkpoint].join(':');
      await store.put(
          'current', {...saved, pending: op, next_at: clock + 60000});
      await runStage(
          ports,
          {...saved, operation_id: op});  // D1 已提交，协调器尚未收到结果。
      const n = calls.ranges;
      assert.equal((await tick(clock + 60000)).cursor, 1);
      assert.equal(calls.ranges, n);
      let state;
      for (let i = 0; i < 10; i++) {
        state = await tick(clock + 60000);
        if (state.run_status !== 'RUNNING') break;
      }
      assert.equal(state.error, 'PUBLICATION_NOT_VERIFIED');
      assert.equal(state.data_quality, 'PARTIAL');
      assert.equal(state.last_complete_publication_id, null);
      assert.equal(state.phase, 'IDLE');
      assert.deepEqual(calls, {uploads: 1, fetches: 1, ranges: 3, writes: 2});
      assert.equal(
          await db.prepare('SELECT acknowledged FROM projection_cursor')
              .first('acknowledged'),
          101);
      assert.equal(
          await db.prepare('SELECT active FROM command_control')
              .first('active'),
          0);
      assert.equal((await tick(clock + 86400000)).checkpoint, state.checkpoint);
    });

test('无法证明图端提交时标记未知，保留待确认批且不重发', async t => {
  const {db, store, calls, tick} = await fixture(t, 'before');
  for (let i = 0; i < 12; i++)
    if ((await tick()).run_status !== 'RUNNING') break;
  const state = await readStatus(store);
  assert.equal(state.run_status, 'FAILED');
  assert.equal(state.data_quality, 'UNKNOWN');
  assert.equal(state.error, 'COMMIT_UNKNOWN');
  assert.equal(calls.writes, 1);
  assert.deepEqual(
      await db.prepare('SELECT acknowledged,pending_end FROM projection_cursor')
          .first(),
      {acknowledged: 0, pending_end: 100});
  await tick();
  assert.equal(calls.writes, 1);
});
