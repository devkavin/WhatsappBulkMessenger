import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import { mediaLinks } from '../src/delivery/media.ts';
import { mysqlDeliveryRepository } from '../src/delivery/mysql.ts';
import { receiptEvents, retryDelay, submissionGap } from '../src/delivery/policy.ts';
import type { DeliveryStatus } from '../src/delivery/policy.ts';
import { simulate, wassengerProvider } from '../src/delivery/providers.ts';
import { deliveryWorker } from '../src/delivery/worker.ts';
import type { Claimed } from '../src/delivery/worker.ts';

const id = '00000000-0000-4000-8000-000000000042';
const invitation = { ticketNumber: '0042', name: 'Fixture', phone: '+94771234567', imageId: id, message: 'See you! Ticket 0042.' };

test('paces submissions within the configured ceiling and respects Retry-After', () => {
  assert.equal(submissionGap(8, 0), 7500);
  assert.ok(submissionGap(8, 0.9) > 7500);
  assert.equal(submissionGap(4, 0), 15000);
  assert.equal(retryDelay('30', 0), 30000);
  assert.equal(retryDelay('Thu, 01 Jan 1970 00:01:00 GMT', 1000), 59000);
});

test('media links are scoped to an image and expire without a session', () => {
  const links = mediaLinks('https://tickets.example.test', 'synthetic secret for test fixtures');
  const url = new URL(links.forImage(id, 1000));
  const parts = url.pathname.split('/').slice(-3);
  assert.equal(links.verify(parts[0], parts[1], parts[2], 2000), true);
  assert.equal(links.verify(id.replace('42', '43'), parts[1], parts[2], 2000), false);
  assert.equal(links.verify(parts[0], parts[1], parts[2], 1000 + 86_400_001), false);
});

test('accepts delivered receipts and batched failures only for the configured device', () => {
  assert.deepEqual(receiptEvents({ event: 'message:out:ack', device: { id: 'other' }, ack: 'read', data: { id: 'p1' } }, 'device'), []);
  assert.deepEqual(receiptEvents({ event: 'message:out:new', device: { id: 'device' }, data: { id: 'p1', ack: 'sent' } }, 'device'), [
    { ids: ['p1'], reference: null, status: 'sent', event: 'message:out:new' },
  ]);
  assert.deepEqual(receiptEvents({ event: 'message:out:new', device: { id: 'device' }, data: { id: 'p1' } }, 'device'), [
    { ids: ['p1'], reference: null, status: 'sent', event: 'message:out:new' },
  ]);
  assert.deepEqual(receiptEvents([
    { event: 'message:out:ack', device: { id: 'device' }, ack: 'read', data: { id: 'p1' } },
    { event: 'message:out:failed', entityId: 'p2', data: { device: { id: 'device' }, reference: `dd-${id}` } },
  ], 'device').map(receipt => [receipt.status, receipt.ids, receipt.reference]), [
    ['delivered', ['p1'], null], ['failed', ['p2'], `dd-${id}`],
  ]);
});

test('an early matched sent webhook confirms handoff even if the submission response is lost', async () => {
  const reference = `dd-${id}`;
  const now = new Date('2026-11-25T18:00:00.000Z');
  const job: Claimed = { ...invitation, id, reference, status:'submitting', mode:'live', invitationId:id,
    runId:null, note:null, retryable:0, updatedAt:now, leaseUntil:new Date(+now + 60_000) };
  const row = { ...job, status: 'submitting' as DeliveryStatus, attemptCount: 1 };
  const webhookUpdates: unknown[][] = [];
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string, args: unknown[] = []) {
      if (sql.includes('FROM outbound_control')) return [[{runId:null}]];
      if (sql.includes('a.provider_id IS NULL LIMIT 1')) {
        assert.match(sql, /j.status IN \('submitting', 'submitted'\)/);
        return [[{id:job.id}]];
      }
      if (args.includes('unrecorded-provider-id')) return [[]];
      if (sql.includes('FROM outbound_jobs j')) return [[row]];
      if (sql.startsWith('UPDATE outbound_attempts SET provider_webhook')) webhookUpdates.push(args);
      if (sql.startsWith('UPDATE outbound_jobs SET status')) row.status = args[0] as DeliveryStatus;
      return [{affectedRows:1}];
    },
  };
  const repository = mysqlDeliveryRepository({ async getConnection() { return connection; } } as unknown as Pool);
  const early = receiptEvents({ event:'message:out:new', device:{id:'device'}, data:{reference} }, 'device');
  assert.equal(await repository.receipts('device', early, now), true);
  assert.equal(row.status, 'submitted');
  const idOnly = receiptEvents({ event:'message:out:new', device:{id:'device'}, data:{id:'unrecorded-provider-id', ack:'delivered'} }, 'device');
  assert.equal(await repository.receipts('device', idOnly, now), false);
  await repository.finish(job, {status:'review', note:'Response lost'}, now, 8000);
  assert.equal(row.status, 'submitted');
  assert.deepEqual(webhookUpdates, [['message:out:new', now, reference, now]]);
});

