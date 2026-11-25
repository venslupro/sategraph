import assert from 'node:assert/strict';
import test from 'node:test';

import {probeObject} from '../scripts/validation/b2.ts';
import {probeGraph} from '../scripts/validation/neo4j.ts';

const origin = 'https://fixture.databases.neo4j.io';
const apiOrigin = 'https://api001.backblazeb2.com';
const bucketId = '0'.repeat(24);
const fileId = 'isolated-fixture-version';
const metadata = {
  bucketId,
  fileId,
  contentLength: 32,
  action: 'upload'
};
const open = () => Response.json(
    {transaction: {id: 'tx1'}, data: {fields: ['probe'], values: [[1]]}},
    {status: 202, headers: {'neo4j-cluster-affinity': 'fixture-node'}});

test('图探测只执行固定查询，向 commit 传递节点标识', async () => {
  const calls = [];
  const send = async (url, init) => {
    calls.push({url, headers: new Headers(init.headers), body: init.body});
    assert.equal(init.redirect, 'error');
    return calls.length === 1 ? open() : Response.json({bookmarks: ['bm1']});
  };
  assert.equal(await probeGraph(origin, 'neo4j', 'fixture', send), 'CONFIRMED');
  assert.deepEqual(
      calls.map(call => call.url.slice(origin.length)),
      ['/db/neo4j/query/v2/tx', '/db/neo4j/query/v2/tx/tx1/commit']);
  assert.equal(JSON.parse(calls[0].body).statement, 'RETURN 1 AS probe');
  assert.equal(calls[1].headers.get('neo4j-cluster-affinity'), 'fixture-node');
});

test('提交断流、错误、缺少书签均不确认，且不重发请求', async () => {
  for (const finish
           of [() => {
             throw new Error('断流');
           },
              () => new Response('{', {status: 202}),
              () => Response.json({}, {status: 202}),
              () => Response.json({errors: [{code: 'x'}], bookmarks: ['bm1']}),
              () => new Response(null, {status: 503})]) {
    let count = 0;
    const send = async () => ++count === 1 ? open() : finish();
    await assert.rejects(
        probeGraph(origin, 'neo4j', 'fixture', send), /COMMIT_UNKNOWN/);
    assert.equal(count, 2);
  }
});

test('节点路由信息缺失时不发送下一步提交', async () => {
  let count = 0;
  const send = async () => {
    count++;
    return Response.json(
        {transaction: {id: 'tx1'}, data: {fields: ['probe'], values: [[1]]}});
  };
  await assert.rejects(
      probeGraph(origin, 'neo4j', 'fixture', send), /INVALID_OPEN_RESPONSE/);
  assert.equal(count, 1);
});

test('B2 仅核对指定文件版本，不读取文件内容', async () => {
  const send = async (url, init) => {
    assert.equal(url, apiOrigin + '/b2api/v4/b2_get_file_info');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(JSON.parse(init.body), {fileId});
    return Response.json(metadata);
  };
  assert.deepEqual(
      await probeObject(apiOrigin, 'fixture', bucketId, fileId, send),
      {bytes: 32});
});

test('B2 将桶或版本错配、删除标记和非成功响应区分于有效对象', async () => {
  for (const patch
           of [{bucketId: 'other'}, {fileId: 'other'}, {action: 'hide'},
               {contentLength: -1}, {contentLength: null}]) {
    const send = async () => Response.json({...metadata, ...patch});
    await assert.rejects(
        probeObject(apiOrigin, 'fixture', bucketId, fileId, send),
        /INVALID_OBJECT_METADATA/);
  }
  await assert.rejects(
      probeObject(
          apiOrigin, 'fixture', bucketId, fileId,
          async () => new Response(null, {status: 403})),
      /OBJECT_READ_FAILED/);
});

test('不向非批准的地址传递凭据', async () => {
  let calls = 0;
  const send = async () => {
    calls++;
    throw new Error('不应调用');
  };
  await assert.rejects(
      probeGraph(origin + '/unexpected', 'neo4j', 'fixture', send),
      /INVALID_ENDPOINT/);
  await assert.rejects(
      probeObject(apiOrigin + '.example', 'fixture', bucketId, fileId, send),
      /INVALID_OBJECT_REFERENCE/);
  assert.equal(calls, 0);
});
