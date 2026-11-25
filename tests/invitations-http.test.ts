import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { csrf, testSite } from './support/http.ts';

test('reviews, edits, stages and withdraws invitations through authenticated forms', async t => {
  const { base, filesService, invitationsService, signIn } = await testSite(t);
  for (const path of ['/recipients', '/queue']) {
    const response = await fetch(`${base}${path}`, { redirect: 'manual' });
    assert.equal(response.headers.get('location'), '/login');
  }

  await filesService.replaceCsv('guests.csv', Buffer.from('Ticket No,Name,Contact\n0042,Mira,0771234567\n0043,Ravi,0771234567'));
  const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer();
  await filesService.uploadImages([{ filename: '0042.png', bytes }]);
  const headers = await signIn();
  const original = await (await fetch(`${base}/recipients`, { headers })).text();
  const token = csrf(original);
  assert.match(original, /Ticket 0042\./);
  assert.match(original, /Missing image/);
  assert.match(original, /name="ticket" value="0042" checked/);
  assert.equal(original.includes('name="ticket" value="0043"'), false);

  async function post(path: string, entries: Record<string, string>) {
    return fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers, body: new URLSearchParams(entries) });
  }

  const badEdit = await post('/recipients/message', { _csrf: token, template: 'Hello {{name}}.' });
  assert.equal(badEdit.status, 422);
  assert.match(await badEdit.text(), /only supported variable/);
  const edit = await post('/recipients/message', { _csrf: token, template: 'See you there! Ticket {{ticket_number}}.' });
  assert.equal(edit.status, 303);
  const page = await (await fetch(`${base}/recipients`, { headers })).text();
  assert.match(page, /See you there! Ticket 0042\./);
  const version = page.match(/name="version" value="([\w-]+)"/)?.[1];
  assert.ok(version);
  assert.equal((await post('/recipients/stage', { version, ticket: '0042' })).status, 403);

  const staged = await post('/recipients/stage', { _csrf: token, version, ticket: '0042' });
  assert.equal(staged.headers.get('location'), '/queue?added=1');
  const duplicate = await post('/recipients/stage', { _csrf: token, version, ticket: '0042' });
  assert.equal(duplicate.headers.get('location'), '/queue?added=0');
  const queue = await (await fetch(`${base}/queue`, { headers })).text();
  assert.match(queue, /See you there! Ticket 0042\./);
  assert.match(queue, /disabled>Start sending/);
  assert.equal(queue.includes('Ravi'), false);
  const [row] = await invitationsService.readQueue();
  const removed = await post(`/queue/${row.id}/remove`, { _csrf: token });
  assert.equal(removed.status, 303);
  assert.match(await (await fetch(`${base}/queue?view=removed`, { headers })).text(), /Mira/);
  assert.equal((await invitationsService.readQueue())[0].status, 'removed');
});
