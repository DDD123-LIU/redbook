import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dueStatus } from '../src/orchestrator.mjs';

test('上海时间11:14:59仍未到每日关注批次时间', () => {
  assert.deepEqual(dueStatus('2026-10-23T03:14:59.000Z'), {
    status: 'not_due',
    businessDay: '2026-10-23'
  });
});

test('上海时间恰好11:15及之后允许当日批次入口', () => {
  assert.deepEqual(dueStatus('2026-10-23T03:15:00.000Z'), {
    status: 'due',
    businessDay: '2026-10-23'
  });
  assert.equal(dueStatus(new Date('2026-10-23T03:16:00.000Z')).status, 'due');
});

test('业务日按上海午夜切换，不按UTC日期切换', () => {
  assert.deepEqual(dueStatus('2026-10-23T15:59:59.000Z'), {
    status: 'due',
    businessDay: '2026-10-23'
  });
  assert.deepEqual(dueStatus('2026-10-23T16:00:00.000Z'), {
    status: 'not_due',
    businessDay: '2026-10-24'
  });
});

test('拒绝无效时刻', () => {
  assert.throws(() => dueStatus('invalid'), /valid date/i);
});
