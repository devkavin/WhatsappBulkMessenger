import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { csrf, testSite } from './support/http.ts';
import { deliveryWorker } from '../src/delivery/worker.ts';
import { simulate } from '../src/delivery/providers.ts';
import { mediaLinks } from '../src/delivery/media.ts';

test('starts a separate test send without touching staged event invitations', async t => {
  const settings = { mode: 'simulate', binding: 'simulation', perMinute: 8, provider: null, webhookSecret: '' } as const;
  const recipients: object[] = [];
  const history: any[] = [];
  const recipientId = '00000000-0000-4000-8000-000000000042';
  const repository = {
    async dashboard() { return { state:'waiting', liveReady:true, jobs:[] }; },
    async testRecipients() { return recipients; },
    async testHistory() { return history; },
    async saveTestRecipient(name, phone) { recipients.push({ id: recipientId, name, phone }); },
    async enqueueTest(_context, ref, selected, invitation, now) {
      assert.deepEqual(selected, [recipientId]);
      history.push({ ...invitation, ...recipients[0], reference: ref, status:'queued', mode:'simulate', updatedAt:now });
    },
    async claim() { return history[0] && { ...history[0], leaseUntil: new Date(Date.now() + 60_000) }; },
    async authorize() { return true; },
    async finish(_job, result) { history[0].status = result.status; },
  };
  const { base, filesService, invitationsService, signIn } = await testSite(t, { repository, settings });
  const anonymous = await fetch(`${base}/test-sends`, {redirect:'manual'});
  assert.equal(anonymous.headers.get('location'), '/login');
  const headers = await signIn();
  const page = await (await fetch(`${base}/test-sends`, {headers})).text();
  const token = csrf(page);
  const add = await fetch(`${base}/test-sends/recipients`, { method:'POST', redirect:'manual', headers,
    body:new URLSearchParams({_csrf:token, name:'Test guest', phone:'0771234567', consent:'yes'}) });
  assert.equal(add.status, 303);
  const updated = await (await fetch(`${base}/test-sends`, {headers})).text();
  const field = (name: string) => updated.match(new RegExp(`name="${name}" value="([\\w-]+)"`))?.[1] ?? '';
  const form = new FormData();
  for (const [name, value] of Object.entries({ _csrf:token, testKey:field('testKey'), version:field('version'), recipient:recipientId, ticket:'TEST-001' })) form.append(name, value);
  const png = await sharp({ create: { width:1, height:1, channels:3, background:'#fff' } }).png().toBuffer();
  form.append('image', new Blob([new Uint8Array(png)]), 'sample.png');
  const send = await fetch(`${base}/test-sends/send`, {method:'POST', redirect:'manual', headers, body:form});
  assert.equal(send.status, 303);
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'queued');
  assert.equal((await filesService.read()).images.length, 0);
  const signed = mediaLinks(base, '12345678901234567890123456789012').forImage(history[0].imageId);
  const image = await fetch(signed);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.equal((await fetch(`${signed}x`)).status, 404);
  await deliveryWorker(repository, settings, simulate, async id => Boolean(await filesService.openImage(id)))();
  assert.equal(history[0].status, 'delivered');
  assert.equal((await invitationsService.readQueue()).length, 0);
  assert.match(await (await fetch(`${base}/test-sends`, {headers})).text(), /Delivered/);
});

test('requires consent to start a live batch and exposes pause and resume for an active batch', async t => {
  const settings = {mode:'live', binding:'fixture', perMinute:8, webhookSecret:'test-fixture-secret-01234567890123',
    provider:{token:'fixture', device:'test-device', connector:'qr', template:null}} as const;
  let state = 'waiting';
  const {base, signIn} = await testSite(t, {settings, repository:{
    async dashboard() { return {state, jobs:[], liveReady:true}; },
    async start(context) { assert.equal(context.device,'test-device'); state = 'running'; },
    async pause(context, paused) { assert.equal(context.binding,'fixture'); state = paused ? 'paused' : 'running'; },
  }});
  const headers = await signIn();
  const token = csrf(await (await fetch(`${base}/queue`, {headers})).text());
  const post = (fields: Record<string,string>) => fetch(`${base}/queue/control`, {method:'POST', redirect:'manual', headers,
    body:new URLSearchParams({_csrf:token, ...fields})});
  const missingConsent = await post({action:'start'});
  assert.equal(missingConsent.status, 409);
  assert.equal(state, 'waiting');
  assert.equal((await post({action:'start', consent:'yes'})).status, 303);
  assert.match(await (await fetch(`${base}/queue`, {headers})).text(), /Pause sending/);
  assert.equal((await post({action:'pause'})).status, 303);
  assert.match(await (await fetch(`${base}/queue`, {headers})).text(), /Resume sending/);
  assert.equal((await post({action:'resume'})).status, 303);
  assert.equal(state, 'running');
});

