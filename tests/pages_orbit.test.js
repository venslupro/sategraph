import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

import {buildPages} from '../scripts/build_pages.js';
import {normalizeOmm} from '../src/sg-pages/model.ts';

// 合成输入只验证浏览器端传播管线，不作为实际卫星位置或通信证据。
const row = {
  NORAD_CAT_ID: '12345',
  OBJECT_NAME: '演示输入',
  OBJECT_ID: '',
  EPOCH: '2026-01-01T00:00:00.123456Z',
  MEAN_MOTION: 15,
  ECCENTRICITY: 0.001,
  INCLINATION: 52,
  RA_OF_ASC_NODE: 15,
  ARG_OF_PERICENTER: 3,
  MEAN_ANOMALY: 20,
  ELEMENT_SET_NO: 1,
  BSTAR: 0.00001,
  MEAN_MOTION_DOT: 0,
  MEAN_MOTION_DDOT: 0
};

test('本地 OMM 去重并过滤不可传播输入，不丢掉 UTC 历元精度', () => {
  const [sat, ...extra] = normalizeOmm([null, {...row, BSTAR: ''}, row, row]);
  assert.equal(extra.length, 0);
  assert.equal(sat.demo, false);
  assert.equal(sat.omm.EPOCH, row.EPOCH);
  assert.throws(() => normalizeOmm({}), /JSON 数组/);
});

test(
    '发布包中的 SGP4 Worker 独立运行，产生位置与轨迹，忽略旧目录请求',
    async t => {
      const parent = await mkdtemp(join(tmpdir(), 'sg-orbit-'));
      t.after(() => rm(parent, {recursive: true, force: true}));
      const dist = await buildPages(parent);
      const messages = [];
      const self = {postMessage: message => messages.push(message)};
      runInNewContext(
          await readFile(join(dist, 'orbit-worker.js'), 'utf8'), {self});
      const send = data => self.onmessage({data});
      const [sat] = normalizeOmm([row]);
      send({type: 'catalog', generation: 2, rows: [sat.omm]});
      assert.equal(messages[0].count, 1);
      send({type: 'positions', generation: 1, ms: sat.epoch});
      assert.equal(messages.length, 1);
      send({type: 'positions', generation: 2, ms: sat.epoch});
      const {positions: [point], failed} = messages[1];
      assert.equal(failed, 0);
      assert.equal(point.id, sat.id);
      assert.ok(point.alt > 0 && point.physical.every(Number.isFinite));
      assert.ok(Math.abs(Math.hypot(...point.unit) - 1) < 1e-9);
      send({
        type: 'path',
        generation: 2,
        id: sat.id,
        ms: sat.epoch,
        period: sat.period
      });
      assert.equal(messages[2].points.length, 161);
      assert.ok(
          messages[2].points.every(
              p => p.length === 3 && p.every(Number.isFinite)));
    });
