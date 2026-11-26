export const DAILY_CRON = '0 0 * * *';
const DAY = 86_400_000;
const RETRY_MS = [30_000, 120_000, 300_000] as const;
const CONTROL = 'current';

type Quality = 'NO_DATA'|'VERIFIED'|'PARTIAL'|'UNKNOWN';
export type Stage = 'activate'|'archive'|'index'|'ingest'|'project'|'seal';
export interface Run {
  run_id: string;
  schedule_slot: number;
  writer_epoch: number;
  attempt_no: number;
  checkpoint: number;
  phase: 'UPDATING'|'RETRY_WAIT'|'IDLE';
  run_status: 'RUNNING'|'FAILED'|'SUCCEEDED';
  data_quality: Quality;
  next_at: number|null;
  pending: string|null;
  stage?: Stage;
  cursor?: number;
  error: string|null;
  last_complete_success_at: number|null;
  last_complete_publication_id: string|null;
}

export interface Lease {
  run_id: string;
  writer_epoch: number;
  attempt_no: number;
  checkpoint: number;
  operation_id: string;
  stage?: Stage;
  cursor?: number;
}

export type Outcome = {
  kind: 'progress'; checkpoint: number;
  stage?: Stage;
  cursor?: number
}|{
  kind: 'safe_retry';
  retry_after_ms?: number
}
|{kind: 'unknown'}|{kind: 'unpublished'}|{
  kind: 'verified';
  publication_id: string
};
export type Step = (lease: Lease) => Promise<Outcome>;

export function validSlot(cron: string, slot: number, now: number): boolean {
  return cron === DAILY_CRON && Number.isSafeInteger(slot) && slot > 0 &&
      slot % DAY === 0 && now >= slot && now - slot <= 300_000;
}

export async function readStatus(storage: DurableObjectStorage) {
  const run = await storage.get<Run>(CONTROL);
  if (!run) {
    return {
      phase: 'IDLE',
      run_status: 'NEVER_RUN',
      data_quality: 'NO_DATA',
      attempt_no: null,
      last_complete_success_at: null,
      last_complete_publication_id: null
    };
  }
  const {
    phase,
    run_status,
    data_quality,
    attempt_no,
    error,
    checkpoint,
    last_complete_success_at,
    last_complete_publication_id
  } = run;
  return {
    phase,
    run_status,
    data_quality,
    attempt_no,
    error,
    checkpoint,
    last_complete_success_at,
    last_complete_publication_id
  };
}

export async function admit(
    storage: DurableObjectStorage, cron: string, slot: number, now: number) {
  if (!validSlot(cron, slot, now)) {
    return 'INVALID_SLOT';
  }
  const id = crypto.randomUUID();
  return storage.transaction(async tx => {
    const last = await tx.get<number>('last_slot');
    if (last !== undefined && slot <= last) {
      return 'DUPLICATE';
    }
    const previous = await tx.get<Run>(CONTROL);
    // 即使上一轮跨日，已跳过的槽也不能在同槽第二次投递时补开。
    await tx.put('last_slot', slot);
    if (previous?.run_status === 'RUNNING') {
      return 'BUSY';
    }
    const run: Run = {
      run_id: id,
      schedule_slot: slot,
      writer_epoch: (previous?.writer_epoch ?? 0) + 1,
      attempt_no: 0,
      checkpoint: 0,
      phase: 'UPDATING',
      run_status: 'RUNNING',
      data_quality: previous?.data_quality ?? 'NO_DATA',
      next_at: now,
      pending: null,
      error: null,
      last_complete_success_at: previous?.last_complete_success_at ?? null,
      last_complete_publication_id:
          previous?.last_complete_publication_id ?? null
    };
    await tx.put(CONTROL, run);
    await tx.put('start:' + id, {slot, at: now, epoch: run.writer_epoch});
    await tx.setAlarm(now);
    return 'STARTED';
  });
}

async function finish(
    tx: DurableObjectTransaction, run: Run, now: number, error: string|null) {
  run.phase = 'IDLE';
  run.run_status = error ? 'FAILED' : 'SUCCEEDED';
  run.error = error;
  run.pending = null;
  run.next_at = null;
  await tx.deleteAlarm();
  await tx.put(CONTROL, run);
  await tx.put('end:' + run.run_id, {...run, ended_at: now});
}

