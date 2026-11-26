import {type Chunk, type EventRow, type GraphProof, makeChunk, MAX_ROWS, type Position, type Writer} from './chunk.ts';

interface CursorRow {
  instance_id: string;
  acknowledged: number;
  last_hash: string;
  pending_end: number|null;
  pending_hash: string|null;
  pending_run: string|null;
  pending_epoch: number|null;
}

const OWNER =
    'EXISTS (SELECT 1 FROM command_control WHERE singleton=1 AND active=1 AND run_id=? AND writer_epoch=?)';
const STATE = 'FROM projection_cursor WHERE stream=\'orbit\'';

export async function snapshot(
    db: D1Database, writer: Writer, instance: string) {
  const [owner, state, events] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT 1 WHERE ' + OWNER).bind(writer.runId, writer.epoch),
    db.prepare('SELECT * ' + STATE),
    db.prepare(
          'SELECT * FROM projection_outbox WHERE event_seq > COALESCE((SELECT acknowledged ' +
          STATE + '), 0) AND event_seq <= COALESCE((SELECT pending_end ' +
          STATE + '), 9223372036854775807) ORDER BY event_seq LIMIT ?')
        .bind(MAX_ROWS),
  ]);
  if (!owner!.results.length) {
    throw new Error('FENCED');
  }
  const saved = state!.results[0] as unknown as CursorRow | undefined;
  if (saved && saved.instance_id !== instance) {
    throw new Error('INSTANCE_MISMATCH');
  }
  const base = {cursor: saved?.acknowledged ?? 0, hash: saved?.last_hash ?? ''};
  const chunk =
      await makeChunk(instance, base, events!.results as unknown as EventRow[]);
  const pending = saved?.pending_end != null;
  if (pending &&
      (!chunk || chunk.end.cursor !== saved.pending_end ||
       chunk.end.hash !== saved.pending_hash)) {
    throw new Error('PENDING_MANIFEST_CHANGED');
  }
  return {
    chunk,
    base,
    pending,
    pendingEpoch: saved?.pending_epoch,
    pendingRun: saved?.pending_run
  };
}

export async function reserve(db: D1Database, w: Writer, c: Chunk) {
  const insert = db.prepare(
                       'INSERT INTO projection_cursor (stream, instance_id) ' +
                       'SELECT \'orbit\', ? WHERE ' + OWNER +
                       ' ON CONFLICT(stream) DO NOTHING')
                     .bind(c.instance, w.runId, w.epoch);
  const update =
      db.prepare(
            'UPDATE projection_cursor SET pending_end=?, pending_hash=?, pending_run=?, pending_epoch=? ' +
            'WHERE stream=\'orbit\' AND instance_id=? AND acknowledged=? AND last_hash=? AND pending_end IS NULL AND ' +
            OWNER)
          .bind(
              c.end.cursor, c.end.hash, w.runId, w.epoch, c.instance,
              c.base.cursor, c.base.hash, w.runId, w.epoch);
  const result = await db.batch([insert, update]);
  return result[1]!.meta.changes === 1;
}

function requireProof(
    w: Writer, instance: string, pos: Position, proof: GraphProof) {
  if (proof.instance !== instance || proof.runId !== w.runId ||
      proof.epoch !== w.epoch || proof.cursor !== pos.cursor ||
      proof.hash !== pos.hash) {
    throw new Error('PROOF_MISMATCH');
  }
}

/** 只有图端已在锁内切换到更高代际后，才能接手上一代未提交的分片。 */
export async function takeOver(
    db: D1Database, w: Writer, c: Chunk, proof: GraphProof) {
  requireProof(w, c.instance, c.base, proof);
  const res =
      await db
          .prepare(
              'UPDATE projection_cursor SET pending_run=?, pending_epoch=? ' +
              'WHERE stream=\'orbit\' AND instance_id=? AND acknowledged=? AND last_hash=? AND pending_end=? ' +
              'AND pending_hash=? AND pending_epoch < ? AND ' + OWNER)
          .bind(
              w.runId, w.epoch, c.instance, c.base.cursor, c.base.hash,
              c.end.cursor, c.end.hash, w.epoch, w.runId, w.epoch)
          .run();
  return res.meta.changes === 1;
}

export async function acknowledge(
    db: D1Database, w: Writer, c: Chunk, proof: GraphProof) {
  requireProof(w, c.instance, c.end, proof);
  const res =
      await db
          .prepare(
              'UPDATE projection_cursor SET acknowledged=pending_end, last_hash=pending_hash, ' +
              'pending_end=NULL, pending_hash=NULL, pending_run=NULL, pending_epoch=NULL ' +
              'WHERE stream=\'orbit\' AND instance_id=? AND acknowledged=? AND last_hash=? AND pending_end=? AND pending_hash=? AND ' +
              OWNER)
          .bind(
              c.instance, c.base.cursor, c.base.hash, c.end.cursor, c.end.hash,
              w.runId, w.epoch)
          .run();
  return res.meta.changes === 1;
}
