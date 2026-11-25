import assert from 'node:assert/strict';
import test from 'node:test';

import {compareSnapshots} from '../scripts/validation/snapshots.ts';

const row = (n, name = 'A') => ({NORAD_CAT_ID: n, OBJECT_NAME: name});

test('快照分开统计新增、字段变化、未出现，忽略键和记录顺序', () => {
  const before = [row(1), row(2), row(3)];
  const after = [row(4), {OBJECT_NAME: 'A', NORAD_CAT_ID: '2'}, row(1, 'B')];
  assert.deepEqual(compareSnapshots(before, after), {
    previousRows: 3,
    currentRows: 3,
    added: 1,
    changed: 1,
    unchanged: 1,
    absentInCurrent: 1,
    changedShareOfMatched: 0.5
  });
  assert.equal(
      compareSnapshots([row(1)], [row(2)]).changedShareOfMatched, null);
});

test('空快照、坏行和重复 ID 不能用于容量验收', () => {
  for (const input
           of [[], {}, [null], [row(1), row('1')], [row(0)], [row(2, {})]]) {
    assert.throws(() => compareSnapshots([row(1)], input));
  }
});