test('authenticates Wassenger callbacks and forwards only the configured sender receipts', async t => {
  const receipts: unknown[] = [];
  const settings = {mode:'live', binding:'fixture', perMinute:8, webhookSecret:'test-fixture-secret-01234567890123',
    provider:{token:'fixture', device:'test-device', connector:'qr', template:null}} as const;
  const {base} = await testSite(t, {repository:{async receipts(...items) { receipts.push(items); }}, settings});
  const payload = [{event:'message:out:ack', device:{id:'test-device'}, ack:'delivered', data:{id:'a1'}},
    {event:'message:out:ack', device:{id:'orbit-device'}, ack:'read', data:{id:'a2'}}];
  const post = (secret: string) => fetch(`${base}/webhooks/wassenger/`, { method:'POST',
    headers:{'Content-Type':'application/json', 'X-Dinner-Dance-Webhook-Secret':secret}, body:JSON.stringify(payload) });
  assert.equal((await post('wrong')).status, 401);
  assert.equal(receipts.length, 0);
  assert.equal((await post(settings.webhookSecret)).status, 204);
  assert.deepEqual((receipts[0] as any[]).slice(0, 2), ['test-device', [{ids:['a1'], reference:null, status:'delivered', event:'message:out:ack'}]]);

  const postUrl = (query: URLSearchParams, header?: string) => fetch(`${base}/webhooks/wassenger?${query}`, { method:'POST',
    headers:{'Content-Type':'application/json', ...(header ? {'X-Dinner-Dance-Webhook-Secret':header} : {})}, body:JSON.stringify(payload) });
  const valid = new URLSearchParams({secret:settings.webhookSecret});
  assert.equal((await postUrl(valid, 'wrong')).status, 401);
  assert.equal((await postUrl(new URLSearchParams([['secret', 'wrong'], ['secret', settings.webhookSecret]]))).status, 401);
  assert.equal((await postUrl(new URLSearchParams({secret:'wrong'}))).status, 401);
  assert.equal(receipts.length, 1);
  assert.equal((await postUrl(valid)).status, 204);
  assert.equal(receipts.length, 2);
});

test('shows a matched Wassenger webhook separately from the app submission', async t => {
  const now = new Date('2026-11-25T18:00:00.000Z');
  const settings = {mode:'live', binding:'fixture', perMinute:8, webhookSecret:'test-fixture-secret-01234567890123',
    provider:{token:'fixture', device:'test-device', connector:'qr', template:null}} as const;
  const job = { name:'Test guest', phone:'+94771234567', ticketNumber:'TEST-001', mode:'live', status:'submitted', updatedAt:now,
    providerStatus:'queued', providerSource:'submission', webhookEvent:null as string | null, webhookReceivedAt:null as Date | null };
  const staged = { ...job, id:'staged-fixture', imageId:'image-fixture', message:'Your ticket', status:'queued' as const };
  const {base, signIn, invitationsService} = await testSite(t, {settings, repository:{
    async dashboard() { return {state:'waiting', liveReady:true, jobs:[{...job, invitationId:staged.id}]}; },
    async testRecipients() { return []; },
    async testHistory() { return [job]; },
    async receipts(_device, receipts, receivedAt) {
      for (const receipt of receipts) {
        if (!receipt.ids.includes('test-provider-id')) continue;
        job.status = job.providerStatus = receipt.status;
        job.providerSource = 'webhook';
        job.webhookEvent = receipt.event;
        job.webhookReceivedAt = receivedAt;
      }
      return true;
    },
  }});
  invitationsService.readQueue = async () => [staged];
  const headers = await signIn();
  const page = async (path: string) => {
    const response = await fetch(`${base}${path}`, {headers});
    assert.equal(response.status, 200);
    return response.text();
  };
  const before = await page('/test-sends');
  assert.match(before, /App status[\s\S]*Wassenger status[\s\S]*Submitted[\s\S]*Queued/);
  const hook = await fetch(`${base}/webhooks/wassenger?${new URLSearchParams({secret:settings.webhookSecret})}`, {method:'POST',
    headers:{'Content-Type':'application/json'}, body:JSON.stringify({event:'message:out:new', device:{id:'test-device'}, data:{id:'test-provider-id', ack:'delivered'}}) });
  assert.equal(hook.status, 204);
  const after = await page('/test-sends');
  assert.match(after, /Submitted[\s\S]*Delivered[\s\S]*message:out:new/);
  assert.doesNotMatch(after, new RegExp(settings.webhookSecret));
  const queue = await page('/queue?view=delivered');
  assert.match(queue, /<h3>App status<\/h3>[\s\S]*<h3>Wassenger status<\/h3>/);
  assert.match(queue, /<td><span class="status delivery-submitted">Submitted<\/span><\/td>[\s\S]*Delivered[\s\S]*message:out:new/);
});
