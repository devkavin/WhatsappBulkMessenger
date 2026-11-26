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
      if (sql.includes('SELECT template, revision')) return [[{eventId:1, template:'Ticket {{ticket_number}}', revision:10}]];
      if (sql.includes('SELECT run_id AS runId')) return [[{runId:'run-1', binding:'simulation', paused:0}]];
      if (sql.includes('AS inFlight')) return [[work]];
      if (sql.includes('WHERE e.id = ? AND e.archived_at IS NULL')) return [values[0] === 99 ? [] : [{id:values[0]}]];
      if (sql.startsWith('INSERT INTO invitation_events')) return [{insertId:2}];
      if (sql.includes('SELECT id, draft_template AS template')) return [[{id:2, template:'Other {{ticket_number}}'}]];
      if (/^(UPDATE|DELETE)/.test(sql)) return [{affectedRows:0}];
      throw new Error(`Unexpected query ${sql}`);
    },
  };
  const pool = { async getConnection() { return connection; } } as unknown as Pool;
  return { events:mysqlEventsRepository(pool, {mode:'live', binding:'fixture'}), delivery:mysqlDeliveryRepository(pool), executed, transaction };
}

test('creating and switching events leaves the worker and outbound jobs alone', async () => {
  const { events, executed } = fixture();
  await events.create(1, 'Next event', now);
  assert.deepEqual(executed.slice(1).map(({values}) => values), [['Next event', now], ['Ticket {{ticket_number}}', 1], [2, null]]);
  executed.length = 0;
  await events.select(2);
  assert.deepEqual(executed.slice(1).map(({values}) => values), [[2], ['Ticket {{ticket_number}}', 1], [2, 'Other {{ticket_number}}']]);
  assert.ok(executed.every(({sql}) => !/outbound_|event_send_queue/.test(sql)));
});

test('archiving cancels only the selected event’s scheduled work', async () => {
  const { events, executed, transaction } = fixture();
  await events.archive(1, 2, now);
  assert.deepEqual(transaction, ['begin', 'commit', 'release']);
  assert.match(executed[0].sql, /invitation_draft.*FOR UPDATE/);
  assert.match(executed[1].sql, /outbound_control.*FOR UPDATE/);
  assert.deepEqual(executed[3].values, [1, 'live', 1]);
  assert.match(executed[3].sql, /j\.mode = \?/);
  assert.match(executed[5].sql, /s\.event_id = \? AND \(j\.status = 'queued' OR \(j\.status = 'submitting' AND j\.dispatch_at IS NULL\)\)/);
  assert.deepEqual(executed[5].values, [now, 1]);
  assert.match(executed[6].sql, /q\.run_id = c\.run_id[\s\S]+q\.event_id = \?/);
  assert.deepEqual(executed[6].values, [1]);
  assert.deepEqual(executed[7].values, [1]);
  assert.deepEqual(executed[8].values, [now, 'live', 1]);
  assert.deepEqual(executed[9].values, [2, 'Other {{ticket_number}}']);
});

test('archiving an unselected event leaves the selected event in place', async () => {
  const {events, executed} = fixture();
  await events.archive(2, 2, now);
  assert.ok(!executed.some(({sql}) => sql.startsWith('UPDATE invitation_draft')));
  assert.deepEqual(executed.find(({sql}) => sql.startsWith('DELETE FROM event_send_queue'))?.values, [2]);
});

test('rolls back a stale confirmation or an in-flight dispatch before writing', async () => {
  for (const [eventId, count, inFlight, message] of [
    [1, 1, 0, /pending count changed/],
    [1, 2, 1, /submission is in progress/],
    [99, 2, 0, /already archived or unavailable/],
  ] as const) {
    const { events, executed, transaction } = fixture({ pending:2, inFlight });
    await assert.rejects(events.archive(eventId, count, now), error =>
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
