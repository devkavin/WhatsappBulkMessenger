import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import { mysqlEventsRepository } from '../src/events/mysql.ts';
import { mysqlDeliveryRepository } from '../src/delivery/mysql.ts';
import { EventConflictError } from '../src/events/model.ts';

const now = new Date('2026-11-26T06:00:00Z');

function fixture(work = { pending:2, inFlight:0 }) {
  const executed: { sql:string; values:unknown[] }[] = [];
  const transaction: string[] = [];
  const connection = {
    async beginTransaction() { transaction.push('begin'); },
    async commit() { transaction.push('commit'); },
    async rollback() { transaction.push('rollback'); },
    release() { transaction.push('release'); },
    async execute(sql: string, values: unknown[] = []) {
      executed.push({sql, values});
      if (sql.includes('SELECT template, revision')) return [[{eventId:1, template:null, revision:10}]];
      if (sql.includes('SELECT run_id AS runId')) return [[{runId:'run-1', binding:'simulation', paused:0}]];
      if (sql.includes('AS inFlight')) return [[work]];
      if (sql.startsWith('INSERT INTO invitation_events')) return [{insertId:2}];
      if (/^UPDATE/.test(sql)) return [{affectedRows:0}];
      throw new Error(`Unexpected query ${sql}`);
    },
  };
  const pool = { async getConnection() { return connection; } } as unknown as Pool;
  return { events:mysqlEventsRepository(pool, 'live'), delivery:mysqlDeliveryRepository(pool), executed, transaction };
}

test('cancels only the old event’s pending jobs before switching the active event', async () => {
  const { events, executed, transaction } = fixture();
  await events.startNext(1, 2, 'Next event', now);
  assert.deepEqual(transaction, ['begin', 'commit', 'release']);
  assert.match(executed[0].sql, /invitation_draft.*FOR UPDATE/);
  assert.match(executed[1].sql, /outbound_control.*FOR UPDATE/);
  assert.deepEqual(executed[2].values, [1, 'live', 1]);
  assert.match(executed[2].sql, /j\.mode = \?/);
  assert.match(executed[3].sql, /s\.event_id = \? AND \(j\.status = 'queued' OR \(j\.status = 'submitting' AND j\.dispatch_at IS NULL\)\)/);
  assert.deepEqual(executed[3].values, [now, 1]);
  assert.match(executed[4].sql, /SET run_id = NULL, binding = NULL, paused = 0/);
  assert.deepEqual(executed[5].values, [now, 'live', 1]);
  assert.deepEqual(executed[6].values, ['Next event', now]);
  assert.deepEqual(executed[7].values, [2]);
});

test('rolls back a stale confirmation or an in-flight dispatch before writing', async () => {
  for (const [eventId, count, inFlight, message] of [
    [1, 1, 0, /pending count changed/],
    [1, 2, 1, /submission is in progress/],
    [2, 2, 0, /active event changed/],
  ] as const) {
    const { events, executed, transaction } = fixture({ pending:2, inFlight });
    await assert.rejects(events.startNext(eventId, count, 'Next event', now), error =>
      error instanceof EventConflictError && message.test(error.message));
    assert.ok(executed.every(({sql}) => sql.startsWith('SELECT')));
    assert.deepEqual(transaction, ['begin', 'rollback', 'release']);
  }
});

test('rejects queue controls for a previous event before locking delivery work', async () => {
  const context = {mode:'simulate', binding:'simulation', device:null, approvedBody:null} as const;
  for (const command of [
    (delivery: ReturnType<typeof mysqlDeliveryRepository>) => delivery.start(context, now, 2),
    (delivery: ReturnType<typeof mysqlDeliveryRepository>) => delivery.pause(context, false, 2),
    (delivery: ReturnType<typeof mysqlDeliveryRepository>) => delivery.endChangedBatch(context, now, 2),
  ]) {
    const { delivery, executed, transaction } = fixture();
    await assert.rejects(command(delivery), { message:/active event changed/ });
    assert.equal(executed.length, 1);
    assert.match(executed[0].sql, /invitation_draft.*FOR UPDATE/);
    assert.deepEqual(transaction, ['begin', 'rollback', 'release']);
  }
});
