import assert from 'node:assert/strict';
import test from 'node:test';
import { csrf, testSite } from './support/http.ts';
import { EventConflictError } from '../src/events/model.ts';

test('creates, switches and schedules events independently, then archives explicitly', async t => {
  const original = { id:1, name:'Dinner Dance', createdAt:new Date(), archivedAt:null, archivedMode:null };
  const archived = { ...original, archivedAt:new Date(), archivedMode:'live' };
  const invitation = { id:'saved-invitation', ticketNumber:'0042', name:'Archived guest', phone:'+94771234567',
    imageId:'old-image', message:'Your ticket', status:'queued' as const, updatedAt:original.createdAt };
  let active = original;
  let next: typeof original | undefined;
  let isArchived = false;
  let scheduled = false;
  let firstRunning = true;
  let pending = 2;
  let providerStatus = 'sent';
  const { base, signIn, invitationsService } = await testSite(t, {
    settings:{mode:'live', binding:'fixture', perMinute:8, webhookSecret:'', provider:{device:'fixture', template:null}},
    repository:{
      async dashboard(_context, id) {
        return {state:id === 1 && firstRunning ? 'running' : id === 2 && scheduled ? 'scheduled' : 'waiting', liveReady:true, jobs:[]};
      },
      async start(_context, _now, id) { assert.equal(id, 2); scheduled = true; },
      async archivedJobs(id, mode) {
        assert.equal(id, 1);
        if (mode === 'simulate') return [];
        return [{ ...invitation, id:'old-job', invitationId:invitation.id, mode, status:'submitted', providerStatus }];
      },
    },
  }, {
    async preview() { return { event:active, pending, inFlight:false, open:[...(isArchived ? [] : [original]), ...(next ? [next] : [])], archived:isArchived ? [archived] : [] }; },
    async findArchived(id) { return isArchived && id === 1 ? archived : null; },
    async create(expectedId, name) {
      assert.equal(expectedId, active.id);
      next = active = { ...original, id:2, name };
    },
    async select(id) { active = id === 1 ? original : next!; },
    async archive(expectedId, expectedPending) {
      if (expectedId !== active.id || expectedPending !== pending) throw new EventConflictError('Review the new pending count.');
      active = next!;
      isArchived = true;
    },
  });
  invitationsService.readDraft = async () => ({ eventId:active.id, eventName:active.name, template:null, revision:active.id });
  invitationsService.readQueue = async eventId => eventId === 1 ? [invitation] : [{...invitation, id:'second', name:'Second guest'}];
  const url = `${base}/events`;
  assert.equal((await fetch(url, {redirect:'manual'})).headers.get('location'), '/login');
  const headers = await signIn();
  const page = await (await fetch(url, {headers})).text();
  assert.match(page, /Create event/);
  const post = (path: string, fields: Record<string, string> = {}) => fetch(`${base}${path}`, { method:'POST', redirect:'manual', headers,
    body:new URLSearchParams({_csrf:csrf(page), ...fields}) });
  assert.equal((await post('/events', {_csrf:'invalid'})).status, 403);
  const started = await post('/events', {eventId:'1', name:'New Dinner & Dance'});
  assert.equal(started.status, 303);
  assert.equal(started.headers.get('location'), '/files?notice=event');
  assert.equal(active.name, 'New Dinner & Dance');
  const openEvents = await (await fetch(url, {headers})).text();
  assert.match(openEvents, /action="\/events\/1\/select"/);
  assert.equal((await fetch(`${url}/1/queue`, {headers})).status, 404);
  assert.match(await (await fetch(`${base}/queue`, {headers})).text(), /Second guest/);
  assert.equal((await post('/queue/control', {eventId:'2', action:'start', consent:'yes'})).status, 303);
  assert.match(await (await fetch(`${base}/queue`, {headers})).text(), /Scheduled to send/);
  assert.equal((await post('/events/1/select')).status, 303);
  assert.match(await (await fetch(`${base}/queue`, {headers})).text(), /Pause sending/);
  assert.match(await (await fetch(url, {headers})).text(), /2 pending invitations/);
  assert.equal((await post('/events/1/archive', {pending:'2'})).status, 422);
  const conflict = await post('/events/1/archive', {pending:'1', confirm:'yes'});
  assert.equal(conflict.status, 409);
  assert.match(await conflict.text(), /Review the new pending count/);
  assert.equal(active.id, 1);
  firstRunning = false;
  pending = 0;
  assert.equal((await post('/events/1/archive', {pending:'0', confirm:'yes'})).status, 303);
  const history = await (await fetch(url, {headers})).text();
  assert.match(history, /New Dinner &amp; Dance/);
  assert.match(history, /href="\/events\/1\/queue"/);
  const oldQueue = await (await fetch(`${url}/1/queue`, {headers})).text();
  assert.match(oldQueue, /Dinner Dance.*delivery history/i);
  assert.match(oldQueue, /Archived guest/);
  assert.match(oldQueue, /class="status delivery-sent">Sent</);
  assert.doesNotMatch(oldQueue, /\/queue\/(control|retry)|\/remove/);
  const simulationHistory = await (await fetch(`${url}/1/queue?mode=simulate`, {headers})).text();
  assert.match(simulationHistory, /class="status delivery-unsent">Unsent</);
  providerStatus = 'delivered';
  assert.match(await (await fetch(`${url}/1/queue`, {headers})).text(), /class="status delivery-delivered">Delivered</);
  const newQueue = await (await fetch(`${base}/queue`, {headers})).text();
  assert.doesNotMatch(newQueue, /Archived guest/);
  assert.match(newQueue, /Scheduled to send/);
  const oldFiles = await (await fetch(`${url}/1/files`, {headers})).text();
  assert.match(oldFiles, /Dinner Dance.*tickets/i);
  assert.doesNotMatch(oldFiles, /type="file"|\/remove/);
  assert.equal((await fetch(`${url}/2/files`, {headers})).status, 404);
});
