import {Miniflare} from 'miniflare';
import {readFile} from 'node:fs/promises';

import {activateWriter, applyOrbit} from '../src/sg-sync/storage/orbit_store.ts';

export const writer = {
  runId: 'projection-run-1',
  epoch: 1
};
export const instance = 'isolated-graph-1';

export async function setupProjection(t) {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {}',
    cf: false,
    compatibilityDate: '2026-07-01',
    d1Databases: ['CORE'],
    d1Persist: false
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('CORE');
  for (const name of ['0001_orbit_facts.sql', '0002_projection_cursor.sql']) {
    const path =
        new URL('../src/sg-sync/storage/migrations/' + name, import.meta.url);
    const statements = (await readFile(path, 'utf8'))
                           .split(';')
                           .map(s => s.trim())
                           .filter(Boolean);
    await db.batch(statements.map(s => db.prepare(s)));
  }
  await activateWriter(db, writer);
  async function append(entityId, revision) {
    const key = entityId + '-' + revision;
    await applyOrbit(db, {
      writer,
      operationId: key,
      entityId,
      expectedRevision: revision - 1,
      epochUs: 1000000 + revision,
      sourceId: 'fixture',
      evidenceId: 'e-' + key,
      objectId: 'o-' + key,
      format: 'OMM',
      frame: 'TEME'
    });
  }
  return {db, append};
}
