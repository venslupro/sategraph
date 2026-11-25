import {Miniflare} from 'miniflare';
import assert from 'node:assert/strict';
import test from 'node:test';

// 仅在一次性本地 D1 运行；不接受远程数据库、账号或凭据。
test('D1 事实与 outbox 同批提交，失败整批回滚', async t => {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default {fetch() {return new Response(null)}}',
    compatibilityDate: '2025-06-01',
    cf: false,
    d1Databases: ['CORE'],
    d1Persist: false,
  });
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database('CORE');
  await db.batch([
    db.prepare(
        'CREATE TABLE fact (id TEXT PRIMARY KEY, revision INTEGER NOT NULL)'),
    db.prepare(
        'CREATE TABLE outbox (op TEXT PRIMARY KEY, revision INTEGER NOT NULL)'),
  ]);
  const update = (revision, op) => db.batch([
    db.prepare(
          'INSERT INTO fact VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision')
        .bind('F1', revision),
    db.prepare('INSERT INTO outbox VALUES (?, ?)').bind(op, revision),
  ]);
  const revision = () => db.prepare('SELECT revision FROM fact WHERE id = ?')
                             .bind('F1')
                             .first('revision');
  await update(1, 'first');
  assert.equal(await revision(), 1);
  await assert.rejects(update(2, 'first'), /unique|constraint/i);
  assert.equal(await revision(), 1);
  assert.deepEqual(
      (await db.prepare('SELECT op, revision FROM outbox').all()).results,
      [{op: 'first', revision: 1}]);
  await update(2, 'second');
  assert.equal(await revision(), 2);
  assert.equal(
      await db.prepare('SELECT COUNT(*) AS n FROM outbox').first('n'), 2);
});
