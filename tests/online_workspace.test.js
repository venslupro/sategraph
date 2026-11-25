import assert from 'node:assert/strict';
import test from 'node:test';

import {askAssistant, resolveAction} from '../src/sg-pages/online_client.js';
import {mountWorkspace, workspace} from '../src/sg-pages/online_workspace.js';

const fields = () => ({q: '示例', id: 'norad:1', context: {}});
const wire = (packets, rev = 1) =>
    packets
        .map(
            ([event, data],
             i) => 'event: ' + event + '\ndata: ' + JSON.stringify({
              event,
              request_id: 'test',
              seq: i + 1,
              context_revision: rev,
              data
            }) + '\n\n')
        .join('');
const events = [
  ['request_started', {}],
  ['tool_result', {ref: 1, tool: 'get_entity', data: {entity_id: 'norad:1'}}],
  ['text_delta', {text: '依据 [1]', refs: [1]}],
  ['view_action', {action: 'select_entity', entity_id: 'norad:1', ref: 1}],
  ['request_finished', {status: 'COMPLETED'}]
];
const sse = body =>
    new Response(body, {headers: {'content-type': 'text/event-stream'}});

test(
    '按字节分片的中文 SSE 正常解码；异版、换请求、乱序、缺结束或结束后追加均拒绝',
    async () => {
      const raw = wire(events), bytes = new TextEncoder().encode(raw);
      const seen = [];
      await askAssistant(
          {context_revision: 1}, e => seen.push(e),
          new AbortController().signal, async () => sse(new ReadableStream({
                                          start(c) {
                                            for (const b of bytes)
                                              c.enqueue(Uint8Array.of(b));
                                            c.close();
                                          }
                                        })));
      assert.equal(seen[2].data.text, '依据 [1]');
      for (const bad
               of [wire(events, 2), raw.replace('"seq":2', '"seq":3'),
                   raw.replace('"request_id":"test"', '"request_id":"wrong"'),
                   wire(events.slice(0, -1)), raw + wire(events)])
        await assert.rejects(
            askAssistant(
                {context_revision: 1}, () => {}, new AbortController().signal,
                async () => sse(bad)),
            /INTERRUPTED/);
    });

test(
    '视图动作只接受本次已引用的完整结果；流截断不应用已收到的动作',
    async () => {
      for (const [packets, want] of [
               [events, true], [events.slice(0, -1), false],
               [
                 events.map(
                     e => e[0] === 'view_action' ?
                         [e[0], {...e[1], entity_id: 'else'}] :
                         e),
                 false
               ],
               [
                 events.map(
                     e => e[0] === 'text_delta' ? [e[0], {...e[1], refs: [2]}] :
                                                  e),
                 false
               ]]) {
        let latest;
        const ws = workspace({
          fields,
          send: async () => sse(wire(packets)),
          render: s => latest = s
        });
        await ws.ask('问题');
        assert.equal(latest.views.length, want ? 1 : 0);
        if (packets.length < 5) assert.equal(latest.status, 'INTERRUPTED');
      }
      const refs = new Map([[
        1, {
          tool: 'find_path',
          data: {
            status: 'FOUND',
            context_revision: 4,
            result_id: 'r1',
            query_execution_complete: true
          }
        }
      ]]);
      const act = {action: 'show_path', result_id: 'r1', ref: 1};
      assert.ok(resolveAction(act, refs, 4));
      assert.equal(resolveAction(act, refs, 5), null);
      assert.equal(resolveAction({...act, extra: 1}, refs, 4), null);
    });

test('条件改变后旧流或手动结果不覆盖新结果；停止后不重试', async () => {
  const gate = Promise.withResolvers(), seen = [];
  let last;
  const ws = workspace({
    fields,
    render: s => last = s,
    send: async (path, init) => {
      seen.push([path, init.signal]);
      if (seen.length === 1) return gate.promise;
      return Response.json({objects_with_orbit: 3});
    }
  });
  const old = ws.ask('第一个问题');
  ws.contextChanged();
  assert.ok(seen[0][1].aborted);
  await ws.manual('statistics');
  gate.resolve(sse(wire(events)));
  await old;
  assert.equal(last.records[0].data.objects_with_orbit, 3);
  assert.equal(last.views.length, 0);
  assert.equal(seen.length, 2);
  const slow = Promise.withResolvers();
  const manual = workspace(
      {fields, render: s => last = s, send: async () => slow.promise});
  const work = manual.manual('search');
  manual.cancel();
  slow.resolve(Response.json({items: []}));
  await work;
  assert.equal(last.status, 'CANCELLED');
});

test('模型关闭后手动目录与图服务独立，不能提交缺失条件或任意地址', async () => {
  const seen = [];
  let last;
  const ws = workspace({
    fields,
    render: s => last = s,
    send: async (path, init) => {
      seen.push(path);
      assert.equal(init.credentials, 'same-origin');
      return path.endsWith('/assistant/query') ?
          Response.json({error: 'MODEL_UNAVAILABLE'}, {status: 503}) :
          Response.json({items: []});
    }
  });
  await ws.ask('问题');
  assert.equal(last.status, 'MODEL_UNAVAILABLE');
  await ws.manual('scenarios');
  assert.equal(last.records.length, 1);
  await ws.manual('search');
  assert.match(seen.at(-1), /^\/api\/v1\/catalog\/search\?/);
  await ws.manual('path');
  assert.equal(last.status, 'CONDITIONS_REQUIRED');
  await ws.manual('https://invalid.example/');
  assert.equal(last.status, 'INVALID_QUERY');
  assert.equal(seen.length, 3);
});

test(
    '底栏和展开面板共用同一有限历史，访问验证只在用户操作时加载且不重放问题',
    async () => {
      const parts = new Map();
      const node = () => ({
        value: '',
        textContent: '',
        addEventListener() {},
        replaceChildren() {},
        append() {},
        showModal() {
          this.open = true;
        }
      });
      const el = id => {
        if (!parts.has(id)) parts.set(id, node());
        return parts.get(id);
      };
      el('manual-query').elements = {namedItem: () => ({value: ''})};
      const doc = {
        getElementById: el,
        createElement: node,
        defaultView: {addEventListener() {}}
      };
      const bodies = [], calls = [];
      let widget;
      const view = mountWorkspace(doc, {
        challenge: async () => ({
          render(_el, options) {
            widget = options;
            return 'widget';
          }
        }),
        send: async (path, init) => {
          calls.push(path);
          if (path.endsWith('/config'))
            return Response.json({sitekey: 'public-key'});
          if (path.endsWith('/verify')) {
            assert.deepEqual(JSON.parse(init.body), {token: 'fixture'});
            return Response.json({verified: true});
          }
          const body = JSON.parse(init.body);
          bodies.push(body);
          return sse(wire(events, body.context_revision));
        }
      });
      assert.deepEqual(calls, []);
      await el('access-start').onclick();
      assert.equal(widget.action, 'sategraph_access');
      assert.equal(widget.sitekey, 'public-key');
      await widget.callback('fixture');
      assert.equal(calls.length, 2);
      await view.ask('底部问题');
      el('panel-query').value = '面板问题';
      await el('online-ask').onsubmit({preventDefault() {}});
      assert.equal(el('assistant-query').value, '面板问题');
      assert.deepEqual(bodies[1].history, [
        {role: 'user', text: '底部问题'}, {role: 'assistant', text: '依据 [1]'}
      ]);
      assert.ok(el('online-dialog').open);
      for (let i = 0; i < 4; i++) await view.ask('后续问题' + i);
      assert.equal(bodies.at(-1).history.length, 6);
    });