test('the live adapter sends the configured template, media and attempt reference', async () => {
  let sent: Record<string, unknown> = {};
  const provider = wassengerProvider({
    token: 'fixture-key', device: 'device', connector: 'business',
    template: { name: 'dinner_dance_ticket', language: 'en_US', body: 'See you! Ticket {{ticket_number}}.' },
  }, mediaLinks('https://tickets.example.test', 'synthetic-secret'), async (target, request) => {
    assert.equal(target, 'https://api.wassenger.com/v1/messages');
    sent = JSON.parse(String(request?.body));
    return Response.json({ id: 'provider-id', deliveryStatus: 'queued' }, {status: 201});
  });
  assert.deepEqual(await provider.send(invitation, `dd-${id}`), {status: 'submitted', id: 'provider-id', alias: null, providerStatus: 'queued'});
  assert.equal(sent.reference, `dd-${id}`);
  assert.equal(sent.device, 'device');
  const { header, ...template } = sent.template as { header: { media: {type:string; url:string} } };
  assert.deepEqual(template, { name: 'dinner_dance_ticket', language: 'en_US', body: [{name:'1', value:'0042'}] });
  assert.equal(header.media.type, 'image');
  assert.match(header.media.url, /^https:\/\/tickets\.example\.test\/delivery-media\//);
  assert.equal((await provider.send({...invitation, message: 'Different wording'}, `dd-${id}`)).status, 'failed');
  assert.equal((await simulate.send(invitation, `dd-${id}`)).status, 'delivered');
});

test('a provider throttle is retryable and a lost response requires review', async () => {
  const settings = {token: 'fixture-key', device: 'device', connector: 'qr' as const, template:null};
  const media = mediaLinks('https://tickets.example.test', 'synthetic-secret');
  const throttled = wassengerProvider(settings, media, async () => new Response('', {status:429, headers:{'Retry-After':'25'}}));
  assert.deepEqual(await throttled.send(invitation, `dd-${id}`), {status:'throttled', delay:25000});
  const lost = wassengerProvider(settings, media, async () => { throw new Error('lost response'); });
  assert.equal((await lost.send(invitation, `dd-${id}`)).status, 'review');
});

test('a pause at the dispatch boundary prevents a claimed job from starting a provider request', async () => {
  const settings = { mode:'simulate', binding:'simulation', perMinute:8, provider:null, webhookSecret:'' } as const;
  const job = { ...invitation, id, reference:`dd-${id}`, leaseUntil:new Date(Date.now() + 60_000) };
  let submitted = false;
  const tick = deliveryWorker({ async claim() { return job; }, async authorize() { return false; }, async finish() {} }, settings,
    { async send() { submitted = true; return {status:'delivered'}; } }, async () => true);
  await tick();
  assert.equal(submitted, false);
});

test('reconciles a lost response only when Wassenger returns one exact recipient and reference match', async () => {
  const reference = `dd-${id}`;
  const lookup = { id:null, reference, phone:invitation.phone };
  const matching = { id:'provider-id', wid:'wa-id', phone:invitation.phone, device:'device', reference, deliveryStatus:'delivered' };
  let records = [matching, {...matching, phone:'+94770000000'}];
  const provider = wassengerProvider({token:'fixture', device:'device', connector:'qr', template:null},
    mediaLinks('https://tickets.example.test','synthetic-secret'), async (target, options) => {
      const url = new URL(String(target));
      assert.equal(url.pathname, '/v1/messages');
      assert.equal(url.searchParams.get('device'), 'device');
      assert.equal(url.searchParams.get('reference'), reference);
      assert.equal(options?.method, undefined);
      return Response.json(records);
    });
  assert.deepEqual(await provider.check!(lookup), {observation:{id:'provider-id', alias:'wa-id',status:'delivered'}});
  records = [matching, {...matching, id:'second-id'}];
  assert.deepEqual(await provider.check!(lookup), {});
});
