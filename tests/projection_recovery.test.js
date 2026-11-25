import assert from 'node:assert/strict';
import test from 'node:test';

import {activateWriter} from '../src/sg-sync/storage/orbit_store.ts';
import {advanceProjection} from '../src/sg-projector/advance.ts';
import {graphPort} from '../src/sg-projector/graph.ts';
import {snapshot} from '../src/sg-projector/journal.ts';

import {instance, setupProjection, writer} from './projector_fixture.js';

const initial = {
  instance,
  runId: '',
  epoch: 0,
  cursor: 0,
  hash: ''
};
const fields = ['instance', 'runId', 'epoch', 'cursor', 'hash'];
const reply = proof => Response.json(
    {
      data: {fields, values: [fields.map(k => proof[k])]},
      bookmarks: ['test-bookmark']
    },
    {status: 202});

// 只模拟 Query API 事务的提交边界；不把此测试视为 Cypher 或 Aura 实测。
function graphFixture() {
  let current = {...initial};
  let applies = 0;
  let claims = 0;
  let fault = '';
  const send = async (url, init) => {
    assert.equal(url, 'https://fixture.databases.neo4j.io/db/neo4j/query/v2');
    assert.equal(init.redirect, 'manual');
    const {accessMode, parameters: p} = JSON.parse(init.body);
    if (accessMode === 'Read') return reply(current);
    if (!p.rows) {
      claims++;
      assert.ok(p.positions.some(
          pos => pos.cursor === current.cursor && pos.hash === current.hash));
      assert.ok(p.epoch > current.epoch);
      current = {...current, runId: p.runId, epoch: p.epoch};
      return reply(current);
    }
    applies++;
    assert.deepEqual(
        [p.runId, p.epoch, p.baseCursor, p.baseHash],
        [current.runId, current.epoch, current.cursor, current.hash]);
    if (fault === 'before') throw Error('模拟未提交即断线');
    current = {...current, cursor: p.endCursor, hash: p.endHash};
    if (fault === 'after') throw Error('模拟提交后断线');
    return reply(current);
  };
  return {
    port: graphPort(
        'https://fixture.databases.neo4j.io', 'neo4j',
        'Basic dGVzdA==', instance, send),
    setFault(value) {
      fault = value;
    },
    get applies() {
      return applies;
    },
    get claims() {
      return claims;
    }
  };
}

test('图端提交后断线：重启只补 D1 确认，不重复发图写入', async t => {
  const {db, append} = await setupProjection(t);
  await append('A', 1);
  await append('B', 1);
  const graph = graphFixture();
  const advance = () => advanceProjection(db, graph.port, writer, instance);
  graph.setFault('after');
  await assert.rejects(advance(), /GRAPH_COMMIT_UNCONFIRMED/);
  const saved = await snapshot(db, writer, instance);
  assert.equal(saved.base.cursor, 0);
  assert.equal(saved.pending, true);
  assert.equal(await advance(), 'RECONCILED');
  assert.deepEqual(
      (await snapshot(db, writer, instance)).base, saved.chunk.end);
  assert.equal(await advance(), 'DRAINED');
  assert.equal(graph.applies, 1);
});

test('没有提交证明：同代际不重发，更高代际核对前置游标后接管', async t => {
  const {db, append} = await setupProjection(t);
  await append('A', 1);
  const graph = graphFixture();
  graph.setFault('before');
  await assert.rejects(
      advanceProjection(db, graph.port, writer, instance),
      /GRAPH_COMMIT_UNCONFIRMED/);
  assert.equal(
      await advanceProjection(db, graph.port, writer, instance),
      'COMMIT_UNKNOWN');
  assert.equal(graph.applies, 1);
  assert.equal((await snapshot(db, writer, instance)).base.cursor, 0);
  const next = {runId: 'new-run', epoch: 2};
  await activateWriter(db, next);
  graph.setFault('');
  assert.equal(
      await advanceProjection(db, graph.port, next, instance), 'ACKNOWLEDGED');
  assert.equal(graph.claims, 2);
  await assert.rejects(
      advanceProjection(db, graph.port, writer, instance), /FENCED/);
  assert.equal(graph.applies, 2);
});

test('图端游标分叉或代际超前时，不接管也不预留', async t => {
  const {db, append} = await setupProjection(t);
  await append('A', 1);
  for (const [proof, reason] of [
           [{...initial, cursor: 99}, /GRAPH_DIVERGED/],
           [{...initial, epoch: 2}, /GRAPH_FENCED/]]) {
    const port = {
      inspect: async () => proof,
      claim: assert.fail,
      apply: assert.fail
    };
    await assert.rejects(advanceProjection(db, port, writer, instance), reason);
    assert.equal((await snapshot(db, writer, instance)).pending, false);
  }
});

test('图响应不完整、有错误、字段错配或含未关闭事务均不确认为提交', async () => {
  const data = {fields, values: [[instance, writer.runId, 1, 0, '']]};
  for (const body
           of [{data}, {data, bookmarks: []},
               {data, bookmarks: ['b'], transaction: {id: 'open'}},
               {data, errors: [{code: 'x'}], bookmarks: ['b']},
               {data: {...data, values: []}, bookmarks: ['b']}]) {
    let calls = 0;
    const port = graphPort(
        'https://fixture.databases.neo4j.io', 'neo4j',
        'Basic dGVzdA==', instance, async () => {
          calls++;
          return Response.json(body, {status: 202});
        });
    await assert.rejects(
        port.claim(writer, {cursor: 0, hash: ''}), /GRAPH_COMMIT_UNCONFIRMED/);
    assert.equal(calls, 1);
  }
});
