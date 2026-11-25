interface Writer {
  runId: string;
  epoch: number;
}

export interface OrbitCommand {
  writer: Writer;
  operationId: string;
  entityId: string;
  expectedRevision: number;
  epochUs: number;
  sourceId: string;
  evidenceId: string;
  objectId: string;
  format: 'OMM';
  frame: 'TEME';
}

type Effect = 'APPLIED'|'UNCHANGED'|'OLDER';
interface Receipt {
  run_id: string;
  writer_epoch: number;
  entity_id: string;
  expected_revision: number;
  epoch_us: number;
  payload_hash: string;
  outcome: Effect;
  revision: number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function validateWriter(writer: Writer) {
  if (!ID.test(writer.runId) || !Number.isSafeInteger(writer.epoch) ||
      writer.epoch < 1) {
    throw new Error('INVALID_WRITER');
  }
}

/** 仅为写路径提供；旧代际和同代际不同运行均不能接管。 */
export async function activateWriter(db: D1Database, writer: Writer) {
  validateWriter(writer);
  const row =
      await db
          .prepare(
              'INSERT INTO command_control VALUES (1, ?, ?, 1) ' +
              'ON CONFLICT(singleton) DO UPDATE SET run_id=excluded.run_id, ' +
              'writer_epoch=excluded.writer_epoch, active=1 ' +
              'WHERE excluded.writer_epoch > command_control.writer_epoch RETURNING active')
          .bind(writer.runId, writer.epoch)
          .first();
  if (row) return;
  if (!await db
           .prepare(
               'SELECT 1 FROM command_control WHERE singleton=1 ' +
               'AND run_id=? AND writer_epoch=? AND active=1')
           .bind(writer.runId, writer.epoch)
           .first()) {
    throw new Error('FENCED');
  }
}

export async function sealWriter(db: D1Database, writer: Writer) {
  validateWriter(writer);
  await db
      .prepare(
          'UPDATE command_control SET active=0 WHERE singleton=1 ' +
          'AND run_id=? AND writer_epoch=? AND active=1')
      .bind(writer.runId, writer.epoch)
      .run();
}

export async function orbitPayload(
    command: Omit<OrbitCommand, 'writer'|'operationId'|'expectedRevision'>) {
  if (![command.entityId, command.sourceId, command.evidenceId,
        command.objectId]
           .every(v => typeof v === 'string' && ID.test(v)) ||
      !Number.isSafeInteger(command.epochUs) || command.format !== 'OMM' ||
      command.frame !== 'TEME') {
    throw new Error('INVALID_ORBIT_COMMAND');
  }
  const payload = JSON.stringify({
    entity_id: command.entityId,
    epoch_us: command.epochUs,
    format: command.format,
    frame: command.frame,
    source_id: command.sourceId,
    evidence_id: command.evidenceId,
    object_id: command.objectId
  });
  const digest =
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  const hash =
      Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0'))
          .join('');
  return {payload, hash};
}

async function encodeOrbit(command: OrbitCommand) {
  validateWriter(command.writer);
  if (typeof command.operationId !== 'string' ||
      !ID.test(command.operationId) ||
      !Number.isSafeInteger(command.expectedRevision) ||
      command.expectedRevision < 0)
    throw new Error('INVALID_ORBIT_COMMAND');
  return orbitPayload(command);
}

function matchReceipt(row: Receipt, cmd: OrbitCommand, hash: string) {
  if (row.run_id !== cmd.writer.runId ||
      row.writer_epoch !== cmd.writer.epoch || row.entity_id !== cmd.entityId ||
      row.expected_revision !== cmd.expectedRevision ||
      row.epoch_us !== cmd.epochUs || row.payload_hash !== hash)
    throw new Error('OPERATION_CONFLICT');
  return {outcome: row.outcome, revision: row.revision};
}

/** 超时后只读核对；未找到收据不是远端已回滚的证明。 */
export async function reconcileOrbit(db: D1Database, cmd: OrbitCommand) {
  const {hash} = await encodeOrbit(cmd);
  const row =
      await db.prepare('SELECT * FROM command_receipt WHERE operation_id=?')
          .bind(cmd.operationId)
          .first<Receipt>();
  return row ? matchReceipt(row, cmd, hash) : null;
}

export async function applyOrbit(db: D1Database, cmd: OrbitCommand) {
  const {payload, hash} = await encodeOrbit(cmd);
  const {writer, operationId, entityId, expectedRevision, epochUs} = cmd;
  // 先取得本次命令的唯一收据，再以 changes() 把同一事务内的两次写串起来。
  // 重放命中旧收据时，第一条写为零行，不会再次 UPSERT 或追加旧事件。
  const receipt =
      db.prepare(
            'INSERT INTO command_receipt ' +
            'SELECT ?, c.run_id, c.writer_epoch, ?, ?, ?, ?, ' +
            'CASE WHEN o.epoch_us > ? THEN \'OLDER\' WHEN o.payload_hash = ? THEN \'UNCHANGED\' ELSE \'APPLIED\' END, ' +
            'COALESCE(o.revision, 0) + CASE WHEN o.epoch_us > ? OR o.payload_hash = ? THEN 0 ELSE 1 END ' +
            'FROM command_control c LEFT JOIN orbit_current o ON o.entity_id=? ' +
            'WHERE c.singleton=1 AND c.active=1 AND c.run_id=? AND c.writer_epoch=? ' +
            'AND COALESCE(o.revision, 0)=? ON CONFLICT(operation_id) DO NOTHING')
          .bind(
              operationId, entityId, expectedRevision, epochUs, hash, epochUs,
              hash, epochUs, hash, entityId, writer.runId, writer.epoch,
              expectedRevision);
  const fact =
      db.prepare(
            'INSERT INTO orbit_current ' +
            'SELECT entity_id, revision, epoch_us, ?, payload_hash FROM command_receipt ' +
            'WHERE operation_id=? AND outcome=\'APPLIED\' AND changes()=1 ' +
            'ON CONFLICT(entity_id) DO UPDATE SET revision=excluded.revision, epoch_us=excluded.epoch_us, ' +
            'payload=excluded.payload, payload_hash=excluded.payload_hash')
          .bind(payload, operationId);
  const event =
      db.prepare(
            'INSERT INTO projection_outbox ' +
            '(operation_id, entity_id, revision, payload, payload_hash) ' +
            'SELECT ?, entity_id, revision, payload, payload_hash FROM orbit_current ' +
            'WHERE entity_id=? AND changes()=1')
          .bind(operationId, entityId);
  const read = db.prepare('SELECT * FROM command_receipt WHERE operation_id=?')
                   .bind(operationId);
  const guard = db.prepare(
      'SELECT run_id, writer_epoch, active FROM command_control WHERE singleton=1');
  const result = await db.batch<Record<string, unknown>>(
      [receipt, fact, event, read, guard]);
  const row = result[3]!.results[0] as unknown as Receipt | undefined;
  if (row) return matchReceipt(row, cmd, hash);
  const owner = result[4]!.results[0];
  if (owner?.run_id !== writer.runId || owner.writer_epoch !== writer.epoch ||
      owner.active !== 1) {
    throw new Error('FENCED');
  }
  throw new Error('REVISION_CONFLICT');
}
