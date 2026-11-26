import {archiveConfirmed, archiveSource} from './archive_step.ts';
import type {ArchivePort, ReadArchiveRange} from './b2_archive.ts';
import type {Lease, Outcome, Stage} from './coordinator.ts';
import {advanceGp, type CommitGp, gpProgress, prepareGp} from './gp_ingest.ts';
import {fetchSnapshot} from './source_snapshot.ts';
import {activateWriter, sealWriter} from './storage/orbit_store.ts';

type Writer = {
  runId: string; epoch: number
};
interface Projector {
  cursor(writer: Writer): Promise<number>;
  advance(writer: Writer, cursor: number, recoverOnly: boolean):
      Promise<{kind: 'progress' | 'drained' | 'unknown'; cursor: number}>;
}
export interface Ports {
  db: D1Database;
  archive(): Promise<ArchivePort&{readRange: ReadArchiveRange}>;
  projector: Projector;
  commitGp: CommitGp;
  load?: typeof fetchSnapshot;
}

/** 每次 alarm 只推进一个阶段或一块；恢复时绝不重发没有提交证明的操作。 */
export async function runStage(
    ports: Ports, lease: Lease, recovering = false): Promise<Outcome> {
  const {db, projector} = ports;
  const writer = {runId: lease.run_id, epoch: lease.writer_epoch};
  const cursor = lease.cursor ?? 0;
  const next = (stage: Stage, cursor = 0): Outcome =>
      ({kind: 'progress', stage, cursor, checkpoint: lease.checkpoint + 1});
  const unknown: Outcome = {kind: 'unknown'};
  switch (lease.stage ?? 'activate') {
    case 'activate':
      if (!recovering) {
        await activateWriter(db, writer);
      } else if (!await owned(db, writer, 1)) {
        return unknown;
      }
      return next('archive');
    case 'archive':
      if (!recovering) {
        await archiveSource(
            db, writer, await ports.archive(), ports.load ?? fetchSnapshot);
      } else if (!await archiveConfirmed(db, writer)) {
        return unknown;
      }
      return next('index');
    case 'index': {
      const p = recovering ?
          await gpProgress(db, writer) :
          await prepareGp(db, writer, (await ports.archive()).readRange);
      if (!p) {
        return unknown;
      }
      return next('ingest', p.nextChunk);
    }
    case 'ingest': {
      const p = recovering ?
          await gpProgress(db, writer) :
          await advanceGp(
              db, writer, cursor, (await ports.archive()).readRange,
              ports.commitGp);
      if (!p || p.nextChunk <= cursor) {
        return unknown;
      }
      return p.complete ? next('project', await projector.cursor(writer)) :
                          next('ingest', p.nextChunk);
    }
    case 'project': {
      const result = await projector.advance(writer, cursor, recovering);
      if (result.kind === 'drained' && result.cursor === cursor) {
        return next('seal');
      }
      if (result.kind === 'progress' && Number.isSafeInteger(result.cursor) &&
          result.cursor > cursor) {
        return next('project', result.cursor);
      }
      return unknown;
    }
    case 'seal':
      if (!recovering) {
        await sealWriter(db, writer);
      }
      if (!await owned(db, writer, 0)) {
        return unknown;
      }
      // D 阶段尚未提供发布清单，不能由“投影已排空”推断整轮成功。
      return {kind: 'unpublished'};
  }
}

function owned(db: D1Database, w: Writer, active: number) {
  return db
      .prepare(
          'SELECT 1 FROM command_control WHERE singleton=1 AND run_id=? AND writer_epoch=? AND active=?')
      .bind(w.runId, w.epoch, active)
      .first();
}
