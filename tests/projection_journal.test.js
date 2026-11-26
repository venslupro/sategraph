import assert from 'node:assert/strict';
import test from 'node:test';

import {makeChunk, MAX_ROWS} from '../src/sg-projector/chunk.ts';
import {acknowledge, reserve, snapshot, takeOver} from '../src/sg-projector/journal.ts';
import {activateWriter} from '../src/sg-sync/storage/orbit_store.ts';

import {instance, setupProjection, writer} from './projector_fixture.js';

const proof = (w, c) =>
    ({instance: c.instance, runId: w.runId, epoch: w.epoch, ...c.end});

test('一个流仅可预留一批，同一实体的连续修订拆批且不越序', async t => {
  const {db, append} = await setupProjection(t);
  for (const [id, revision] of [['A', 1], ['B', 1], ['A', 2]]) {
    await append(id, revision);
  }
  const {chunk} = await snapshot(db, writer, instance);
  assert.deepEqual(chunk.rows.map(r => r.event_seq), [1, 2]);
  assert.deepEqual(
      (await Promise.all([
        reserve(db, writer, chunk), reserve(db, writer, chunk)
      ])).sort(),
      [false, true]);
  await append('C', 1);
  const resumed = await snapshot(db, writer, instance);
  assert.equal(resumed.pending, true);
  assert.deepEqual(resumed.chunk, chunk);
  const valid = proof(writer, chunk);
  for (const change
           of [{hash: 'wrong'}, {cursor: 3}, {epoch: 7}, {instance: 'other'},
               {runId: 'other'}]) {
    await assert.rejects(
        acknowledge(db, writer, chunk, {...valid, ...change}),
        /PROOF_MISMATCH/);
  }
  assert.equal((await snapshot(db, writer, instance)).base.cursor, 0);
  assert.equal(await acknowledge(db, writer, chunk, valid), true);
  assert.equal(await acknowledge(db, writer, chunk, valid), false);
  const next = await snapshot(db, writer, instance);
  assert.deepEqual(next.base, chunk.end);
  assert.deepEqual(next.chunk.rows.map(r => r.event_seq), [3, 4]);
});

test('待确认批的内容改变则拒绝恢复，旧代际不能确认', async t => {
  const {db, append} = await setupProjection(t);
  await append('A', 1);
  const {chunk} = await snapshot(db, writer, instance);
  await reserve(db, writer, chunk);
  const next = {runId: 'projection-run-2', epoch: 2};
  await activateWriter(db, next);
  await assert.rejects(snapshot(db, writer, instance), /FENCED/);
  await assert.rejects(snapshot(db, next, 'other'), /INSTANCE_MISMATCH/);
  assert.equal(
      await acknowledge(db, writer, chunk, proof(writer, chunk)), false);
  const baseProof = {...proof(next, chunk), ...chunk.base};
  await assert.rejects(
      takeOver(db, next, chunk, {...baseProof, epoch: 1}), /PROOF_MISMATCH/);
  assert.equal(await takeOver(db, next, chunk, baseProof), true);
  assert.equal(await takeOver(db, next, chunk, baseProof), false);
  await db
      .prepare('UPDATE projection_outbox SET payload=\'{}\' WHERE event_seq=1')
      .run();
  await assert.rejects(snapshot(db, next, instance), /PAYLOAD_MISMATCH/);
});

test('空流不初始化，分片限制行数和字节，检测乱序', async t => {
  const {db, append} = await setupProjection(t);
  const empty = await snapshot(db, writer, instance);
  assert.equal(empty.chunk, null);
  assert.equal(
      await db.prepare('SELECT COUNT(*) AS n FROM projection_cursor')
          .first('n'),
      0);
  await append('A', 1);
  const row = (await snapshot(db, writer, instance)).chunk.rows[0];
  const data =
      await Promise.all(Array.from({length: MAX_ROWS + 1}, async (_, i) => {
        const payload = JSON.stringify({entity_id: String(i)});
        const hash = Buffer
                         .from(await crypto.subtle.digest(
                             'SHA-256', Buffer.from(payload)))
                         .toString('hex');
        return {
          ...row,
          entity_id: String(i),
          event_seq: i + 1,
          payload,
          payload_hash: hash
        };
      }));
  assert.equal(
      (await makeChunk(instance, empty.base, data)).rows.length, MAX_ROWS);
  await assert.rejects(
      makeChunk(instance, empty.base, [data[1], data[0]]), /INVALID_EVENT/);
  await assert.rejects(
      makeChunk(
          instance, empty.base, [{...row, payload: 'a'.repeat(256 * 1024)}]),
      /EVENT_TOO_LARGE/);
});
