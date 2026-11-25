import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

import {inspectTarget} from '../scripts/validation/readiness.ts';

const env = {
  SG_A2_NEO4J_ORIGIN: 'https://fixture.databases.neo4j.io',
  SG_A2_NEO4J_DATABASE: 'neo4j',
  SG_A2_NEO4J_AUTHORIZATION: 'Basic Zml4dHVyZQ==',
  SG_A2_B2_API_ORIGIN: 'https://api001.backblazeb2.com',
  SG_A2_B2_BUCKET_ID: 'b'.repeat(24),
  SG_A2_B2_FILE_ID: 'fixture-private-id',
  SG_A2_B2_TOKEN: 'fixture-private-token',
};

test('预检只报告准备状态，配置齐全也不发请求', async () => {
  let calls = 0;
  const send = () => {
    calls++;
    throw Error('不应联网');
  };
  for (const target of ['neo4j', 'b2']) {
    assert.deepEqual(
        await inspectTarget(target, env, false, send),
        {target, status: 'READY_OFFLINE'});
    assert.equal(
        (await inspectTarget(target, {}, true, send)).status, 'BLOCKED');
  }
  assert.equal(
      (await inspectTarget(
           'b2', {...env, SG_A2_B2_API_ORIGIN: 'https://example.test'}, true,
           send))
          .status,
      'INVALID_CONFIG');
  assert.equal(calls, 0);
});

test('实测只访问所选服务，失败和成功都不回显私密字段', async () => {
  const send = async () => Response.json({
    bucketId: env.SG_A2_B2_BUCKET_ID,
    fileId: env.SG_A2_B2_FILE_ID,
    action: 'upload',
    contentLength: 0
  });
  assert.deepEqual(
      await inspectTarget('b2', env, true, send),
      {target: 'b2', status: 'CONFIRMED'});
  const failed = await inspectTarget('neo4j', env, true, () => {
    throw Error(env.SG_A2_B2_TOKEN);
  });
  assert.deepEqual(
      failed, {target: 'neo4j', status: 'FAILED', code: 'PROBE_FAILED'});
});

test('未关闭的事务即使带书签也不算提交成功', async () => {
  const opened = {
    transaction: {id: 'tx'},
    data: {fields: ['probe'], values: [[1]]}
  };
  let calls = 0;
  const send = async (url, init) => {
    if (++calls === 1)
      return Response.json(
          opened, {headers: {'neo4j-cluster-affinity': 'node'}});
    assert.equal(init.body, undefined);
    return Response.json({transaction: {id: 'tx'}, bookmarks: ['bm']});
  };
  assert.deepEqual(
      await inspectTarget('neo4j', env, true, send),
      {target: 'neo4j', status: 'UNKNOWN', code: 'COMMIT_UNKNOWN'});
  assert.equal(calls, 2);
});

test('命令默认离线；实测必须明确点名一个目标', () => {
  const cli = (...args) => spawnSync(
      process.execPath, ['scripts/a2.js', ...args], {env, encoding: 'utf8'});
  const result = cli();
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).mode, 'OFFLINE');
  for (const arg
           of [['--live'], ['--live', 'all'], ['--live', 'b2', 'extra']]) {
    assert.equal(cli(...arg).status, 2);
  }
  assert.equal(JSON.parse(cli('--check', 'neo4j').stdout).checks.length, 1);
});
