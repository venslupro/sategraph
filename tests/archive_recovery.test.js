import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {archiveSource} from '../src/sg-sync/archive_step.ts';
import {fetchSnapshot} from '../src/sg-sync/source_snapshot.ts';
import {activateWriter} from '../src/sg-sync/storage/orbit_store.ts';

import {setupProjection, writer} from './projector_fixture.js';

const nextWriter = {
  runId: 'next-archive-run',
  epoch: writer.epoch + 1
};
const bucketId = 'a'.repeat(24);

async function fixture(t) {
  const {db} = await setupProjection(t);
  const migration = new URL(
      '../src/sg-sync/storage/migrations/0003_source_archive.sql',
      import.meta.url);
  const sql = await readFile(migration, 'utf8');
  await db.batch(sql.split(';')
                     .map(part => part.trim())
                     .filter(Boolean)
                     .map(statement => db.prepare(statement)));
  return db;
}

function snapshot(id = 1) {
  return fetchSnapshot(
      undefined,
      async () => Response.json(
          [
            {NORAD_CAT_ID: id, EPOCH: '2026-01-01T00:00:00Z'},
          ],
          {headers: {etag: '"gp-' + id + '"'}}));
}

function unexpected() {
  assert.fail('A completed or uncertain upload must not be repeated');
}

test(
    'a confirmed receipt survives a replay and a later conditional 304',
    async t => {
      const db = await fixture(t);
      const port = {
        bucketId,
        find: async () => null,
        upload: async () => 'file-1'
      };
      await archiveSource(db, writer, port, () => snapshot());
      const sealedPort = {bucketId, find: unexpected, upload: unexpected};
      await archiveSource(db, writer, sealedPort, unexpected);
      await activateWriter(db, nextWriter);
      await archiveSource(db, nextWriter, sealedPort, async etag => {
        assert.equal(etag, '"gp-1"');
        return null;
      });
      assert.equal(
          await db.prepare('SELECT count(*) AS n FROM source_input').first('n'),
          2);
      assert.equal(
          await db.prepare('SELECT file_id FROM archive_object')
              .first('file_id'),
          'file-1');
    });

test('a 304 without a confirmed predecessor never pins input', async t => {
  const db = await fixture(t);
  await assert.rejects(
      archiveSource(
          db, writer, {bucketId, find: unexpected, upload: unexpected},
          async () => null),
      /UNPROVEN_NOT_MODIFIED/);
  assert.equal(
      await db.prepare('SELECT count(*) AS n FROM source_input').first('n'), 0);
});

test(
    'a lost response is recovered by exact object lookup, without a second upload',
    async t => {
      const db = await fixture(t);
      let fileId = null;
      let uploads = 0;
      const port = {
        bucketId,
        find: async () => fileId,
        upload: async () => {
          uploads++;
          assert.equal(
              await db.prepare('SELECT phase FROM archive_object')
                  .first('phase'),
              'SENDING');
          fileId = 'accepted-version';
          throw new Error('lost upload response');
        }
      };
      await assert.rejects(
          archiveSource(db, writer, port, () => snapshot()),
          /lost upload response/);
      assert.equal(
          await db.prepare('SELECT file_id FROM archive_object')
              .first('file_id'),
          null);
      await archiveSource(db, writer, port, unexpected);
      assert.equal(
          await db.prepare('SELECT file_id FROM archive_object')
              .first('file_id'),
          fileId);
      assert.equal(uploads, 1);
    });

test('an unproven send remains pending even after writer takeover', async t => {
  const db = await fixture(t);
  const port = {
    bucketId,
    find: async () => null,
    upload: async () => {
      throw new Error('timeout');
    }
  };
  await assert.rejects(
      archiveSource(db, writer, port, () => snapshot()), /timeout/);
  const verifyOnly = {...port, upload: unexpected};
  await assert.rejects(
      archiveSource(db, writer, verifyOnly, unexpected),
      /ARCHIVE_COMMIT_UNKNOWN/);
  await activateWriter(db, nextWriter);
  await assert.rejects(
      archiveSource(db, writer, verifyOnly, unexpected), /FENCED/);
  await assert.rejects(
      archiveSource(db, nextWriter, verifyOnly, () => snapshot()),
      /ARCHIVE_COMMIT_UNKNOWN/);
  assert.equal(
      await db.prepare('SELECT phase FROM archive_object').first('phase'),
      'SENDING');
});

test(
    'a writer replaced during upload cannot commit the remote receipt',
    async t => {
      const db = await fixture(t);
      let version = null;
      const port = {
        bucketId,
        find: async () => version,
        upload: async () => {
          version = 'recovered-after-takeover';
          await activateWriter(db, nextWriter);
          return version;
        }
      };
      await assert.rejects(
          archiveSource(db, writer, port, () => snapshot()), /FENCED/);
      assert.equal(
          await db.prepare('SELECT file_id FROM archive_object')
              .first('file_id'),
          null);
      await archiveSource(
          db, nextWriter, {...port, upload: unexpected}, () => snapshot());
      assert.equal(
          await db.prepare('SELECT file_id FROM archive_object')
              .first('file_id'),
          version);
    });

test(
    'a lookup failure does not allow a later fetch to replace frozen bytes',
    async t => {
      const db = await fixture(t);
      const port = {
        bucketId,
        find: async () => {
          throw new Error('list unavailable');
        },
        upload: unexpected
      };
      await assert.rejects(
          archiveSource(db, writer, port, () => snapshot()),
          /list unavailable/);
      await assert.rejects(
          archiveSource(
              db, writer, {...port, find: async () => null}, () => snapshot(2)),
          /FROZEN_INPUT_CHANGED/);
      assert.equal(
          await db.prepare('SELECT phase FROM archive_object').first('phase'),
          'READY');
    });
