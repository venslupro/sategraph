import {orbitPayload} from './storage/orbit_store.ts';

import {GP_SOURCE} from './archive_step.ts';
import type {ReadArchiveRange} from './b2_archive.ts';
import {GP_PARSER, indexGp, readGpSpan, type Span} from './gp_chunks.ts';

interface Writer {
  runId: string;
  epoch: number
}
interface Version {
  bucketId: string;
  fileId: string
}
interface State extends Version {
  hash: string;
  bytes: number;
  rows: number;
  parser: string|null;
  chunks: number|null;
  nextChunk: number|null;
  nextRow: number|null;
  span: string|null;
  manifestHash: string|null;
  manifestFile: string|null;
}

const input =
    ' FROM source_input i JOIN archive_object a USING(bucket_id,sha256) ' +
    'JOIN command_control c ON c.singleton=1 AND c.active=1 AND c.run_id=i.run_id AND c.writer_epoch=i.writer_epoch ';
const active =
    ' WHERE i.run_id=? AND i.writer_epoch=? AND i.source_id=? AND a.phase=\'CONFIRMED\'';

async function state(db: D1Database, w: Writer) {
  const s =
      await db
          .prepare(
              'SELECT i.sha256 AS hash,i.row_count AS rows,a.byte_length AS bytes,i.bucket_id AS bucketId,' +
              'a.file_id AS fileId,m.input_hash AS manifestHash,m.file_id AS manifestFile,m.parser,json_array_length(m.spans) AS chunks,' +
              'p.next_chunk AS nextChunk,p.next_row AS nextRow,json_extract(m.spans,\'$[\'||p.next_chunk||\']\') AS span' +
              input +
              'LEFT JOIN gp_manifest m ON (i.run_id,i.source_id)=(m.run_id,m.source_id) ' +
              'LEFT JOIN gp_checkpoint p ON (i.run_id,i.source_id)=(p.run_id,p.source_id)' +
              active)
          .bind(w.runId, w.epoch, GP_SOURCE)
          .first<State>();
  if (!s) throw new Error('GP_INPUT_NOT_ACTIVE');
  if (s.parser !== null &&
      (s.parser !== GP_PARSER || s.hash !== s.manifestHash ||
       s.fileId !== s.manifestFile || !s.chunks || s.nextChunk === null ||
       s.nextRow === null || s.nextChunk > s.chunks || s.nextRow > s.rows ||
       (s.nextChunk === s.chunks) !== (s.nextRow === s.rows)))
    throw new Error('GP_CHECKPOINT_MISMATCH');
  return s;
}

function progress(s: State) {
  if (s.nextChunk === null || s.nextRow === null || s.chunks === null)
    throw new Error('GP_NOT_PREPARED');
  return {
    nextChunk: s.nextChunk,
    processed: s.nextRow,
    total: s.rows,
    complete: s.nextChunk === s.chunks
  };
}

export async function gpProgress(db: D1Database, w: Writer) {
  const s = await state(db, w);
  return s.parser === null ? null : progress(s);
}

export async function prepareGp(
    db: D1Database, w: Writer, read: ReadArchiveRange) {
  const s = await state(db, w);
  if (s.parser !== null) return progress(s);
  const raw = await read(
      {bucketId: s.bucketId, fileId: s.fileId, byteLength: s.bytes}, 0,
      s.bytes);
  if (raw.byteLength !== s.bytes) throw new Error('GP_INPUT_MISMATCH');
  const spans = await indexGp(raw, s.hash, s.rows);
  await db.batch([
    db.prepare(
          'INSERT INTO gp_manifest SELECT i.run_id,i.source_id,i.sha256,a.file_id,?,?' +
          input + active +
          ' AND i.sha256=? AND a.file_id=? AND i.bucket_id=? AND i.row_count=? AND a.byte_length=? ON CONFLICT DO NOTHING')
        .bind(
            GP_PARSER, JSON.stringify(spans), w.runId, w.epoch, GP_SOURCE,
            s.hash, s.fileId, s.bucketId, s.rows, s.bytes),
    db.prepare(
          'INSERT INTO gp_checkpoint(run_id,source_id) SELECT ?,? WHERE changes()=1')
        .bind(w.runId, GP_SOURCE),
  ]);
  return progress(await state(db, w));
}

export type CommitGp = (w: Writer, chunk: number, bytes: Uint8Array<ArrayBuffer>) =>
    Promise<ReturnType<typeof progress>>;

async function pendingChunk(db: D1Database, w: Writer, chunk: number) {
  const s = await state(db, w), before = progress(s);
  if (!Number.isSafeInteger(chunk) || chunk < 0 || chunk > before.nextChunk)
    throw new Error('GP_OUT_OF_ORDER');
  if (chunk < before.nextChunk || before.complete) return {s, before, span: null};
  const span: Span = JSON.parse(s.span ?? 'null');
  if (!span || span.first !== before.processed ||
      !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) ||
      span.start < 0 || span.end > s.bytes || span.end <= span.start ||
      span.end - span.start + 2 > 256 * 1024 ||
      !Number.isSafeInteger(span.count) || span.count < 1 || span.count > 100 ||
      span.first + span.count > s.rows ||
      (chunk + 1 === s.chunks) !== (span.first + span.count === s.rows))
    throw new Error('GP_CHECKPOINT_MISMATCH');
  return {s, before, span};
}

/** 同步端只取固定区间；没有命令绑定时不能退回本地写入。 */
export async function advanceGp(
    db: D1Database, w: Writer, chunk: number, read: ReadArchiveRange,
    commit: CommitGp) {
  const {s, before, span} = await pendingChunk(db, w, chunk);
  if (!span) return before;
  const slice = await read(
      {bucketId: s.bucketId, fileId: s.fileId, byteLength: s.bytes}, span.start,
      span.end);
  return commit(w, chunk, slice);
}

