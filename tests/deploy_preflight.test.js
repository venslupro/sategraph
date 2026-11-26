import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const cli =
    fileURLToPath(new URL('../scripts/deploy/preflight.js', import.meta.url));
const services = {
  b2_bucket_id: 'b'.repeat(24),
  neo4j_origin: 'https://example.databases.neo4j.io',
  neo4j_database: 'neo4j',
};
const bindings = {
  environment: 'prd',
  account_id: 'a'.repeat(32),
  public_hostname: 'fixture.example.test',
  existing_services: services,
};

function run(state = bindings, approved = JSON.stringify(services)) {
  return spawnSync(process.execPath, [cli], {
    input: JSON.stringify(state),
    encoding: 'utf8',
    env: {
      CLOUDFLARE_ACCOUNT_ID: bindings.account_id,
      PUBLIC_HOSTNAME: bindings.public_hostname,
      EXISTING_SERVICES: approved,
    },
  });
}

test('生产目标全部匹配才输出原始绑定', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), bindings);
});

test('任一目标漂移、缺失或无效时，预检失败且不输出绑定', () => {
  for (const [key, drift] of Object.entries({
         b2_bucket_id: 'c'.repeat(24),
         neo4j_origin: 'https://other.databases.neo4j.io',
         neo4j_database: 'other',
       })) {
    for (const value of [drift, undefined]) {
      const result =
          run({...bindings, existing_services: {...services, [key]: value}});
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
    }
  }
  for (const result
           of [run({...bindings, environment: 'stg'}),
               run({...bindings, account_id: 'c'.repeat(32)}),
               run({...bindings, public_hostname: 'other.example.test'}),
               run(bindings, '{}'), run(bindings, '{'),
               run({
                 ...bindings,
                 existing_services: {...services, neo4j_database: ''}
               },
                   JSON.stringify({...services, neo4j_database: ''}))]) {
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
});
