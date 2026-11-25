import type {ArchivePort} from './b2_archive.ts';
import {fetchSnapshot, type RawSnapshot} from './source_snapshot.ts';

interface Writer {
  runId: string;
  epoch: number
}
interface Input {
  bucket_id: string;
  sha256: string;
  sha1: string;
  byte_length: number;
  row_count: number;
  etag: string|null;
  phase: 'READY'|'SENDING'|'CONFIRMED';
  file_id: string|null;
}

export const GP_SOURCE = 'celestrak-active-gp';
const OWNER =
    'EXISTS (SELECT 1 FROM command_control WHERE singleton=1 AND active=1 AND run_id=? AND writer_epoch=?)';
const INPUT =
    'SELECT i.bucket_id, i.sha256, o.sha1, o.byte_length, i.row_count, i.etag, o.phase, o.file_id ' +
    'FROM source_input i JOIN archive_object o USING (bucket_id, sha256) ';

async function current(db: D1Database, w: Writer) {
  const [guard, rows] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT 1 WHERE ' + OWNER).bind(w.runId, w.epoch),
    db.prepare(
          INPUT + 'WHERE i.run_id=? AND i.source_id=? AND i.writer_epoch=?')
        .bind(w.runId, GP_SOURCE, w.epoch),
  ]);
  if (!guard!.results.length) throw new Error('FENCED');
  return rows!.results[0] as unknown as Input | undefined;
}

export async function archiveConfirmed(db: D1Database, w: Writer) {
  return (await current(db, w))?.phase === 'CONFIRMED';
}

async function pin(db: D1Database, w: Writer, input: Input) {
  // 同一轮只冻结一个输入。竞争者不能把后到的快照写成这一轮的孤立对象。
  const absent =
      'NOT EXISTS (SELECT 1 FROM source_input WHERE run_id=? AND source_id=?)';
  await db.batch([
    db.prepare(
          'INSERT INTO archive_object (bucket_id, sha256, sha1, byte_length, phase) ' +
          'SELECT ?, ?, ?, ?, \'READY\' WHERE ' + OWNER + ' AND ' + absent +
          ' ON CONFLICT(bucket_id, sha256) DO NOTHING')
        .bind(
            input.bucket_id, input.sha256, input.sha1, input.byte_length,
            w.runId, w.epoch, w.runId, GP_SOURCE),
    db.prepare(
          'INSERT INTO source_input (run_id, source_id, writer_epoch, bucket_id, sha256, row_count, etag) ' +
          'SELECT ?, ?, ?, bucket_id, sha256, ?, ? FROM archive_object WHERE bucket_id=? AND sha256=? ' +
          'AND sha1=? AND byte_length=? AND ' + OWNER +
          ' ON CONFLICT(run_id, source_id) DO NOTHING')
        .bind(
            w.runId, GP_SOURCE, w.epoch, input.row_count, input.etag,
            input.bucket_id, input.sha256, input.sha1, input.byte_length,
            w.runId, w.epoch),
  ]);
}

function readyInput(s: RawSnapshot, bucket: string): Input {
  return {
    bucket_id: bucket,
    sha256: s.sha256,
    sha1: s.sha1,
    byte_length: s.bytes.byteLength,
    row_count: s.rows,
    etag: s.etag,
    phase: 'READY',
    file_id: null
  };
}

/** 返回值只证明原始对象已归档，不证明轨道事实、图或整轮已完成。 */
export async function archiveSource(
    db: D1Database, w: Writer, port: ArchivePort,
    load: (etag?: string) => Promise<RawSnapshot|null> = fetchSnapshot) {
  let input = await current(db, w);
  let raw: RawSnapshot|null = null;
  if (!input) {
    const prior =
        await db
            .prepare(
                INPUT +
                'WHERE i.source_id=? AND i.bucket_id=? AND o.phase=\'CONFIRMED\' ' +
                'ORDER BY i.writer_epoch DESC LIMIT 1')
            .bind(GP_SOURCE, port.bucketId)
            .first<Input>();
    raw = await load(prior?.etag ?? undefined);
    const candidate = raw ? readyInput(raw, port.bucketId) : prior;
    if (!candidate || (!raw && !prior?.etag))
      throw new Error('UNPROVEN_NOT_MODIFIED');
    await pin(db, w, candidate);
    input = await current(db, w);
    if (!input || input.sha256 !== candidate.sha256)
      throw new Error('FROZEN_INPUT_CONFLICT');
  }
  if (input.bucket_id !== port.bucketId)
    throw new Error('ARCHIVE_BUCKET_CHANGED');
  if (input.phase === 'CONFIRMED') return input;
  const identity = {
    sha256: input.sha256,
    sha1: input.sha1,
    byteLength: input.byte_length
  };
  let version = await port.find(identity);
  if (!version) {
    // SENDING 表示可能已送达。即使列举为空，也不能据此断言未提交。
    if (input.phase === 'SENDING') throw new Error('ARCHIVE_COMMIT_UNKNOWN');
    raw ??= await load();
    if (!raw || raw.sha256 !== input.sha256 || raw.sha1 !== input.sha1 ||
        raw.bytes.byteLength !== input.byte_length)
      throw new Error('FROZEN_INPUT_CHANGED');
    const claim =
        await db
            .prepare(
                'UPDATE archive_object SET phase=\'SENDING\', sender_run=?, sender_epoch=? ' +
                'WHERE bucket_id=? AND sha256=? AND phase=\'READY\' AND ' +
                OWNER)
            .bind(
                w.runId, w.epoch, port.bucketId, input.sha256, w.runId, w.epoch)
            .run();
    if (claim.meta.changes !== 1) {
      const after = await current(db, w);
      if (after?.phase === 'CONFIRMED') return after;
      throw new Error('ARCHIVE_COMMIT_UNKNOWN');
    }
    version = await port.upload(identity, raw.bytes);
  }
  if (!version || version.length > 256) throw new Error('INVALID_FILE_VERSION');
  await db
      .prepare(
          'UPDATE archive_object SET phase=\'CONFIRMED\', file_id=? WHERE bucket_id=? AND sha256=? ' +
          'AND phase IN (\'READY\',\'SENDING\') AND ' + OWNER)
      .bind(version, port.bucketId, input.sha256, w.runId, w.epoch)
      .run();
  const receipt = await current(db, w);
  if (receipt?.phase !== 'CONFIRMED' || receipt.file_id !== version)
    throw new Error('ARCHIVE_PROOF_CONFLICT');
  return receipt;
}
