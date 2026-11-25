import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { FilesService } from '../src/files/service.ts';
import { memoryFilesRepository } from './support/files-repository.ts';

const csv = (ticket: string) => Buffer.from(`Ticket No,Name,Contact\n${ticket},Mira Perera,0771234567`);
const png = () => sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer();

test('rematches uploads when replacing a CSV and keeps the previous import if parsing fails', async t => {
  const path = await mkdtemp(join(tmpdir(), 'dinnerdance-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const service = new FilesService(memoryFilesRepository(), path, 'LK');

  await service.replaceCsv('original.csv', csv('0042'));
  await service.uploadImages([{ filename: '0043.png', bytes: await png() }]);
  let state = await service.read();
  assert.equal(state.matches.rows[0].status, 'missing');
  assert.equal(state.matches.unmatched.length, 1);

  await assert.rejects(service.replaceCsv('bad.csv', Buffer.from('Name\nMira')), /Missing required column/);
  assert.equal((await service.read()).csv?.filename, 'original.csv');

  await service.replaceCsv('replacement.csv', csv('0043'));
  state = await service.read();
  assert.equal(state.matches.rows[0].status, 'matched');
  assert.equal(state.matches.unmatched.length, 0);
});

test('reports invalid files and stores valid image versions in the same batch', async t => {
  const path = await mkdtemp(join(tmpdir(), 'dinnerdance-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const repository = memoryFilesRepository();
  const service = new FilesService(repository, path, 'LK');
  const bytes = await png();

  const result = await service.uploadImages([
    { filename: '../escape.png', bytes },
    { filename: 'broken.png', bytes: Buffer.from('invalid') },
    { filename: '0042.png', bytes },
  ]);
  assert.deepEqual(result.uploaded, ['0042.png']);
  assert.deepEqual(result.errors.map(error => error.filename), ['../escape.png', 'broken.png']);
  const first = (await service.read()).images[0];
  const fromFreshService = new FilesService(repository, path, 'LK');
  const saved = await fromFreshService.openImage(first.id);
  assert.ok(saved);
  assert.deepEqual(await readFile(saved.path), bytes);
  assert.equal(await service.openImage('../escape.png'), null);

  await service.uploadImages([{ filename: '0042.png', bytes }]);
  const second = (await service.read()).images[0];
  assert.notEqual(second.id, first.id);
  assert.equal(await service.removeDraftImage(first.id), false);
  assert.equal(await service.removeDraftImage(second.id), true);
  assert.ok(await service.openImage(first.id));
  assert.equal((await service.read()).images.length, 0);
});
