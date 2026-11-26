import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import { mediaLinks } from '../src/delivery/media.ts';
import { mysqlDeliveryRepository } from '../src/delivery/mysql.ts';
import { receiptEvents } from '../src/delivery/policy.ts';
import { wassengerProvider } from '../src/delivery/providers.ts';
import type { Claimed } from '../src/delivery/worker.ts';

const config = {token:'test-token', device:'test-device', connector:'qr', template:null} as const;
const links = mediaLinks('https://tickets.example', 'test-key');

test('reads the number of queued messages rather than the sender capacity', async () => {
  const provider = wassengerProvider(config, links, async (url, options) => {
    assert.equal(String(url), 'https://api.wassenger.com/v1/devices/test-device/queue');
    assert.equal(new Headers(options?.headers).get('Token'), 'test-token');
    return Response.json({queue:{status:'active', size:0, available:500, total:500}});
  });
  assert.deepEqual(await provider.queueStatus(), {status:'active', size:0});
  const bad = wassengerProvider(config, links, async () => Response.json({queue:{status:'active', total:500}}));
  await assert.rejects(bad.queueStatus());
});

test('looks up all statuses and distinguishes cleared, sent, missing and mismatched attempts', async () => {
  const attempts = ['removed', 'sent', 'missing', 'wrong-recipient'].map(reference => ({reference, id:`id-${reference}`, phone:'+94771234567'}));
  const provider = wassengerProvider(config, links, async url => {
    const {searchParams} = new URL(String(url));
    assert.equal(searchParams.get('device'), 'test-device');
    assert.equal(searchParams.get('status'), 'any');
    assert.equal(searchParams.get('reference'), 'removed,sent,missing,wrong-recipient');
    return Response.json([
      {reference:'removed', id:'id-removed', phone:'+94771234567', status:'removed', deliveryStatus:'queued'},
      {reference:'sent', id:'id-sent', phone:'+94771234567', status:'removed', deliveryStatus:'readed'},
      {reference:'wrong-recipient', id:'id-wrong-recipient', phone:'+94771234568', status:'removed'},
    ]);
  });
  assert.deepEqual([...await provider.recoveryStatuses(attempts)], [
    ['removed', 'cleared'], ['sent', 'delivered'], ['missing', 'missing'], ['wrong-recipient', 'unknown'],
  ]);
  const throttled = wassengerProvider(config, links, async () => new Response(null, {status:429}));
  await assert.rejects(throttled.recoveryStatuses(attempts));
});

test('queues retries and resumes the same run in one transaction', async () => {
  const context = {mode:'live', binding:'binding', device:'test-device', approvedBody:null} as const;
  const now = new Date();
  const jobs = [
    {id:'first', reference:'sent', providerStatus:'sent', status:'submitted'},
    {id:'second', reference:'cleared', providerStatus:'queued', status:'submitted'},
    {id:'third', reference:null, status:'queued'},
  ];
  const writes: {sql:string; args:unknown[]}[] = [];
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string, args: unknown[] = []) {
      if (sql.includes('SELECT template, revision')) return [[{eventId:2}]];
      if (sql.includes('FROM outbound_control')) return [[{runId:'run', binding:'binding', paused:1}]];
      if (sql.includes('FROM event_send_queue')) return [[{runId:'run', binding:'binding'}]];
      if (sql.includes('FROM outbound_jobs j')) return [jobs];
      if (sql.trim().startsWith('SELECT')) return [[]];
      writes.push({sql, args});
      return [{affectedRows:1}];
    },
  };
  const repository = mysqlDeliveryRepository({getConnection:async () => connection} as unknown as Pool);
  await assert.rejects(repository.startRecovery(context, 2, 'run', 'first', ['sent'], now));
  assert.deepEqual(writes, []);
  await repository.startRecovery(context, 2, 'run', 'first', ['cleared'], now);
  assert.equal(writes.length, 2);
  assert.match(writes[0].sql, /SET .*recovery_ref/i);
  assert.ok(writes[0].args.includes('cleared'));
  assert.ok(!writes[0].args.includes('sent'));
  assert.match(writes[1].sql, /UPDATE outbound_control SET paused = 0/);
  writes.length = 0;
  await repository.startRecovery(context, 2, 'run', 'first', [], now);
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /UPDATE outbound_control SET paused = 0/);
  writes.length = 0;
  jobs[1].providerStatus = 'sent';
  await assert.rejects(repository.startRecovery(context, 2, 'run', 'first', [], now));
  assert.deepEqual(writes, []);
});

test('a pause holds both kinds of work and a late receipt stops an unstarted retry', async () => {
  const context = {mode:'live', binding:'binding', device:'test-device', approvedBody:null} as const;
  const now = new Date();
  const normal = {id:'normal', invitationId:'invitation-normal', runId:'run', reference:'normal-ref', leaseUntil:new Date(+now + 60_000)} as Claimed;
  const recovery = {...normal, id:'recovery', reference:'resend-ref', recoveryReference:'original-ref'};
  const earlierRecovery = {...normal, id:'earlier-recovery', reference:'earlier-ref', recoveryReference:'earlier-original'};
  let currentRef = recovery.reference;
  let recorded = '';
  let cutoffMoved = false;
  let paused = 1;
  let recoveryReference: string | null = recovery.recoveryReference;
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string, args: unknown[] = []) {
      if (sql.includes('FROM outbound_control')) return [[{runId:'run', binding:'binding', paused}]];
      if (sql.includes('later.sequence >= j.sequence')) return [cutoffMoved ? [{id:recovery.id}] : []];
      if (sql.includes('a.job_id = j.id')) return [[{id:recovery.id, reference:recovery.recoveryReference, status:'submitting', dispatchAt:null, recoveryReference}]];
      if (sql.startsWith('UPDATE outbound_attempts SET provider_status')) recorded = String(args[0]);
      if (sql.startsWith('UPDATE outbound_jobs SET current_ref')) {
        currentRef = String(args[0]);
        recoveryReference = null;
      }
      if (sql.startsWith('UPDATE outbound_jobs SET dispatch_at')) return [{affectedRows:args[2] === currentRef || args[2] === earlierRecovery.reference ? 1 : 0}];
      if (sql.trim().startsWith('SELECT')) return [[...(sql.includes("status IN ('queued', 'submitting')") ? [{id:normal.id}] : [])]];
      return [{affectedRows:1}];
    },
  };
  const repository = mysqlDeliveryRepository({getConnection:async () => connection} as unknown as Pool);
  assert.equal(await repository.authorize(context, normal, now), false);
  assert.equal(await repository.authorize(context, earlierRecovery, now), false);
  paused = 0;
  assert.equal(await repository.authorize(context, earlierRecovery, now), true);
  const receipt = receiptEvents({event:'message:out:ack', device:{id:'test-device'}, data:{id:'old-id', ack:'revoked'}}, 'test-device');
  await repository.receipts('test-device', receipt, now);
  assert.equal(recorded, 'sent');
  assert.equal(currentRef, 'original-ref');
  assert.equal(await repository.authorize(context, recovery, now), false);
  currentRef = recovery.reference;
  recoveryReference = recovery.recoveryReference;
  cutoffMoved = true;
  assert.equal(await repository.authorize(context, recovery, now), false);
  assert.equal(currentRef, 'original-ref');
  recorded = '';
  await repository.receipts('test-device', receipt, now);
  assert.equal(recorded, 'sent');
});
