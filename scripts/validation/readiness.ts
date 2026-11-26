import {probeObject, validObjectTarget} from './b2.ts';
import {probeGraph, validGraphTarget} from './neo4j.ts';

export type Target = 'neo4j'|'b2';
type Environment = Readonly<Record<string, string|undefined>>;

const VARIABLES = {
  neo4j: [
    'SG_A2_NEO4J_ORIGIN', 'SG_A2_NEO4J_DATABASE', 'SG_A2_NEO4J_AUTHORIZATION'
  ],
  b2: [
    'SG_A2_B2_API_ORIGIN', 'SG_A2_B2_BUCKET_ID', 'SG_A2_B2_FILE_ID',
    'SG_A2_B2_TOKEN'
  ],
} as const;

const SAFE_CODES = new Set([
  'QUERY_FAILED',
  'INVALID_OPEN_RESPONSE',
  'COMMIT_UNKNOWN',
  'OBJECT_READ_FAILED',
  'INVALID_OBJECT_METADATA',
]);

/** 返回缺项名称和固定状态，不序列化地址、文件 ID、凭据或供应商报错。 */
export async function inspectTarget(
    target: Target, env: Environment, live = false,
    send: typeof fetch = fetch) {
  const keys = VARIABLES[target];
  const missing = keys.filter(key => !env[key]?.trim());
  if (missing.length) {
    return {target, status: 'BLOCKED', missing} as const;
  }

  let run: () => Promise<unknown>;
  if (target === 'neo4j') {
    const [origin, database, auth] =
        VARIABLES.neo4j.map(key => env[key]!) as [string, string, string];
    if (!validGraphTarget(origin, database) ||
        !/^Basic [A-Za-z0-9+/]+=*$/.test(auth)) {
      return {target, status: 'INVALID_CONFIG'} as const;
    }
    run = () => probeGraph(origin, database, auth, send);
  } else {
    const [origin, bucket, file, token] =
        VARIABLES.b2.map(key => env[key]!) as [string, string, string, string];
    if (!validObjectTarget(origin, bucket, file) || !/^[!-~]+$/.test(token)) {
      return {target, status: 'INVALID_CONFIG'} as const;
    }
    run = () => probeObject(origin, token, bucket, file, send);
  }
  if (!live) {
    return {target, status: 'READY_OFFLINE'} as const;
  }
  try {
    await run();
    return {target, status: 'CONFIRMED'} as const;
  } catch (error) {
    const code = error instanceof Error && SAFE_CODES.has(error.message) ?
        error.message :
        'PROBE_FAILED';
    return {
      target,
      status: code === 'COMMIT_UNKNOWN' ? 'UNKNOWN' : 'FAILED',
      code
    } as const;
  }
}
