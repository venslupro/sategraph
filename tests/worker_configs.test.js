import assert from 'node:assert/strict';
import test from 'node:test';

import {renderConfigs} from '../scripts/worker_configs.js';

const fixture = {
  account_id: 'a'.repeat(32),
  environment: 'dev',
  d1_database_id: '11111111-2222-3333-4444-555555555555',
  d1_database_name: 'sategraph-dev-core',
  public_hostname: 'dev.example.test',
  turnstile_site_key: 'fixture_public_sitekey',
  secret: 'never-copy-this',
  existing_services: {
    b2_bucket_id: 'b'.repeat(24),
    neo4j_origin: 'https://fixture.databases.neo4j.io',
    neo4j_database: 'neo4j'
  }
};
test(
    '同环境绑定同一 D1；API 网关不持写绑定，图和归档配置相互隔离', async () => {
      const {sync, projector, data, graph, assistant, 'api-gateway': gateway} =
          await renderConfigs(fixture, 'dist/config/dev', 'isolated');
      assert.deepEqual(sync.d1_databases, projector.d1_databases);
      assert.equal(sync.services[0].service, projector.name);
      assert.equal(gateway.services[0].service, sync.name);
      assert.equal(gateway.services[0].entrypoint, 'StatusReader');
      assert.deepEqual(gateway.services.slice(1), [
        {binding: 'DATA', service: data.name, entrypoint: 'CatalogReader'},
        {binding: 'GRAPH', service: graph.name, entrypoint: 'GraphReader'},
        {
          binding: 'ASSISTANT',
          service: assistant.name,
          entrypoint: 'AssistantReader'
        },
      ]);
      assert.deepEqual(assistant.services, gateway.services.slice(1, 3));
      assert.deepEqual(assistant.vars, {APPROVED_MODEL: ''});
      for (const key of ['ai', 'd1_databases', 'durable_objects', 'triggers'])
        assert.equal(assistant[key], undefined);
      assert.deepEqual(sync.services.slice(1), [
        {binding: 'FACTS', service: data.name, entrypoint: 'FactCommands'},
      ]);
      assert.deepEqual(data.d1_databases, sync.d1_databases);
      assert.deepEqual(data.vars, {DISPLAY_SOURCES: ''});
      assert.equal(data.services, undefined);
      assert.equal(gateway.d1_databases, undefined);
      assert.equal(sync.vars.GRAPH_ORIGIN, undefined);
      assert.equal(projector.vars.B2_BUCKET_ID, undefined);
      assert.deepEqual(gateway.vars, {
        PUBLIC_HOSTNAME: fixture.public_hostname,
        TURNSTILE_SITE_KEY: fixture.turnstile_site_key
      });
      assert.equal(graph.vars.DISPLAY_SOURCES, '');
      assert.equal(graph.vars.GRAPH_INSTANCE, projector.vars.GRAPH_INSTANCE);
      assert.equal(graph.d1_databases, undefined);
      assert.equal(graph.services, undefined);
      assert.ok(
          !JSON.stringify([sync, projector, gateway]).includes(fixture.secret));
    });
test('拒绝混用环境、缺失图实例标识和带凭据的端点', async () => {
  await assert.rejects(renderConfigs(fixture, 'dist/config/dev'));
  for (const f of [{...fixture, environment: 'prod'}, {
         ...fixture,
         existing_services: {
           ...fixture.existing_services,
           neo4j_origin: 'https://user:pass@fixture.databases.neo4j.io'
         }
       }])
    await assert.rejects(renderConfigs(f, 'dist/config/dev', 'isolated'));
});
