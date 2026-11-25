export interface Writer {
  runId: string;
  epoch: number
}
export interface EventRow {
  event_seq: number;
  operation_id: string;
  entity_id: string;
  revision: number;
  payload: string;
  payload_hash: string;
}
export interface Position {
  cursor: number;
  hash: string
}
export interface GraphProof extends Position, Writer {
  instance: string
}
export interface Chunk {
  instance: string;
  base: Position;
  end: Position;
  rows: EventRow[];
}

const encoder = new TextEncoder();
export const MAX_ROWS = 100;
const MAX_BYTES = 240 * 1024;  // 为图查询模板和参数信封保留空间。

async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0'))
      .join('');
}

export async function makeChunk(
    instance: string, base: Position, input: EventRow[]): Promise<Chunk|null> {
  const rows: EventRow[] = [];
  const seen = new Set<string>();
  let size = 2;
  let cursor = base.cursor;
  for (const row of input) {
    if (rows.length === MAX_ROWS || seen.has(row.entity_id)) break;
    if (!Number.isSafeInteger(row.event_seq) || row.event_seq <= cursor ||
        !Number.isSafeInteger(row.revision) || row.revision < 1)
      throw new Error('INVALID_EVENT');
    const bytes = encoder.encode(JSON.stringify(row)).length + 1;
    if (bytes + size > MAX_BYTES) {
      if (!rows.length) throw new Error('EVENT_TOO_LARGE');
      break;
    }
    size += bytes;
    rows.push(row);
    seen.add(row.entity_id);
    cursor = row.event_seq;
  }
  if (!rows.length) return null;
  await Promise.all(rows.map(async row => {
    if (await digest(row.payload) !== row.payload_hash ||
        JSON.parse(row.payload).entity_id !== row.entity_id) {
      throw new Error('PAYLOAD_MISMATCH');
    }
  }));
  const manifest = rows.map(
      r =>
          [r.event_seq, r.operation_id, r.entity_id, r.revision,
           r.payload_hash]);
  const hash = await digest(
      JSON.stringify(['orbit-v1', instance, base.cursor, base.hash, manifest]));
  return {instance, base, end: {cursor, hash}, rows};
}
