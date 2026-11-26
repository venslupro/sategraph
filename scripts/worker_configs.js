import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {relative, resolve} from 'node:path';
import {text} from 'node:stream/consumers';
import {fileURLToPath} from 'node:url';

import {validGraphTarget} from '../src/sg-projector/target.ts';

import {buildPages} from './build_pages.js';
import {resourceName} from './resource_name.js';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const hostname =
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export async function renderConfigs(b, output, instance) {
  const s = b.existing_services;
  const coreName = resourceName(b.environment, 'core');
  if (!/^[0-9a-f]{32}$/.test(b.account_id) ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(b.d1_database_id) ||
      b.d1_database_name !== coreName ||
      typeof b.public_hostname !== 'string' || b.public_hostname.length > 253 ||
      !hostname.test(b.public_hostname) ||
      typeof b.turnstile_site_key !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(b.turnstile_site_key) || !s ||
      !/^[0-9a-f]{24}$/.test(s.b2_bucket_id) ||
      !validGraphTarget(s.neo4j_origin, s.neo4j_database) ||
      typeof instance !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(instance)) {
    throw new Error('无效的环境、图实例标识或 Terraform 绑定输出');
  }
  const db = {
    binding: 'CORE',
    database_name: b.d1_database_name,
    database_id: b.d1_database_id,
    migrations_dir:
        relative(output, resolve(root, 'sg-sync/storage/migrations'))
  };
  const configs = {};
  const roles = {
    sync: {core: true, vars: {B2_BUCKET_ID: s.b2_bucket_id}},
    projector: {
      core: true,
      vars: {
        GRAPH_ORIGIN: s.neo4j_origin,
        GRAPH_DATABASE: s.neo4j_database,
        GRAPH_INSTANCE: instance,
      }
    },
    data: {core: true},
    assistant: {},
    graph: {
      vars: {
        GRAPH_ORIGIN: s.neo4j_origin,
        GRAPH_DATABASE: s.neo4j_database,
        GRAPH_INSTANCE: instance
      }
    },
    'api-gateway': {
      vars: {
        PUBLIC_HOSTNAME: b.public_hostname,
        TURNSTILE_SITE_KEY: b.turnstile_site_key
      }
    },
  };
  const names = new Set(
      Object.keys(roles).map(unit => resourceName(b.environment, unit)));
  for (const [unit, role] of Object.entries(roles)) {
    const serviceDir = resolve(root, 'sg-' + unit);
    const config = JSON.parse(
        await readFile(resolve(serviceDir, 'wrangler.template.jsonc'), 'utf8'));
    config.main = relative(output, resolve(serviceDir, config.main));
    if (config.name !== resourceName(b.environment, unit)) {
      throw new Error('Worker 模板名称与模块不符：' + unit);
    }
    config.account_id = b.account_id;
    for (const link of config.services ?? []) {
      if (!names.has(link.service)) {
        throw new Error('未知的 Worker 绑定目标：' + link.service);
      }
    }
    if (role.core) {
      config.d1_databases = [db];
    }
    if (role.vars) {
      config.vars = {...config.vars, ...role.vars};
    }
    configs[unit] = config;
  }
  return configs;
}

/** 为同一环境生成静态 Pages 配置；公开目录只指向本次新构建。 */
export async function renderDeployment(b, output, instance, buildParent) {
  const workers = await renderConfigs(b, output, instance);
  const assets = await buildPages(resolve(buildParent));
  const pages = {
    name: resourceName(b.environment, 'pages'),
    account_id: b.account_id,
    compatibility_date: workers['api-gateway'].compatibility_date,
    pages_build_output_dir: relative(output, assets)
  };
  return {...workers, pages};
}

if (import.meta.main) {
  const input = JSON.parse(await text(process.stdin));
  const output = resolve('dist/config', String(input.environment));
  const configs =
      await renderDeployment(input, output, process.env.GRAPH_INSTANCE, 'dist');
  await mkdir(output, {recursive: true});
  for (const [unit, config] of Object.entries(configs)) {
    await writeFile(
        resolve(output, unit + '.json'),
        JSON.stringify(config, null, 2) + String.fromCharCode(10));
  }
  console.log('已生成本地配置：' + output);
}