/** 命令端独立读取当前代际和清单，不接受调用方提供的摘要或游标。 */
export async function commitGpChunk(
    db: D1Database, w: Writer, chunk: number, slice: Uint8Array<ArrayBuffer>) {
  const {s, before, span} = await pendingChunk(db, w, chunk);
  if (!span) return before;
  const rows = await readGpSpan(slice, span);
  const work = JSON.stringify(await Promise.all(rows.map(async (r, k) => {
    const entity = 'norad:' + r.id;
    const {payload, hash} = await orbitPayload({
      entityId: entity,
      epochUs: r.epoch,
      sourceId: GP_SOURCE,
      evidenceId: r.evidence,
      objectId: 'gp:' + s.hash,
      format: 'OMM',
      frame: 'TEME'
    });
    return {
      op: ['gp', w.epoch, s.hash, span.first + k].join(':'),
      entity,
      epoch: r.epoch,
      evidence: r.evidence,
      name:r.name, cospar:r.cospar, omm:r.omm,
      payload,
      hash
    };
  })));
  const commands =
      'SELECT value->>\'$.op\' op,value->>\'$.entity\' entity,value->>\'$.epoch\' epoch,' +
      'value->>\'$.evidence\' evidence,value->>\'$.payload\' payload,value->>\'$.hash\' hash,CAST(key AS INTEGER) ord FROM json_each(?)';
  const cas =
      db.prepare(
            'UPDATE gp_checkpoint SET next_chunk=next_chunk+1,next_row=next_row+? ' +
            'WHERE run_id=? AND source_id=? AND next_chunk=? AND next_row=? AND EXISTS (SELECT 1' +
            input +
            'JOIN gp_manifest m ON (m.run_id,m.source_id)=(i.run_id,i.source_id)' +
            active +
            ' AND m.parser=? AND i.sha256=m.input_hash AND i.sha256=? AND a.file_id=m.file_id AND a.file_id=? AND i.bucket_id=? ' +
            'AND json_extract(m.spans,\'$[\'||CAST(? AS INTEGER)||\']\')=?) AND NOT EXISTS (SELECT 1 FROM (' +
            commands + ') j JOIN orbit_current o ' +
            'ON o.entity_id=j.entity WHERE (o.payload->>\'$.source_id\') IS NOT ?)')
          .bind(
              span.count, w.runId, GP_SOURCE, chunk, span.first, w.runId,
              w.epoch, GP_SOURCE, GP_PARSER, s.hash, s.fileId, s.bucketId,
              chunk, s.span, work, GP_SOURCE);
  // 只有抢到本块的事务才能建收据；后一条写以同事务上一条的 changes()
  // 为门。任何错误都回滚断点。
  const receipts =
      db.prepare(
            'INSERT INTO command_receipt SELECT op,?,?,entity,prior,epoch,hash,effect,' +
            'prior+(effect=\'APPLIED\') FROM (SELECT j.*,coalesce(o.revision,0) prior,CASE WHEN o.epoch_us>j.epoch THEN \'OLDER\' ' +
            'WHEN (o.payload->>\'$.evidence_id\')=j.evidence THEN \'UNCHANGED\' ELSE \'APPLIED\' END effect FROM (' +
            commands +
            ') j LEFT JOIN orbit_current o ON o.entity_id=j.entity) WHERE changes()=1 ORDER BY ord')
          .bind(w.runId, w.epoch, work);
  const applied = ' FROM (' + commands +
      ') j JOIN command_receipt r ON r.operation_id=j.op ' +
      'WHERE changes()>0 AND r.outcome=\'APPLIED\' ORDER BY j.ord';
  const facts =
      db.prepare(
            'INSERT INTO orbit_current SELECT j.entity,r.revision,j.epoch,j.payload,j.hash' +
            applied +
            ' ON CONFLICT(entity_id) DO UPDATE SET revision=excluded.revision,epoch_us=excluded.epoch_us,payload=excluded.payload,payload_hash=excluded.payload_hash')
          .bind(work);
  const events =
      db.prepare(
            'INSERT INTO projection_outbox(operation_id,entity_id,revision,payload,payload_hash) ' +
            'SELECT j.op,j.entity,r.revision,j.payload,j.hash' + applied)
          .bind(work);
  const profiles = db.prepare("INSERT INTO catalog_profile SELECT r.entity_id,?,j.value->>'$.name',j.value->>'$.cospar',r.epoch_us,j.value->'$.omm' FROM json_each(?) j JOIN command_receipt r ON r.operation_id=j.value->>'$.op' JOIN command_control c ON c.run_id=r.run_id AND c.writer_epoch=r.writer_epoch AND c.active=1 WHERE r.run_id=? AND r.writer_epoch=? AND r.outcome!='OLDER' ON CONFLICT(entity_id,source_id) DO UPDATE SET display_name=excluded.display_name,cospar=excluded.cospar,epoch_us=excluded.epoch_us,omm=excluded.omm WHERE excluded.epoch_us>=catalog_profile.epoch_us AND (excluded.display_name IS NOT catalog_profile.display_name OR excluded.cospar IS NOT catalog_profile.cospar OR excluded.omm<>catalog_profile.omm)").bind(GP_SOURCE,work,w.runId,w.epoch);
  await db.batch([cas, receipts, facts, events, profiles]);
  const after = progress(await state(db, w));
  if (after.nextChunk <= chunk) throw new Error('GP_INPUT_CONFLICT');
  return after;
}
