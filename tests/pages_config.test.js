import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import test from 'node:test';

import {renderDeployment} from '../scripts/worker_configs.js';

const b = {
  account_id: 'a'.repeat(32),
  public_hostname: 'fixture.example.test',
  turnstile_site_key: 'public_test_key',
  d1_database_id: '11111111-2222-3333-4444-555555555555',
  existing_services: {
    b2_bucket_id: 'b'.repeat(24),
    neo4j_origin: 'https://fixture.databases.neo4j.io',
    neo4j_database: 'neo4j'
  }
};

test(
    '六个 Worker、服务绑定、D1 和 Pages 均使用 prd；静态构建不带服务绑定',
    async t => {
      const parent = await mkdtemp(join(tmpdir(), 'sg-config-test-'));
      t.after(() => rm(parent, {recursive: true, force: true}));
      const output = join(parent, 'config', 'prd');
      const d1 = 'sategraph-prd-core';
      const {pages, ...roles} = await renderDeployment(
          {...b, environment: 'prd', d1_database_name: d1}, output, 'fixture',
          parent);
      assert.deepEqual(
          Object.keys(roles).sort(),
          ['api-gateway', 'assistant', 'data', 'graph', 'projector', 'sync']);
      for (const [role, cfg] of Object.entries(roles)) {
        assert.equal(cfg.name, 'sategraph-prd-' + role);
        if (['sync', 'data', 'projector'].includes(role)) {
          assert.equal(cfg.d1_databases[0].database_name, d1);
        }
        assert.equal(cfg.account_id, b.account_id);
        assert.ok((await stat(resolve(output, cfg.main))).isFile());
        for (const binding of cfg.services || []) {
          assert.ok(Object.values(roles).some(
              other => other.name === binding.service));
        }
        assert.deepEqual(
            cfg.triggers?.crons ?? [], role === 'sync' ? ['0 0 * * *'] : []);
      }
      assert.deepEqual(Object.keys(pages).sort(), [
        'account_id', 'compatibility_date', 'name', 'pages_build_output_dir'
      ]);
      assert.equal(pages.name, 'sategraph-prd-pages');
      const dist = resolve(output, pages.pages_build_output_dir);
      const files = (await readdir(dist, {recursive: true})).sort();
      for (const file of files) {
        assert.ok(
            !/(?:^|\/)(?:wrangler|config|\.env|tests|node_modules)|\.(?:ts|sql|tf)$/
                 .test(file),
            file);
      }
      const html = await readFile(join(dist, 'index.html'), 'utf8');
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
      const unique = new Set(ids);
      assert.equal(unique.size, ids.length);
      for (const match of html.matchAll(
               /\b(?:for|aria-labelledby|data-close)="([^"]+)"/g)) {
        assert.ok(unique.has(match[1]), match[1]);
      }
      for (const name
               of ['online-dialog', 'manual-query', 'online-ask',
                   'assistant-form', 'online-stop']) {
        assert.ok(unique.has(name), name);
      }
      const used = new Set();
      async function visit(file) {
        const path = resolve(dist, file);
        if (used.has(path)) {
          return;
        }
        used.add(path);
        assert.ok(path.startsWith(dist + '/'));
        const content = await readFile(path, 'utf8');
        if (!file.endsWith('.js')) {
          return;
        }
        const local = [
          ...content.matchAll(
              /(?:from\s+|new URL\(\s*|fetch\(\s*)['"](\.\.?\/[^'"]+)['"]/g)
        ].map(m => m[1]);
        for (const rel of local) {
          await visit(resolve(path, '..', rel));
        }
      }
      for (const match of html.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g)) {
        await visit(match[1]);
      }
      for (const expected of ['app.js', 'orbit-worker.js', 'data/land.json']) {
        assert.ok(used.has(join(dist, expected)), expected);
      }
      assert.deepEqual(
          files.filter(f => f.endsWith('.js')).sort(),
          ['app.js', 'orbit-worker.js']);
      for (const name of ['react', 'react-dom', 'scheduler', 'satellite.js']) {
        assert.ok((await stat(join(dist, 'licenses', name + '.txt'))).size > 0);
      }
    });