/** 只有 alarm 调用；已登记但结果不明的变更不自动重放。 */
export async function resume(
    storage: DurableObjectStorage, step?: Step, clock: () => number = Date.now,
    reconcile?: Step) {
  const lease = await storage.transaction(async tx => {
    const run = await tx.get<Run>(CONTROL);
    const now = clock();
    if (!run || run.run_status !== 'RUNNING' || now < run.next_at!) {
      return;
    }
    const recovering = run.pending !== null;
    if (recovering && !reconcile) {
      await finish(tx, run, now, 'COMMIT_UNKNOWN');
      return;
    }
    if (!step) {
      await finish(tx, run, now, 'PIPELINE_NOT_CONFIGURED');
      return;
    }
    const operation = [run.run_id, run.attempt_no, run.checkpoint].join(':');
    if (recovering && run.pending !== operation) {
      await finish(tx, run, now, 'OPERATION_CONFLICT');
      return;
    }
    const priorQuality = run.data_quality;
    run.pending = operation;
    run.data_quality = 'UNKNOWN';
    run.phase = 'UPDATING';
    run.next_at = now + 60_000;
    await tx.put(CONTROL, run);
    await tx.setAlarm(run.next_at);
    return {
      recovering,
      priorQuality,
      work: {
        run_id: run.run_id,
        writer_epoch: run.writer_epoch,
        attempt_no: run.attempt_no,
        checkpoint: run.checkpoint,
        operation_id: operation,
        stage: run.stage,
        cursor: run.cursor
      }
    };
  });
  if (!lease || !step) {
    return;
  }
  let outcome: Outcome;
  try {
    outcome = await (lease.recovering ? reconcile! : step)(lease.work);
  } catch {
    try {
      outcome = !lease.recovering && reconcile ? await reconcile(lease.work) :
                                                 {kind: 'unknown'};
    } catch {
      outcome = {kind: 'unknown'};
    }
  }
  await storage.transaction(async tx => {
    const now = clock();
    const run = await tx.get<Run>(CONTROL);
    if (!run || run.run_status !== 'RUNNING' ||
        run.pending !== lease.work.operation_id) {
      return;
    }
    run.pending = null;
    if (outcome?.kind === 'progress' &&
        Number.isSafeInteger(outcome.checkpoint) &&
        outcome.checkpoint > run.checkpoint) {
      run.checkpoint = outcome.checkpoint;
      if (outcome.stage) {
        run.stage = outcome.stage;
      }
      if (outcome.cursor !== undefined) {
        run.cursor = outcome.cursor;
      }
      run.data_quality = 'PARTIAL';
      run.error = null;
      run.next_at = now;
    } else if (
        outcome?.kind === 'safe_retry' &&
        Number.isSafeInteger(outcome.retry_after_ms ?? 0) &&
        (outcome.retry_after_ms ?? 0) >= 0) {
      run.data_quality = lease.priorQuality;
      const delay = RETRY_MS[run.attempt_no];
      await tx.put('failure:' + lease.work.operation_id, {
        at: now,
        attempt_no: run.attempt_no,
        checkpoint: run.checkpoint,
        code: 'RETRYABLE_NO_EFFECT'
      });
      if (delay === undefined) {
        await finish(tx, run, now, 'RETRIES_EXHAUSTED');
        return;
      }
      run.phase = 'RETRY_WAIT';
      run.attempt_no++;
      run.next_at = now + Math.max(delay, outcome.retry_after_ms ?? 0);
      run.error = 'RETRYABLE_NO_EFFECT';
    } else if (outcome?.kind === 'unpublished') {
      run.data_quality = 'PARTIAL';
      await finish(tx, run, now, 'PUBLICATION_NOT_VERIFIED');
      return;
    } else if (
        outcome?.kind === 'verified' &&
        typeof outcome.publication_id === 'string' &&
        /^[A-Za-z0-9:_-]{1,128}$/.test(outcome.publication_id)) {
      run.data_quality = 'VERIFIED';
      run.last_complete_success_at = now;
      run.last_complete_publication_id = outcome.publication_id;
      await finish(tx, run, now, null);
      return;
    } else {
      await finish(tx, run, now, 'COMMIT_UNKNOWN');
      return;
    }
    await tx.put(CONTROL, run);
    await tx.setAlarm(run.next_at);
  });
}
