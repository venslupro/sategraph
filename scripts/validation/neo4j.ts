import {validGraphTarget} from '../../src/sg-projector/target.ts';

export {validGraphTarget} from '../../src/sg-projector/target.ts';

/** 只探测固定常量查询；不允许调用方传入 Cypher，不自动重试。 */
export async function probeGraph(
    origin: string, database: string, authorization: string,
    send: typeof fetch = fetch): Promise<'CONFIRMED'> {
  if (!validGraphTarget(origin, database)) {
    throw new Error('INVALID_ENDPOINT');
  }
  const endpoint = origin + '/db/' + database + '/query/v2/tx';
  const headers = new Headers({
    authorization,
    'content-type': 'application/json',
    accept: 'application/json'
  });
  const signal = AbortSignal.timeout(8000);
  const request = (url: string, body?: object) => send(url, {
    method: 'POST',
    headers,
    signal,
    redirect: 'error',
    body: JSON.stringify(body),
  });
  const opened = await request(
      endpoint, {statement: 'RETURN 1 AS probe', accessMode: 'Read'});
  if (!opened.ok) {
    throw new Error('QUERY_FAILED');
  }
  const reply = await opened.json().catch(() => null) as GraphResponse | null;
  const id = reply?.transaction?.id;
  const affinity = opened.headers.get('neo4j-cluster-affinity');
  if (!reply || hasErrors(reply) || typeof id !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(id) || !affinity ||
      reply.data?.fields?.[0] !== 'probe' ||
      reply.data?.values?.[0]?.[0] !== 1) {
    throw new Error('INVALID_OPEN_RESPONSE');
  }
  headers.set('neo4j-cluster-affinity', affinity);
  // 即使 HTTP 成功，空响应、断流或缺少最终书签也不能视为提交确认。
  const committed = await request(endpoint + '/' + id + '/commit').catch(() => {
    throw new Error('COMMIT_UNKNOWN');
  });
  if (!committed.ok) {
    throw new Error('COMMIT_UNKNOWN');
  }
  const result =
      await committed.json().catch(() => null) as GraphResponse | null;
  if (!result || result.transaction != null || hasErrors(result) ||
      !Array.isArray(result.bookmarks) || result.bookmarks.length === 0 ||
      !result.bookmarks.every(b => typeof b === 'string' && b.length > 0)) {
    throw new Error('COMMIT_UNKNOWN');
  }
  return 'CONFIRMED';
}

interface GraphResponse {
  transaction?: {id?: string};
  data?: {fields?: string[]; values?: unknown[][]};
  errors?: unknown;
  bookmarks?: unknown[];
}

function hasErrors(reply: GraphResponse): boolean {
  return reply.errors !== undefined &&
      (!Array.isArray(reply.errors) || reply.errors.length !== 0);
}
