import assert from 'node:assert/strict';
import test from 'node:test';

import {handle} from '../src/sg-api-gateway/index.ts';
import {issueCookie, validSession} from '../src/sg-api-gateway/session.ts';

const host = 'sg.example.test';
const origin = 'https://' + host;
const key = id => ({
  id,
  secret: Buffer.from(crypto.getRandomValues(new Uint8Array(32)))
              .toString('base64url')
});
const signing = key('test-current');
const keys = JSON.stringify({current: signing});
const env = {
  PUBLIC_HOSTNAME: host,
  TURNSTILE_SECRET: 'local-test-only',
  SESSION_KEYS: keys,
  STATUS: {
    status: async () => ({
      phase: 'UPDATING',
      run_status: 'RUNNING',
      data_quality: 'UNKNOWN',
      checkpoint: 7
    })
  }
};
const verify = (token, headers = {}) =>
    new Request(origin + '/api/v1/access/verify', {
      method: 'POST',
      headers: {'content-type': 'application/json', origin, ...headers},
      body: JSON.stringify({token})
    });
const reply = {
  success: true,
  hostname: host,
  action: 'sategraph_access'
};

test('签名会话严格校验受众、签名、过期时间与可轮换密钥', async () => {
  const time = Date.UTC(2026, 0, 1);
  const raw = await issueCookie(keys, host, time);
  assert.match(raw, /Path=\/; Secure; HttpOnly; SameSite=Lax/);
  const cookie = raw.split(';')[0];
  const rotated = JSON.stringify({current: key('next'), previous: signing});
  assert.equal(await validSession(cookie, rotated, host, time + 7199999), true);
  for (const [c, k, h, t] of [
           [cookie, keys, host, time + 7200000],
           [cookie, keys, host, time - 1000],
           [cookie, keys, 'other.example.test', time],
           [cookie + '; ' + cookie, keys, host, time],
           [cookie + 'x', keys, host, time],
           [cookie, JSON.stringify({current: key('next')}), host, time]]) {
    assert.equal(await validSession(c, k, h, t), false);
  }
});

test('只有服务端确认 hostname 和 action 后才签发 Cookie', async () => {
  let calls = 0;
  const good = await handle(verify('test-token'), env, async (url, init) => {
    calls++;
    assert.equal(new URL(url).hostname, 'challenges.cloudflare.com');
    assert.equal(init.body.get('response'), 'test-token');
    return Response.json(reply);
  });
  assert.equal(calls, 1);
  assert.equal(good.status, 200);
  assert.ok(good.headers.has('set-cookie'));
  for (const change
           of [{success: false}, {hostname: 'other.example.test'},
               {action: 'other'}]) {
    const rejected = await handle(
        verify('test-token'), env,
        async () => Response.json({...reply, ...change}));
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.has('set-cookie'), false);
  }
  const offline = await handle(verify('test-token'), env, async () => {
    throw Error('unavailable');
  });
  assert.equal(offline.status, 503);
  assert.equal(offline.headers.has('set-cookie'), false);
});

test('来源和体积在发出校验请求前检查；公开状态不泄露检查点', async () => {
  let calls = 0;
  const noSend = async () => {
    calls++;
    throw Error('不应联网');
  };
  assert.equal(
      (await handle(
           verify('ok', {origin: 'https://other.example.test'}), env, noSend))
          .status,
      403);
  assert.equal(
      (await handle(verify('x'.repeat(4100)), env, noSend)).status, 422);
  assert.equal(calls, 0);
  const res = await handle(new Request(origin + '/api/v1/status'), env);
  assert.deepEqual(
      await res.json(),
      {phase: 'UPDATING', run_status: 'RUNNING', data_quality: 'UNKNOWN'});
});

test('普通请求没有启动入口，受保护的读取不按更新阶段拒绝', async () => {
  const cookie = (await issueCookie(keys, host)).split(';')[0];
  for (const phase
           of ['IDLE', 'UPDATING', 'RETRY_WAIT', 'VERIFYING', 'FINALIZING']) {
    const state = {
      ...env,
      STATUS: {
        status: async () =>
            ({phase, run_status: phase === 'IDLE' ? 'FAILED' : 'RUNNING'})
      }
    };
    const detail = origin + '/api/v1/status/detail';
    assert.equal((await handle(new Request(detail), state)).status, 401);
    const result =
        await handle(new Request(detail, {headers: {cookie}}), state);
    assert.equal(result.status, 200);
    assert.equal((await result.json()).phase, phase);
  }
  const write = new Request(
      origin + '/api/v1/sync/start',
      {method: 'POST', headers: {origin, cookie}});
  assert.equal((await handle(write, env)).status, 404);
});
test('目录先验会话，仅转发读取参数，不转发浏览器或服务端凭据', async () => {
  const cookie = (await issueCookie(keys, host)).split(';')[0];
  const calls = [];
  const state = {
    ...env,
    DATA: {
      async fetch(req) {
        calls.push(req);
        return Response.json({error: 'INVALID_QUERY'}, {
          status: 422,
          headers: {'set-cookie': 'internal-only=1'},
        });
      }
    }
  };
  const url = origin + '/api/v1/catalog/search?limit=101';
  assert.equal((await handle(new Request(url), state)).status, 401);
  assert.equal(calls.length, 0);
  const res = await handle(
      new Request(url, {
        headers: {
          cookie,
          authorization: 'Bearer local-only',
          'x-private': 'private'
        },
      }),
      state);
  assert.equal(res.status, 422);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.has('set-cookie'), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, url);
  assert.equal(calls[0].method, 'GET');
  for (const key of ['cookie', 'authorization', 'x-private']) {
    assert.equal(calls[0].headers.has(key), false);
  }
  const post = new Request(url, {method: 'POST', headers: {cookie, origin}});
  assert.notEqual((await handle(post, state)).status, 200);
  assert.equal(calls.length, 1);
});
