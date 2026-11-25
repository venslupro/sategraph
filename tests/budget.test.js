import assert from 'node:assert/strict';
import test from 'node:test';

import {assessBudget, METRICS} from '../scripts/validation/budget.ts';

const metric = 'd1RowsWrittenPerDay';
const status = (used, limit) => assessBudget({[metric]: {used, limit}})
                                    .find(row => row.metric === metric)
                                    .status;

test('未实测的资源不按零用量验收', () => {
  const results = assessBudget({});
  assert.equal(results.length, METRICS.length);
  assert.ok(results.every(row => row.status === 'UNKNOWN'));
  assert.equal(status(null, 100), 'UNKNOWN');
  assert.equal(status(0, null), 'UNKNOWN');
});

test('预算区分预警、限制、用尽和超额', () => {
  for (const [used, expected] of [
           [0, 'OK'], [69, 'OK'], [70, 'WARN'], [84, 'WARN'], [85, 'RESTRICT'],
           [99, 'RESTRICT'], [100, 'AT_LIMIT'], [101, 'EXCEEDED']]) {
    assert.equal(status(used, 100), expected);
  }
  assert.equal(status(0, 0), 'AT_LIMIT');
  assert.equal(status(1, 0), 'EXCEEDED');
});

test('不接受负数、无穷或非数字用量', () => {
  for (const invalid of [-1, Infinity, NaN, '10']) {
    assert.throws(() => status(invalid, 100), RangeError);
    assert.throws(() => status(0, invalid), RangeError);
  }
});
