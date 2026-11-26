import {readFile} from 'node:fs/promises';

import {parseProof} from '../../src/sg-projector/graph.ts';
import {validGraphTarget} from '../../src/sg-projector/target.ts';
import {GP_SOURCE} from '../../src/sg-sync/archive_step.ts';
import {GP_PARSER} from '../../src/sg-sync/gp_chunks.ts';
import {GP_URL} from '../../src/sg-sync/source_snapshot.ts';
import {resourceName} from '../resource_name.js';

const proof = ' RETURN c.instance_id AS instance, c.run_id AS runId, ' +
    'c.writer_epoch AS epoch, c.cursor AS cursor, c.hash AS hash';
const inspect = 'MATCH (c:GraphControl {key:\'orbit\'})' + proof + ' LIMIT 2';
const create = 'WITH 1 AS seed WHERE NOT EXISTS { MATCH (n) } ' +
    'MERGE (c:GraphControl {key:\'orbit\'}) ON CREATE SET ' +
    'c.instance_id=$instance, c.run_id=\'\', c.writer_epoch=0, c.cursor=0, c.hash=\'\'' +
    proof;

export async function initialize(bindings, results, env, send = fetch) {
  const approved = JSON.parse(env.EXISTING_SERVICES);
  const {neo4j_origin: origin, neo4j_database: db} = bindings.existing_services;
  const instance = env.GRAPH_INSTANCE;
  if (bindings.environment !== 'prd' ||
      bindings.account_id !== env.CLOUDFLARE_ACCOUNT_ID ||
      bindings.d1_database_name !== resourceName('prd', 'core') ||
      !validGraphTarget(origin, db) || origin !== approved.neo4j_origin ||
      db !== approved.neo4j_database || !instance ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(instance) ||
      !/^Basic [A-Za-z0-9+/]+=*$/.test(env.GRAPH_BOOTSTRAP_AUTH)) {
    throw new Error('生产图目标、实例标识或部署凭据不匹配');
  }
  const d1 = results?.[0]?.results?.[0];
  if (results?.length !== 1 || results[0].success !== true ||
      results[0].results?.length !== 1 || d1.source_id !== GP_SOURCE ||
      d1.source_url !== GP_URL || d1.parser_version !== GP_PARSER ||
      (d1.instance_id !== null && d1.instance_id !== instance)) {
    throw new Error('D1 来源登记或投影实例不匹配');
  }

  let bookmarks = [];
  async function query(statement, accessMode, parameters = {}) {
    const response = await send(origin + '/db/' + db + '/query/v2', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
      headers: {
        authorization: env.GRAPH_BOOTSTRAP_AUTH,
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({statement, parameters, accessMode, bookmarks})
    });
    if (!response.ok) {
      throw new Error('图元数据请求失败：HTTP ' + response.status);
    }
    const body = await response.json();
    if (body.transaction != null ||
        (body.errors && (!Array.isArray(body.errors) || body.errors.length)) ||
        !Array.isArray(body.bookmarks) || !body.bookmarks.length ||
        !body.bookmarks.every(b => typeof b === 'string' && b.length)) {
      throw new Error('图元数据事务未确认，请核对后重跑');
    }
    bookmarks = body.bookmarks;
    return body;
  }
  let state = await query(inspect, 'Read');
  const emptyControl =
      Array.isArray(state.data?.values) && state.data.values.length === 0;
  if (emptyControl) {
    if (env.INITIALIZE_EMPTY_GRAPH !== 'true' || d1.pristine !== 1 ||
        (await query('RETURN NOT EXISTS { MATCH (n) } AS empty', 'Read'))
                .data?.values?.[0]
                ?.[0] !== true) {
      throw new Error(
          '缺少图控制节点；仅能在明确授权且 D1 无运行记录、目标图为空时初始化');
    }
    await query(
        'CREATE CONSTRAINT IF NOT EXISTS FOR (n:GraphControl) REQUIRE n.key IS UNIQUE',
        'Write');
    state = await query(create, 'Write', {instance});
  }
  const saved = parseProof(state, instance);
  const acknowledged = saved.cursor === (d1.acknowledged ?? 0) &&
      saved.hash === (d1.last_hash ?? '');
  const pending =
      saved.cursor === d1.pending_end && saved.hash === d1.pending_hash;
  if (!acknowledged && !pending) {
    throw new Error('图游标与 D1 不一致，不会覆盖已有状态');
  }
  for (const [label, key] of [
           ['GraphControl', 'key'], ['Entity', 'entity_id'],
           ['TopologyScenario', 'scenario_id']]) {
    if (emptyControl && label === 'GraphControl') {
      continue;
    }
    await query(
        'CREATE CONSTRAINT IF NOT EXISTS FOR (n:' + label + ') REQUIRE n.' +
            key + ' IS UNIQUE',
        'Write');
  }
}

if (import.meta.main) {
  const [bindings, results] = await Promise.all(process.argv.slice(2).map(
      async path => JSON.parse(await readFile(path, 'utf8'))));
  await initialize(bindings, results, process.env);
  console.log('生产来源登记、图实例、投影游标和唯一约束已核验。');
}
