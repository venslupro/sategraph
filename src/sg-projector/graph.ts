import type {Chunk, GraphProof, Position, Writer} from './chunk.ts';
import {validGraphTarget} from './target.ts';

export interface GraphPort {
  inspect(): Promise<GraphProof>;
  claim(writer: Writer, base: Position, pendingEnd?: Position):
      Promise<GraphProof>;
  apply(writer: Writer, chunk: Chunk): Promise<GraphProof>;
}

const CONTROL =
    'MATCH (c:GraphControl {key: \'orbit\', instance_id: $instance})';
// 先取得控制节点写锁，再读代际和游标；接管和业务写使用同一把锁。
const LOCK =
    CONTROL + '\nSET c._writer_lock = true REMOVE c._writer_lock WITH c';
const PROOF = 'RETURN c.instance_id AS instance, c.run_id AS runId, ' +
    'c.writer_epoch AS epoch, c.cursor AS cursor, c.hash AS hash';
const INSPECT = CONTROL + '\n' + PROOF;
const CLAIM = LOCK + '\nWHERE c.writer_epoch < $epoch ' +
    'AND any(p IN $positions WHERE p.cursor = c.cursor AND p.hash = c.hash) ' +
    'SET c.writer_epoch = $epoch, c.run_id = $runId\n' + PROOF;
const APPLY = [
  LOCK,
  'WHERE c.writer_epoch = $epoch AND c.run_id = $runId AND c.cursor = $baseCursor AND c.hash = $baseHash',
  'UNWIND $rows AS r OPTIONAL MATCH (n:Entity {entity_id: r.entity_id})',
  'WITH c, collect({row:r, prior:coalesce(n.orbit_revision, 0)}) AS batch',
  'WHERE size(batch) = size($rows) AND all(item IN batch WHERE item.prior = item.row.revision - 1)',
  'UNWIND batch AS item WITH c, item.row AS r',
  'MERGE (n:Entity {entity_id: r.entity_id}) SET n:Satellite, n.orbit_revision = r.revision,',
  'n.orbit_payload = r.payload, n.orbit_hash = r.payload_hash,',
  'n.orbit_evidence_id = r.evidence_id, n.source_ids = CASE',
  'WHEN r.source_id IN coalesce(n.source_ids, []) THEN n.source_ids',
  'ELSE coalesce(n.source_ids, []) + [r.source_id] END',
  'WITH DISTINCT c SET c.cursor = $endCursor, c.hash = $endHash',
  PROOF,
].join('\n');

interface ResponseBody {
  errors?: unknown;
  bookmarks?: unknown;
  transaction?: unknown;
  data?: {fields?: unknown; values?: unknown};
}

export function parseProof(body: ResponseBody, instance: string): GraphProof {
  const rows = body.data?.values;
  const fields = body.data?.fields;
  if (!Array.isArray(fields) ||
      JSON.stringify(fields) !==
          '["instance","runId","epoch","cursor","hash"]' ||
      !Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0]) ||
      rows[0].length !== 5) {
    throw new Error('GRAPH_PROOF_MISSING');
  }
  const [id, runId, epoch, cursor, hash] = rows[0];
  if (id !== instance || typeof runId !== 'string' ||
      !Number.isSafeInteger(epoch) || epoch < 0 ||
      (epoch === 0 ? runId !== '' :
                     !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(runId)) ||
      !Number.isSafeInteger(cursor) || cursor < 0 || typeof hash !== 'string' ||
      (cursor === 0 ? hash !== '' : !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('GRAPH_PROOF_INVALID');
  }
  return {instance: id, runId, epoch, cursor, hash};
}

/** 每次写仅用一个隐式事务；读完有书签的完整响应才返回证明。 */
export function graphPort(
    origin: string, database: string, auth: string, instance: string,
    send: typeof fetch = fetch): GraphPort {
  if (!validGraphTarget(origin, database) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(instance) ||
      !/^Basic [A-Za-z0-9+/]+=*$/.test(auth)) {
    throw new Error('INVALID_GRAPH_CONFIG');
  }
  const endpoint = origin + '/db/' + database + '/query/v2';
  async function query(statement: string, parameters: object, writes: boolean):
      Promise<GraphProof> {
    const body = JSON.stringify({
      statement,
      parameters: {instance, ...parameters},
      accessMode: writes ? 'Write' : 'Read'
    });
    if (new TextEncoder().encode(body).length > 256 * 1024) {
      throw new Error('CHUNK_TOO_LARGE');
    }
    try {
      const res = await send(endpoint, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
        headers: {
          authorization: auth,
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body
      });
      if (!res.ok) {
        throw new Error('GRAPH_HTTP_ERROR');
      }
      const data = await res.json() as ResponseBody;
      if (!data || data.transaction != null ||
          (data.errors !== undefined &&
           (!Array.isArray(data.errors) || data.errors.length)) ||
          !Array.isArray(data.bookmarks) || !data.bookmarks.length ||
          !data.bookmarks.every(b => typeof b === 'string' && b.length > 0)) {
        throw new Error('GRAPH_INCOMPLETE');
      }
      return parseProof(data, instance);
    } catch {
      // 不把超时、空结果或拒绝误认成已提交；不回显服务端载荷或自动重试。
      throw new Error(
          writes ? 'GRAPH_COMMIT_UNCONFIRMED' : 'GRAPH_READ_UNCONFIRMED');
    }
  }
  return {
    inspect: () => query(INSPECT, {}, false),
    claim: (w, base, end) => query(
        CLAIM,
        {epoch: w.epoch, runId: w.runId, positions: end ? [base, end] : [base]},
        true),
    apply: (w, c) => {
      if (c.instance !== instance) {
        throw new Error('INSTANCE_MISMATCH');
      }
      return query(
          APPLY, {
            epoch: w.epoch,
            runId: w.runId,
            baseCursor: c.base.cursor,
            baseHash: c.base.hash,
            endCursor: c.end.cursor,
            endHash: c.end.hash,
            rows: c.rows.map(row => {
              const payload = JSON.parse(row.payload);
              if (payload.entity_id !== row.entity_id ||
                  ![payload.source_id, payload.evidence_id].every(
                      v => typeof v === 'string' &&
                          /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v))) {
                throw new Error('INVALID_ORBIT_PROVENANCE');
              }
              return {
                ...row,
                source_id: payload.source_id,
                evidence_id: payload.evidence_id
              };
            })
          },
          true);
    },
  };
}
