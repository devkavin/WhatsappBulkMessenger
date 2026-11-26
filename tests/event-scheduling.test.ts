import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import { mysqlDeliveryRepository } from '../src/delivery/mysql.ts';

const context = {mode:'simulate', binding:'simulation', device:null, approvedBody:null} as const;
const now = new Date('2026-11-26T06:00:00Z');

function fixture(active: string | null, pending: boolean) {
  const updates: Array<{sql:string; params:unknown[]}> = [];
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string, params: unknown[] = []) {
      const query = sql.trim().replace(/\s+/g, ' ');
      if (query.includes('SELECT template, revision')) return [[{ eventId:2, revision:7, template:null }]];
      if (query.includes('SELECT run_id AS runId') && query.includes('FROM outbound_control')) return [[{runId:active, binding:'simulation', paused:0}]];
      if (query.includes('FROM event_send_queue') && query.includes('event_id = ?')) return [[]];
      if (query.includes('FROM event_send_queue') && query.includes('ORDER BY')) return [[{runId:'batch-b', binding:'simulation', eventId:2}]];
      if (query.startsWith('SELECT s.id')) return [[{id:'invitation-b', ticketNumber:'1', name:'Guest', phone:'+94771234567', imageId:'image-b', message:'Ticket 1'}]];
      if (query.includes("status IN ('queued', 'submitting')")) return [pending ? [{id:'invitation-a'}] : []];
      if (query.includes('j.run_id = ?') && params[1] === 'batch-b') return [[{id:'job-b', invitationId:'invitation-b', runId:'batch-b'}]];
      if (query.startsWith('SELECT')) return [[]];
      updates.push({sql:query, params});
      return [{affectedRows:0}];
    },
  };
  return { updates, repository:mysqlDeliveryRepository({ getConnection:async () => connection } as unknown as Pool) };
}

test('Start sending reserves B while A keeps the sender', async () => {
  const {repository, updates} = fixture('batch-a', true);
  await repository.start(context, now, 2);
  const job = updates.find(({sql}) => sql.startsWith('INSERT INTO outbound_jobs'));
  const batch = updates.find(({sql}) => sql.startsWith('INSERT INTO event_send_queue'));
  assert.ok(job && batch);
  assert.equal(job.params[2], batch.params[0]);
  assert.equal(batch.params[1], 2);
  assert.ok(!updates.some(({sql}) => sql.startsWith('UPDATE outbound_control SET run_id')));
});

test('the worker promotes the oldest scheduled batch only when the sender is free', async () => {
  const busy = fixture('batch-a', true);
  await busy.repository.claim(context, now, 1);
  assert.ok(!busy.updates.some(({params}) => params.includes('batch-b')));

  const finished = fixture('batch-a', false);
  const claimed = await finished.repository.claim(context, now, 1);
  assert.equal(claimed?.id, 'job-b');
  assert.ok(finished.updates.some(({sql, params}) => sql.startsWith('UPDATE outbound_control SET run_id = ?') && params.includes('batch-b')));
});
