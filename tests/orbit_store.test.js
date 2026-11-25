import {Miniflare} from 'miniflare';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {activateWriter, applyOrbit, reconcileOrbit, sealWriter} from '../src/sg-sync/storage/orbit_store.ts';

const migration = new URL(
    '../src/sg-sync/storage/migrations/0001_orbit_facts.sql', import.meta.url);
const first = {
  runId: 'local-run-1',
  epoch: 1
};
const next = {
  runId: 'local-run-2',
  epoch: 2
};
const command = {
  writer: first,
  operationId: 'operation-1',
  entityId: 'fixture-orbit',
  expectedRevision: 0,
  epochUs: 1_700_000_000_000_000,
  sourceId: 'fixture',
  evidenceId: 'evidence-1',
  objectId: 'fixture-1',
  format: 'OMM',
  frame: 'TEME'
};

async function database(t) {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {}',
    cf: false,
    compatibilityDate: '2026-07-01',
    d1Databases: ['CORE'],
    d1Persist: false
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('CORE');
  const definitions = (await readFile(migration, 'utf8'))
                          .split(';')
                          .map(s => s.trim())
                          .filter(Boolean);
  await db.batch(definitions.map(s => db.prepare(s)));
  return db;
}

const count = (db, table) =>
    db.prepare('SELECT count(*) AS n FROM ' + table).first('n');

test('同一命令并发与迟到重放只提交一个版本、一个事件和一张收据', async t => {
  const db = await database(t);
  await activateWriter(db, first);
  const result = {outcome: 'APPLIED', revision: 1};
  assert.deepEqual(
      await Promise.all([applyOrbit(db, command), applyOrbit(db, command)]),
      [result, result]);
  assert.deepEqual(await reconcileOrbit(db, command), result);
  const second = {
    ...command,
    operationId: 'operation-2',
    expectedRevision: 1,
    epochUs: command.epochUs + 1,
    objectId: 'fixture-2'
  };
  assert.deepEqual(
      await applyOrbit(db, second), {outcome: 'APPLIED', revision: 2});
  assert.deepEqual(await applyOrbit(db, command), result);
  const events =
      (await db
           .prepare(
               'SELECT revision, payload FROM projection_outbox ORDER BY event_seq')
           .all())
          .results;
  assert.deepEqual(
      events.map(e => [e.revision, JSON.parse(e.payload).object_id]),
      [[1, 'fixture-1'], [2, 'fixture-2']]);
  assert.equal(await count(db, 'command_receipt'), 2);
  await assert.rejects(
      applyOrbit(db, {...command, objectId: 'different'}),
      /OPERATION_CONFLICT/);
  await assert.rejects(
      reconcileOrbit(db, {...command, evidenceId: 'other'}),
      /OPERATION_CONFLICT/);
});

test('旧历元或未变化输入不改当前事实，修订不匹配不被确认', async t => {
  const db = await database(t);
  await activateWriter(db, first);
  await applyOrbit(db, command);
  const unchanged = {...command, operationId: 'same', expectedRevision: 1};
  assert.deepEqual(
      await applyOrbit(db, unchanged), {outcome: 'UNCHANGED', revision: 1});
  const old = {
    ...unchanged,
    operationId: 'older',
    epochUs: command.epochUs - 1
  };
  assert.deepEqual(await applyOrbit(db, old), {outcome: 'OLDER', revision: 1});
  const stale = {...command, operationId: 'stale'};
  await assert.rejects(applyOrbit(db, stale), /REVISION_CONFLICT/);
  assert.equal(await reconcileOrbit(db, stale), null);
  assert.equal(
      await db.prepare('SELECT epoch_us FROM orbit_current').first('epoch_us'),
      command.epochUs);
  assert.equal(await count(db, 'projection_outbox'), 1);
});

test('封存或更换运行后，旧写者不能推进或重新激活', async t => {
  const db = await database(t);
  await assert.rejects(applyOrbit(db, command), /FENCED/);
  await activateWriter(db, first);
  await activateWriter(db, first);
  await assert.rejects(
      activateWriter(db, {runId: 'other', epoch: 1}), /FENCED/);
  await sealWriter(db, first);
  await assert.rejects(activateWriter(db, first), /FENCED/);
  await activateWriter(db, next);
  await sealWriter(db, first);
  await assert.rejects(applyOrbit(db, command), /FENCED/);
  await assert.rejects(activateWriter(db, first), /FENCED/);
  assert.deepEqual(
      await applyOrbit(db, {...command, writer: next}),
      {outcome: 'APPLIED', revision: 1});
});

test('投影事件写失败时，轨道和操作收据同时回滚', async t => {
  const db = await database(t);
  await activateWriter(db, first);
  await applyOrbit(db, command);
  await db
      .prepare(
          'CREATE TRIGGER test_fault BEFORE INSERT ON projection_outbox BEGIN SELECT RAISE(ABORT,\'test_outbox_failure\'); END')
      .run();
  const update = {
    ...command,
    operationId: 'will-fail',
    expectedRevision: 1,
    epochUs: command.epochUs + 1
  };
  await assert.rejects(applyOrbit(db, update), /test_outbox_failure/);
  assert.equal(await reconcileOrbit(db, update), null);
  assert.equal(
      await db.prepare('SELECT revision FROM orbit_current').first('revision'),
      1);
  assert.equal(await count(db, 'command_receipt'), 1);
  assert.equal(await count(db, 'projection_outbox'), 1);
});
