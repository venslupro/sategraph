import assert from 'node:assert/strict';
import test from 'node:test';

import {assistantRequest, MODEL} from '../src/sg-assistant/assistant.ts';
import {askAssistant} from '../src/sg-pages/online_client.ts';

const origin = 'https://assistant.example.test';
const url = origin + '/api/v1/assistant/query';
const context = {
  from: 'A',
  to: 'B',
  scenario_id: 'example',
  analysis_time: '2026-01-01T00:00:00Z',
  purpose: 'study',
  orbit_manifest_id: 'example-1',
  model_version: 'v1'
};
const body = {
  message: '查询资料',
  context_revision: 7
};
const req = (input = body, extra = {}) => new Request(url, {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify(input),
  ...extra
});
const call = (name, args = {}) => ({name, args});
function fixture(plans, reply = () => Response.json({objects_with_orbit: 2})) {
  let model = 0;
  const reads = [];
  const messages = [];
  const store = unit => ({
    fetch(r) {
      reads.push({unit, r});
      return reply(r);
    }
  });
  const env = {
    APPROVED_MODEL: MODEL,
    AI: {
      async run(modelId, options) {
        assert.equal(modelId, MODEL);
        messages.push(JSON.parse(options.messages[1].content));
        const p = plans[model++];
        if (p instanceof Error) {
          throw p;
        }
        return {response: typeof p === 'function' ? await p() : p};
      }
    },
    DATA: store('DATA'),
    GRAPH: store('GRAPH')
  };
  return {env, reads, messages, models: () => model};
}
const events = async (f, input = body) =>
    (await (await assistantRequest(req(input), f.env)).json()).events;
const code = ev => ev.find(e => e.event === 'error')?.data.code;

test(
    '未批准的模型不执行；拒绝无效版本、额外参数、超长历史和超大请求',
    async () => {
      const f = fixture([]);
      for (const policy of [undefined, '', 'not-approved']) {
        assert.equal(
            (await assistantRequest(req(), {...f.env, APPROVED_MODEL: policy}))
                .status,
            503);
      }
      for (const input
               of [{...body, context_revision: -1},
                   {...body, message: 'x'.repeat(2001)}, {...body, extra: 1},
                   {...body, history: [{role: 'tool', text: '不是可信结果'}]}, {
                     ...body,
                     history: Array(7).fill({role: 'user', text: '旧问题'})
                   },
                   {...body, context: {url: origin}}]) {
        assert.equal((await assistantRequest(req(input), f.env)).status, 422);
      }
      assert.equal(
          (await assistantRequest(
               req({...body, message: 'x'.repeat(20000)}), f.env))
              .status,
          413);
      assert.equal(
          (await assistantRequest(new Request(url), f.env)).status, 405);
      assert.equal(f.models(), 0);
      assert.equal(f.reads.length, 0);
    });

