import assert from 'node:assert/strict';
import test from 'node:test';
import { csrf, testSite } from './support/http.ts';
import { EventConflictError } from '../src/events/model.ts';

test('confirms an event switch and opens read-only history', async t => {
  const original = { id:1, name:'Dinner Dance', createdAt:new Date(), archivedAt:null, archivedMode:null };
  const archived = { ...original, archivedAt:new Date(), archivedMode:'live' };
  const invitation = { id:'saved-invitation', ticketNumber:'0042', name:'Archived guest', phone:'+94771234567',
    imageId:'old-image', message:'Your ticket', status:'queued' as const, updatedAt:original.createdAt };
  let active = original;
  let pending = 2;
  let providerStatus = 'sent';
  const { base, signIn, invitationsService } = await testSite(t, {
    settings:{mode:'live', binding:'fixture', perMinute:8, webhookSecret:'', provider:{device:'fixture', template:null}},
    repository:{
      async dashboard() { return {state:'waiting', liveReady:true, jobs:[]}; },
      async archivedJobs(id, mode) {
        assert.equal(id, 1);
        if (mode === 'simulate') return [];
        return [{ ...invitation, id:'old-job', invitationId:invitation.id, mode, status:'submitted', providerStatus }];
      },
    },
  }, {
    async preview() { return { event:active, pending, inFlight:false, archived:active.id === 1 ? [] : [archived] }; },
    async findArchived(id) { return active.id === 2 && id === 1 ? archived : null; },
    async startNext(expectedId, expectedPending, name) {
      if (expectedId !== active.id || expectedPending !== pending) throw new EventConflictError('Review the new pending count.');
      active = { ...original, id:2, name };
      pending = 0;
    },
  });
  invitationsService.readDraft = async () => ({ eventId:active.id, template:null, revision:active.id });
  invitationsService.readQueue = async eventId => eventId === 1 ? [invitation] : [];
  const url = `${base}/events`;
  assert.equal((await fetch(url, {redirect:'manual'})).headers.get('location'), '/login');
  const headers = await signIn();
  const page = await (await fetch(url, {headers})).text();
  assert.match(page, /2 pending invitations/);
  const post = (fields: Record<string, string>) => fetch(url, { method:'POST', redirect:'manual', headers,
    body:new URLSearchParams({_csrf:csrf(page), eventId:'1', pending:'2', name:'New Dinner & Dance', ...fields}) });
  assert.equal((await post({_csrf:'invalid', confirm:'yes'})).status, 403);
  assert.equal((await post({})).status, 422);
  const conflict = await post({pending:'1', confirm:'yes'});
  assert.equal(conflict.status, 409);
  assert.match(await conflict.text(), /Review the new pending count/);
  assert.equal(active.id, 1);
  const started = await post({confirm:'yes'});
  assert.equal(started.status, 303);
  assert.equal(started.headers.get('location'), '/files?notice=event');
  assert.equal(active.name, 'New Dinner & Dance');
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
  assert.match(newQueue, /disabled>Start sending/);
  const oldFiles = await (await fetch(`${url}/1/files`, {headers})).text();
  assert.match(oldFiles, /Dinner Dance.*tickets/i);
  assert.doesNotMatch(oldFiles, /type="file"|\/remove/);
  assert.equal((await fetch(`${url}/2/files`, {headers})).status, 404);
});
