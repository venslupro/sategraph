import type {GraphProof, Position, Writer} from './chunk.ts';
import type {GraphPort} from './graph.ts';
import {acknowledge, reserve, snapshot, takeOver} from './journal.ts';

function matches(a: Position, b: Position) {
  return a.cursor === b.cursor && a.hash === b.hash;
}

function assertOwner(proof: GraphProof, instance: string, w: Writer) {
  if (proof.instance !== instance || proof.epoch !== w.epoch ||
      proof.runId !== w.runId) {
    throw new Error('GRAPH_FENCED');
  }
}

/** 调度链在登记操作意图后调用；一次最多推进一个不可变分片。 */
export async function advanceProjection(
    db: D1Database, graph: GraphPort, writer: Writer, instance: string) {
  const state = await snapshot(db, writer, instance);
  return projectChunk(db, graph, writer, instance, state, false);
}

export async function projectAt(
    db: D1Database, graph: GraphPort, writer: Writer, instance: string,
    cursor: number, recoverOnly: boolean) {
  const state = await snapshot(db, writer, instance);
  if (!Number.isSafeInteger(cursor) || cursor < 0 ||
      cursor > state.base.cursor) {
    throw new Error('GRAPH_DIVERGED');
  }
  if (cursor < state.base.cursor) {
    return {kind: 'progress' as const, cursor: state.base.cursor};
  }
  const result =
      await projectChunk(db, graph, writer, instance, state, recoverOnly);
  if (result === 'DRAINED') {
    return {kind: 'drained' as const, cursor};
  }
  if (result === 'ACKNOWLEDGED' || result === 'RECONCILED') {
    return {kind: 'progress' as const, cursor: state.chunk!.end.cursor};
  }
  return {kind: 'unknown' as const, cursor};
}

async function projectChunk(
    db: D1Database, graph: GraphPort, writer: Writer, instance: string,
    state: Awaited<ReturnType<typeof snapshot>>, recoverOnly: boolean) {
  const chunk = state.chunk;
  let proof = await graph.inspect();
  if (proof.instance !== instance || proof.epoch > writer.epoch) {
    throw new Error('GRAPH_FENCED');
  }
  // 游标必须已有 D1 依据。错误目标或分叉不能因提升代际而被覆盖。
  if (!matches(proof, state.base) &&
      !(chunk && state.pending && matches(proof, chunk.end))) {
    throw new Error('GRAPH_DIVERGED');
  }
  if (proof.epoch < writer.epoch) {
    if (recoverOnly) {
      return 'COMMIT_UNKNOWN';
    }
    proof = await graph.claim(
        writer, state.base, state.pending ? chunk?.end : undefined);
  }
  assertOwner(proof, instance, writer);
  if (chunk && state.pending && matches(proof, chunk.end)) {
    return await acknowledge(db, writer, chunk, proof) ? 'RECONCILED' :
                                                         'CONTENDED';
  }
  if (!matches(proof, state.base)) {
    throw new Error('GRAPH_DIVERGED');
  }
  if (!chunk) {
    return 'DRAINED';
  }
  if (recoverOnly) {
    return 'COMMIT_UNKNOWN';
  }
  if (state.pending) {
    if (state.pendingEpoch === writer.epoch &&
        state.pendingRun === writer.runId) {
      return 'COMMIT_UNKNOWN';
    }
    // 只有新代际已在图端接管并确认前置游标，旧请求才不可能迟到提交。
    if (!await takeOver(db, writer, chunk, proof)) {
      return 'CONTENDED';
    }
  } else if (!await reserve(db, writer, chunk)) {
    return 'CONTENDED';
  }
  const committed = await graph.apply(writer, chunk);
  return await acknowledge(db, writer, chunk, committed) ? 'ACKNOWLEDGED' :
                                                           'CONTENDED';
}
