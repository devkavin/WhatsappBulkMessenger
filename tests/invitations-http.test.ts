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
  const pageSize = original.match(/<select\b[^>]*\bdata-page-size\b[^>]*>([\s\S]*?)<\/select>/)?.[1];
  assert.ok(pageSize, 'Recipients shows a rows-per-page selector');
  assert.deepEqual([...pageSize.matchAll(/<option value="(\d+)"/g)].map(match => match[1]), ['10', '25', '50', '100']);
  assert.match(pageSize, /<option value="25" selected>/);

  const editor = await (await fetch(`${base}/recipients?edit=1`, { headers })).text();
  assert.match(editor, /WhatsApp preview/);
  assert.match(editor, /class="message-preview-image" src="\/files\/images\/[^"\s]+" alt="Ticket 0042"/);
  assert.match(editor, /data-message-preview data-ticket-number="0042">You’re invited to the Dinner Dance! Ticket 0042\.<\/p>/);

  async function post(path: string, entries: Record<string, string>) {
    return fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers, body: new URLSearchParams(entries) });
  }

  const badEdit = await post('/recipients/message', { _csrf: token, template: 'Hello {{name}}.' });
  assert.equal(badEdit.status, 422);
  const invalidEditor = await badEdit.text();
  assert.match(invalidEditor, /only supported variable/);
  assert.match(invalidEditor, /data-message-preview data-ticket-number="0042">Hello \{\{name\}\}\.<\/p>/);
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