test('真实 SSE 编解码仅引用本次工具结果，服务转发无用户凭据', async () => {
  const f = fixture(
      [{calls: [call('get_entity', {id: 'norad:1'})]}, {finish: [1]}],
      () => Response.json({
        entity_id: 'norad:1',
        display_name: '测试对象',
        source_id: 'fixture'
      }));
  const stream = [];
  await askAssistant(
      body, e => stream.push(e), new AbortController().signal,
      (path, init) => assistantRequest(
          new Request(origin + path, {
            ...init,
            headers: {
              ...init.headers,
              cookie: 'private=1',
              authorization: 'Bearer private'
            }
          }),
          f.env));
  assert.deepEqual(stream.map(e => e.event), [
    'request_started', 'step_started', 'step_started', 'tool_result',
    'step_started', 'text_delta', 'view_action', 'request_finished'
  ]);
  assert.deepEqual(stream.map(e => e.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(new Set(stream.map(e => e.request_id)).size, 1);
  assert.deepEqual(
      stream.at(-1).data, {status: 'COMPLETED', model_calls: 2, tool_calls: 1});
  assert.deepEqual(f.messages[1].results, [stream[3].data]);
  assert.deepEqual(
      stream[6].data, {action: 'select_entity', ref: 1, entity_id: 'norad:1'});
  const [{unit, r}] = f.reads;
  assert.equal(unit, 'DATA');
  assert.equal(r.url, origin + '/api/v1/satellites/norad%3A1');
  assert.equal(r.headers.get('cookie'), null);
  assert.equal(r.headers.get('authorization'), null);
  assert.equal(r.redirect, 'manual');
});

test(
    '工具、参数及引用白名单：拒绝未授权操作或历史伪造，不产生调用',
    async () => {
      for (const [plan, error] of [
               [{calls: [call('save_report')]}, 'TOOL_NOT_ALLOWED'],
               [
                 {calls: [call('search_catalog', {q: 'a', url: origin})]},
                 'UNSUPPORTED_CONSTRAINT'
               ],
               [{finish: [1]}, 'INVALID_REFERENCE'],
               [
                 {calls: [call('get_entity', {id: '../other'})]},
                 'INVALID_QUERY'
               ],
               [{view_action: {}}, 'MODEL_INVALID']]) {
        const f = fixture([plan]);
        const ev = await events(
            f, {...body, history: [{role: 'assistant', text: '[1] 上轮资料'}]});
        assert.equal(code(ev), error);
        assert.equal(f.models(), 1);
        assert.equal(f.reads.length, 0);
        assert.ok(!ev.some(e => e.event === 'view_action'));
      }
    });

test(
    '图分析限定工作台条件，缺失或擅改场景时先追问；仅完整同版本结果产生路径动作',
    async () => {
      for (const [c, args] of [
               [{}, context], [context, {scenario_id: 'other'}]]) {
        const f = fixture([{calls: [call('find_path', args)]}]);
        const ev = await events(f, {...body, context: c});
        assert.equal(ev.at(-1).data.status, 'WAITING_USER');
        assert.equal(f.reads.length, 0);
      }
      for (const [rev, complete, action] of [
               [7, true, true], [6, true, false], [7, false, false]]) {
        const f =
            fixture([{calls: [call('find_path')]}, {finish: [1]}], async r => {
              assert.deepEqual(
                  await r.json(), {...context, context_revision: 7});
              return Response.json({
                status: 'FOUND',
                context_revision: rev,
                query_execution_complete: complete,
                result_id: 'r1'
              });
            });
        const ev = await events(f, {...body, context});
        assert.equal(f.reads[0].unit, 'GRAPH');
        assert.equal(ev.some(e => e.event === 'view_action'), action);
        if (rev !== 7) {
          assert.equal(code(ev), 'TOOL_INCOMPLETE');
        }
      }
    });

test(
    '预算边界：四轮能完成，八次工具可用，第五轮及第九次工具不执行',
    async () => {
      const stat = call('catalog_statistics');
      const four = fixture([
        {calls: [stat]}, {calls: [stat]}, {calls: Array(6).fill(stat)},
        {finish: [8]}
      ]);
      assert.deepEqual(
          (await events(four)).at(-1).data,
          {status: 'COMPLETED', model_calls: 4, tool_calls: 8});
      const more = fixture(Array(5).fill({calls: [stat]}));
      assert.equal(code(await events(more)), 'LIMIT_REACHED');
      assert.equal(more.models(), 4);
      const nine = fixture([{calls: Array(8).fill(stat)}, {calls: [stat]}]);
      assert.equal(code(await events(nine)), 'LIMIT_REACHED');
      assert.equal(nine.reads.length, 8);
    });

test('上游失败或重定向不重试；只保留成功部分，不编造完成', async () => {
  for (const [status, want] of [
           [429, 'QUOTA_EXCEEDED'], [503, 'TOOL_UNAVAILABLE'],
           [307, 'TOOL_UNAVAILABLE']]) {
    let count = 0;
    const f = fixture(
        [{calls: [call('catalog_statistics'), call('catalog_statistics')]}],
        () => ++count === 1 ? Response.json({objects_with_orbit: 0}) :
                              new Response(null, {status}));
    const ev = await events(f);
    assert.equal(code(ev), want);
    assert.equal(f.models(), 1);
    assert.equal(count, 2);
    assert.equal(ev.find(e => e.event === 'error').data.partial, true);
  }
  const failed = fixture([Error('不可确定的上游结果')]);
  assert.equal(code(await events(failed)), 'MODEL_UNAVAILABLE');
  assert.equal(failed.models(), 1);
});

test('截止、请求取消及流取消均阻止迟到推理触发后续读取', async () => {
  for (const kind of ['deadline', 'request', 'stream']) {
    const gate = Promise.withResolvers();
    const started = Promise.withResolvers();
    const controller = new AbortController();
    const f = fixture([() => {
      started.resolve();
      return gate.promise;
    }]);
    const headers = {
      'content-type': 'application/json',
      accept: kind === 'stream' ? 'text/event-stream' : 'application/json'
    };
    const timer = setTimeout(() => {}, 1000);
    try {
      const pending = assistantRequest(
          req(body, {signal: controller.signal, headers}), f.env,
          kind === 'deadline' ? 20 : 1000);
      await started.promise;
      if (kind === 'request') {
        controller.abort();
      }
      if (kind === 'stream') {
        await (await pending).body.cancel();
      } else {
        assert.equal(
            code((await (await pending).json()).events),
            kind === 'request' ? 'CANCELLED' : 'TIMEOUT');
      }
      gate.resolve({calls: [call('catalog_statistics')]});
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.models(), 1);
      assert.equal(f.reads.length, 0);
    } finally {
      clearTimeout(timer);
    }
  }
});
