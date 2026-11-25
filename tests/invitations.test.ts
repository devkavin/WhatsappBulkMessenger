import assert from 'node:assert/strict';
import test from 'node:test';
import { InvitationsService } from '../src/invitations/service.ts';
import { FilesService } from '../src/files/service.ts';
import { memoryFilesRepository } from './support/files-repository.ts';
import { memoryInvitationsRepository } from './support/invitations-repository.ts';

const csv = Buffer.from('Ticket No,Rank,Name,Contact\n0042,Capt.,Mira,0771234567\n0043,Lt.,Ravi,0771234567\n0044,,Priya,');

async function setup() {
  const invitations = memoryInvitationsRepository();
  const files = memoryFilesRepository(() => invitations.advanceRevision());
  const fileService = new FilesService(files, 'unused-by-these-tests', 'LK');
  await fileService.replaceCsv('guests.csv', csv);
  await files.addImage({ id: 'image-42-v1', filename: '0042.png', contentType: 'image/png' });
  await files.addImage({ id: 'image-43', filename: '0043.png', contentType: 'image/png' });
  await files.addImage({ id: 'image-44', filename: '0044.png', contentType: 'image/png' });
  return { files, fileService, invitations, service: new InvitationsService(fileService, invitations) };
}

test('requires the ticket variable and rejects unknown variables before saving a message', async () => {
  const { service } = await setup();
  await assert.rejects(service.saveMessage('You’re invited!'), /ticket_number/);
  await assert.rejects(service.saveMessage('Ticket {{ticket_number}}, hello {{name}}'), /ticket_number/);
  await assert.rejects(service.saveMessage('Ticket {{ticket_number}} with {{broken'), /ticket_number/);
  assert.match((await service.review()).template, /Dinner Dance/);
});

test('queues only the selected ticket once and preserves the exact reviewed invitation', async () => {
  const { files, service } = await setup();
  await service.saveMessage('See you at the dance.\nTicket {{ticket_number}}.');
  const review = await service.review();
  assert.deepEqual(review.rows.map(row => row.status), ['ready', 'ready', 'attention']);
  assert.equal(review.rows[0].message, 'See you at the dance.\nTicket 0042.');
  await assert.rejects(service.stage(review.version, ['0042', '0044']), /no longer eligible/);
  assert.equal((await service.readQueue()).length, 0);
  assert.equal(await service.stage(review.version, ['0042']), 1);
  assert.equal(await service.stage(review.version, ['0042']), 0);
  await files.addImage({ id: 'image-42-v2', filename: '0042.png', contentType: 'image/png' });
  await service.saveMessage('Welcome! Ticket {{ticket_number}}.');

  const [queued] = await service.readQueue();
  assert.equal(queued.phone, '+94771234567');
  assert.equal(queued.ticketNumber, '0042');
  assert.equal(queued.imageId, 'image-42-v1');
  assert.equal(queued.message, 'See you at the dance.\nTicket 0042.');
  assert.equal(queued.status, 'queued');
  assert.deepEqual((await service.review()).rows.map(row => row.status), ['queued', 'ready', 'attention']);
});

test('rejects stale reviews and allows a removed ticket to be staged from a fresh review', async () => {
  const { files, service } = await setup();
  const beforeImageChange = await service.review();
  await files.addImage({ id: 'image-42-v2', filename: '0042.png', contentType: 'image/png' });
  await assert.rejects(service.stage(beforeImageChange.version, ['0042']), /review the updated invitations/i);
  const first = await service.review();
  await service.stage(first.version, ['0042']);
  const [queued] = await service.readQueue();
  assert.equal(await service.remove(queued.id), true);
  await assert.rejects(service.stage(first.version, ['0042']), /review the updated invitations/i);

  await service.saveMessage('Corrected ticket {{ticket_number}}.');
  const corrected = await service.review();
  assert.equal(await service.stage(corrected.version, ['0042']), 1);
  const history = await service.readQueue();
  assert.deepEqual(history.map(item => item.status), ['removed', 'queued']);
  assert.equal(history[1].message, 'Corrected ticket 0042.');
});

test('rechecks the shared file revision before committing a staged invitation', async () => {
  const { files, fileService, invitations } = await setup();
  const service = new InvitationsService(fileService, {
    ...invitations,
    async stage(items, expected) {
      await files.addImage({ id: 'image-42-v2', filename: '0042.png', contentType: 'image/png' });
      return invitations.stage(items, expected);
    },
  });
  const review = await service.review();
  await assert.rejects(service.stage(review.version, ['0042']), /review the updated invitations/i);
  assert.equal((await service.readQueue()).length, 0);
});

test('retries a review read if an image changes while the draft is loaded', async () => {
  const { files, fileService, invitations } = await setup();
  let changed = false;
  const service = new InvitationsService({
    async read() {
      const state = await fileService.read();
      if (!changed) {
        changed = true;
        await files.addImage({ id: 'image-42-v2', filename: '0042.png', contentType: 'image/png' });
      }
      return state;
    },
  }, invitations);
  assert.equal((await service.review()).rows[0].images[0].id, 'image-42-v2');
});

test('stages a compact browser selection against the reviewed order', async () => {
  const { service } = await setup();
  const review = await service.review();
  await assert.rejects(service.stage(review.version, { bitmap: '_w' }), /selection is invalid/);
  await assert.rejects(service.stage(review.version, { bitmap: 'AAAA' }), /selection is invalid/);
  assert.equal(await service.stage(review.version, { bitmap: 'Ag' }), 1);
  assert.deepEqual((await service.readQueue()).map(row => row.ticketNumber), ['0043']);
});
