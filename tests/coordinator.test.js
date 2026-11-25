import {Miniflare} from 'miniflare';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const day = 86_400_000;
const slot = Date.UTC(2099, 0, 1);
const entry = [
  'import {admit, resume, readStatus} from \'./coordinator.mjs\';',
  'export class Harness {',
  '  constructor(ctx) { this.db = ctx.storage; }',
  '  alarm() { return resume(this.db); }',
  '  async fetch(request) {',
  '    const {action, now, slot, cron, outcome} = await request.json();',
  '    if (action === "start") return Response.json(await admit(this.db, cron, slot, now));',
  '    if (action === "resume") await resume(this.db, outcome ? async () => outcome : undefined, () => now);',
  '    if (action === "inspect") return Response.json({entries: Object.fromEntries(await this.db.list()), alarm: await this.db.getAlarm()});',
  '    return Response.json(await readStatus(this.db));',
  '  }',
  '}',
  'export default {fetch(req, env) {return env.TEST.get(env.TEST.idFromName(new URL(req.url).pathname)).fetch(req);}};',
].join('\n');

test('SQLite Durable Object 的定时权限和持久终态', async t => {
  const source = await readFile(
      new URL('../src/sg-sync/coordinator.ts', import.meta.url), 'utf8');
  const js =
      ts.transpileModule(source, {
          compilerOptions:
              {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}
        }).outputText;
  const mf = new Miniflare({
    compatibilityDate: '2026-07-01',
    cf: false,
    modules: [
      {type: 'ESModule', path: 'entry.mjs', contents: entry},
      {type: 'ESModule', path: 'coordinator.mjs', contents: js}
    ],
    durableObjects: {TEST: {className: 'Harness', useSQLite: true}},
    durableObjectsPersist: false
  });
  t.after(() => mf.dispose());
  const call = async (name, action, input = {}) => {
    const res = await mf.dispatchFetch('http://test/' + name, {
      method: 'POST',
      body:
          JSON.stringify({action, now: slot, slot, cron: '0 0 * * *', ...input})
    });
    const body = await res.text();
    assert.equal(res.status, 200, body);
    return JSON.parse(body);
  };
  await t.test('冷读零写，拒绝非槽、过期和任意触发', async () => {
    assert.equal((await call('cold', 'read')).run_status, 'NEVER_RUN');
    for (const input
             of [{cron: '* * * * *'}, {slot: slot + 1}, {now: slot + 300001}]) {
      assert.equal(await call('cold', 'start', input), 'INVALID_SLOT');
    }
    await call('cold', 'resume');
    assert.deepEqual(await call('cold', 'inspect'), {entries: {}, alarm: null});
  });
  await t.test('同槽并发仅开一轮，跨日跳过的新槽不会补开', async () => {
    assert.deepEqual(
        (await Promise.all([call('long', 'start'), call('long', 'start')]))
            .sort(),
        ['DUPLICATE', 'STARTED']);
    const next = {now: slot + day, slot: slot + day};
    assert.equal(await call('long', 'start', next), 'BUSY');
    const state = await call(
        'long', 'resume',
        {...next, outcome: {kind: 'progress', checkpoint: 1}});
    assert.equal(state.run_status, 'RUNNING');
    assert.equal(state.attempt_no, 0);
    const done = await call(
        'long', 'resume',
        {...next, outcome: {kind: 'verified', publication_id: 'test-pub'}});
    assert.equal(done.last_complete_publication_id, 'test-pub');
    assert.equal(await call('long', 'start', next), 'DUPLICATE');
  });
  await t.test(
      '四次失败后封存，退避期间不写，下一合法槽使用新身份', async () => {
        await call('retry', 'start');
        let now = slot;
        const outcome = {kind: 'safe_retry'};
        for (const [index, delay] of [30000, 120000, 300000].entries()) {
          const waiting = await call('retry', 'resume', {now, outcome});
          assert.equal(waiting.phase, 'RETRY_WAIT');
          assert.equal(waiting.attempt_no, index + 1);
          const snapshot = await call('retry', 'inspect');
          assert.equal(snapshot.alarm, now + delay);
          await call('retry', 'resume', {now: now + delay - 1, outcome});
          assert.deepEqual(await call('retry', 'inspect'), snapshot);
          now += delay;
        }
        const failed = await call('retry', 'resume', {now, outcome});
        assert.equal(failed.error, 'RETRIES_EXHAUSTED');
        assert.equal(failed.attempt_no, 3);
        const terminal = await call('retry', 'inspect');
        assert.equal(terminal.alarm, null);
        assert.equal(
            Object.keys(terminal.entries)
                .filter(k => k.startsWith('failure:'))
                .length,
            4);
        await call(
            'retry', 'resume',
            {now, outcome: {kind: 'verified', publication_id: 'late'}});
        assert.deepEqual(await call('retry', 'inspect'), terminal);
        assert.equal(
            await call('retry', 'start', {slot: slot + day, now: slot + day}),
            'STARTED');
        const next = await call('retry', 'inspect');
        assert.notEqual(
            next.entries.current.run_id, terminal.entries.current.run_id);
        assert.equal(
            next.entries['end:' + terminal.entries.current.run_id].run_status,
            'FAILED');
      });
  await t.test('没有业务绑定不能成功，提交未知不盲重放', async () => {
    await call('missing', 'start');
    assert.equal(
        (await call('missing', 'resume')).error, 'PIPELINE_NOT_CONFIGURED');
    await call('unknown', 'start');
    const unknown =
        await call('unknown', 'resume', {outcome: {kind: 'unknown'}});
    assert.equal(unknown.data_quality, 'UNKNOWN');
    assert.equal(unknown.run_status, 'FAILED');
    assert.equal(unknown.last_complete_success_at, null);
  });
});
