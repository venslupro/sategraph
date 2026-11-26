import {text} from 'node:stream/consumers';

import {validGraphTarget} from '../../src/sg-projector/target.ts';

/** 在生成发布配置前，用独立的生产环境清单核对 Terraform 输出。 */
export function verifyBindings(bindings, env) {
  if (bindings.environment !== 'prd' || !env.CLOUDFLARE_ACCOUNT_ID ||
      bindings.account_id !== env.CLOUDFLARE_ACCOUNT_ID ||
      !env.PUBLIC_HOSTNAME ||
      bindings.public_hostname !== env.PUBLIC_HOSTNAME) {
    throw new Error('绑定不属于指定生产账号、域名或环境');
  }
  const approved = JSON.parse(env.EXISTING_SERVICES);
  const services = bindings.existing_services;
  if (typeof services?.b2_bucket_id !== 'string' ||
      !/^[a-f0-9]{24}$/.test(services.b2_bucket_id) ||
      services.b2_bucket_id !== approved?.b2_bucket_id) {
    throw new Error('业务归档桶 ID 无效或与生产配置不一致');
  }
  if (typeof services.neo4j_origin !== 'string' ||
      typeof services.neo4j_database !== 'string' ||
      !validGraphTarget(services.neo4j_origin, services.neo4j_database) ||
      services.neo4j_origin !== approved?.neo4j_origin ||
      services.neo4j_database !== approved?.neo4j_database) {
    throw new Error('图源站或数据库无效或与生产配置不一致');
  }
}

if (import.meta.main) {
  const bindings = JSON.parse(await text(process.stdin));
  verifyBindings(bindings, process.env);
  console.log(JSON.stringify(bindings));
}
