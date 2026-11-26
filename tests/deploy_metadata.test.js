import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';

import {initialize} from '../scripts/deploy/metadata.js';

const services = {
  neo4j_origin: 'https://fixture.databases.neo4j.io',
  neo4j_database: 'neo4j'
};
const bindings = {
  environment: 'prd',
  account_id: 'a'.repeat(32),
  d1_database_name: 'sategraph-prd-core',
  existing_services: services
};
const env = {
  CLOUDFLARE_ACCOUNT_ID: bindings.account_id,
  EXISTING_SERVICES: JSON.stringify(services),
  GRAPH_INSTANCE: 'verified',
  GRAPH_BOOTSTRAP_AUTH: 'Basic Zml4dHVyZQ=='
};
const fields = ['instance', 'runId', 'epoch', 'cursor', 'hash'];
const migrations =
    new URL('../src/sg-sync/storage/migrations/', import.meta.url);
const sql = readFileSync(
    new URL('../scripts/deploy/metadata.sql', import.meta.url), 'utf8');
function database(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const name of readdirSync(migrations)
           .filter(x => x.endsWith('.sql'))
           .sort()) {
    db.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  return {db, result: () => [{success: true, results: db.prepare(sql).all()}]};
}
function graph(rows, empty = true) {
  const calls = [];
  const send = async (url, options) => {
    assert.equal(url, services.neo4j_origin + '/db/neo4j/query/v2');
    const {statement, bookmarks, parameters} = JSON.parse(options.body);
    assert.deepEqual(bookmarks, calls.length ? [String(calls.length)] : []);
    calls.push(statement);
    let values = [];
    if (statement.startsWith('MATCH')) {
      values = rows;
    } else if (statement.startsWith('RETURN')) {
      values = [[empty]];
    } else if (statement.startsWith('WITH')) {
      assert.equal(rows.length, 0);
      rows = [[parameters.instance, '', 0, 0, '']];
      values = rows;
    } else {
      assert.match(statement, /^CREATE CONSTRAINT IF NOT EXISTS/);
    }
    return Response.json(
        {data: {fields, values}, bookmarks: [String(calls.length)]});
  };
  return {send, calls};
}

test('空库首次创建控制节点，重跑不覆盖已有控制', async t => {
  const {result} = database(t);
  const g = graph([]);
  await initialize(
      bindings, result(), {...env, INITIALIZE_EMPTY_GRAPH: 'true'}, g.send);
  const rerun = graph([['verified', '', 0, 0, '']]);
  await initialize(bindings, result(), env, rerun.send);
  assert.equal(g.calls.filter(x => x.includes('ON CREATE SET')).length, 1);
  assert.equal(rerun.calls.filter(x => x.includes('SET')).length, 0);
});

test('已有投影接受待确认或已确认的进度，不退回零', async t => {
  const {db, result} = database(t);
  const hash = 'c'.repeat(64);
  db.prepare('INSERT INTO projection_cursor VALUES(?,?,?,?,?,?,?,?)')
      .run('orbit', 'verified', 0, '', 4, hash, 'r1', 1);
  const g = graph([['verified', 'r1', 1, 4, hash]]);
  await initialize(bindings, result(), env, g.send);
  assert.ok(g.calls.every(s => !s.includes('SET')));
  const wrong = graph([['verified', 'r1', 1, 5, hash]]);
  await assert.rejects(
      initialize(bindings, result(), env, wrong.send), /游标/);
  assert.equal(wrong.calls.length, 1);
});

test('目标、登记或初始状态异常时，不执行图写入', async t => {
  const {db, result} = database(t);
  const optIn = {...env, INITIALIZE_EMPTY_GRAPH: 'true'};
  for (const [options, rows, empty] of [
           [env, [], true], [optIn, [], false],
           [optIn, [['other', '', 0, 0, '']], false]]) {
    const g = graph(rows, empty);
    await assert.rejects(initialize(bindings, result(), options, g.send));
    assert.ok(
        g.calls.every(s => s.startsWith('MATCH') || s.startsWith('RETURN')));
  }
  db.exec('INSERT INTO command_control VALUES (1, \'r1\', 1, 0)');
  const missing = graph([]);
  await assert.rejects(
      initialize(bindings, result(), optIn, missing.send), /缺少图控制/);
  assert.equal(missing.calls.length, 1);
  const drift = graph([]);
  for (const target
           of [{...bindings, environment: 'stg'},
               {...bindings, d1_database_name: 'sategraph-stg-core'}]) {
    await assert.rejects(
        initialize(target, result(), env, drift.send), /目标/);
  }
  await assert.rejects(
      initialize(
          bindings, result(), {...env, EXISTING_SERVICES: '{}'}, drift.send),
      /目标/);
  db.exec('UPDATE source_registry SET parser_version=\'wrong\'');
  await assert.rejects(
      initialize(bindings, result(), env, drift.send), /来源登记/);
  assert.equal(drift.calls.length, 0);
});
