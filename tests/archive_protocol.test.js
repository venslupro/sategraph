import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';

import {ARCHIVE_PREFIX, authorizeArchive} from '../src/sg-sync/b2_archive.ts';
import {fetchSnapshot, GP_URL, MAX_INPUT_BYTES} from '../src/sg-sync/source_snapshot.ts';

const bucket = 'a'.repeat(24);
const raw = '[ {"NORAD_CAT_ID":1,"EPOCH":"2026-01-01T00:00:00Z"} ]';
const bytes = new TextEncoder().encode(raw);
const id = {
  byteLength: bytes.length,
  sha1: createHash('sha1').update(bytes).digest('hex'),
  sha256: createHash('sha256').update(bytes).digest('hex')
};
const file = {
  action: 'upload',
  bucketId: bucket,
  fileName: ARCHIVE_PREFIX + id.sha256 + '.json',
  contentLength: bytes.length,
  contentSha1: id.sha1,
  fileInfo: {sha256: id.sha256},
  fileId: 'version-1'
};
const uploadUrl =
    'https://pod-000-1143-18.backblaze.com/b2api/v4/b2_upload_file/' + bucket +
    '/fixture';
const allowed = {
  buckets: [{id: bucket}],
  capabilities: ['listFiles', 'writeFiles'],
  namePrefix: ARCHIVE_PREFIX
};
const api = (scope = allowed) => ({
  authorizationToken: 'account-token',
  apiInfo:
      {storageApi: {apiUrl: 'https://api001.backblazeb2.com', allowed: scope}}
});

async function adapter(responses) {
  const calls = [];
  const port = await authorizeArchive(
      bucket, 'fixture-key', 'fixture-secret', async (url, init) => {
        calls.push({url, init});
        assert.equal(init.redirect, 'manual');
        assert.ok(init.signal);
        assert.ok(responses.length, '不应自动重发请求');
        return Response.json(responses.shift());
      });
  return {port, calls};
}

test(
    '固定来源保留原始字节，SHA-1/SHA-256 按实际数据计算，304 需要前置 ETag',
    async () => {
      const snapshot = await fetchSnapshot(undefined, async (url, init) => {
        assert.equal(url, GP_URL);
        assert.equal(init.redirect, 'manual');
        return new Response(bytes, {headers: {etag: '"input-1"'}});
      });
      assert.deepEqual({...snapshot}, {
        bytes,
        rows: 1,
        sha1: id.sha1,
        sha256: id.sha256,
        etag: '"input-1"'
      });
      assert.equal(await fetchSnapshot(snapshot.etag, async (_, init) => {
                     assert.equal(
                         init.headers.get('if-none-match'), snapshot.etag);
                     return new Response(null, {status: 304});
                   }), null);
      await assert.rejects(
          fetchSnapshot(
              undefined, async () => new Response(null, {status: 304})),
          /SOURCE_UNAVAILABLE/);
    });

test('来源超限、坏字节、重复编号或空输入均不归档', async () => {
  await assert.rejects(
      fetchSnapshot(
          undefined, async () => new Response(bytes, {
                       headers: {'content-length': String(MAX_INPUT_BYTES + 1)}
                     })),
      /SOURCE_TOO_LARGE/);
  for (const bad
           of ['[]', JSON.stringify([...JSON.parse(raw), ...JSON.parse(raw)]),
               '[{"NORAD_CAT_ID":1,"EPOCH":"bad"}]', Uint8Array.of(0xff)]) {
    await assert.rejects(
        fetchSnapshot(undefined, async () => new Response(bad)));
  }
});

test('B2 分开使用账号令牌与上传令牌，固定文件名并验证确切版本', async () => {
  const {port, calls} = await adapter([
    api(), {files: [], nextFileName: null},
    {uploadUrl, bucketId: bucket, authorizationToken: 'upload-token'}, file
  ]);
  assert.equal(await port.find(id), null);
  assert.equal(await port.upload(id, bytes), file.fileId);
  assert.equal(calls.length, 4);
  const query = JSON.parse(calls[1].init.body);
  assert.deepEqual(
      [query.prefix, query.startFileName, query.bucketId],
      [file.fileName, file.fileName, bucket]);
  assert.equal(calls[2].init.headers.Authorization, 'account-token');
  assert.equal(calls[3].url, uploadUrl);
  assert.equal(calls[3].init.headers.Authorization, 'upload-token');
  assert.equal(
      decodeURIComponent(calls[3].init.headers['X-Bz-File-Name']),
      file.fileName);
  assert.deepEqual(calls[3].init.body, bytes);
});

test(
    'B2 拒绝错桶、重复版本、隐藏标记和摘要不符，不向错误地址发送上传令牌',
    async () => {
      for (const scope
               of [{...allowed, buckets: []},
                   {...allowed, buckets: [{id: 'other'}]},
                   {...allowed, capabilities: ['listFiles']},
                   {...allowed, namePrefix: 'unrelated/'}]) {
        await assert.rejects(adapter([api(scope)]), /B2_KEY_SCOPE_MISMATCH/);
      }
      for (const files
               of [[file, file], [{...file, bucketId: 'other'}],
                   [{...file, action: 'hide'}], [{...file, contentSha1: 'bad'}],
                   [{...file, fileInfo: {sha256: 'bad'}}]]) {
        const {port} = await adapter([api(), {files, nextFileName: null}]);
        await assert.rejects(
            port.find(id), /B2_(AMBIGUOUS_VERSION|PROOF_MISMATCH)/);
      }
      const {port, calls} = await adapter([
        api(), {
          uploadUrl: 'https://other.example.test/upload',
          authorizationToken: 'upload-token',
          bucketId: bucket
        }
      ]);
      await assert.rejects(port.upload(id, bytes), /B2_INVALID_ENDPOINT/);
      assert.equal(calls.length, 2);
    });
