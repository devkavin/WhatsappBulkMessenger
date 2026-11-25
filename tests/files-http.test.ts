import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { csrf, testSite } from './support/http.ts';

test('protects the Files workflow and displays matches after CSV and image uploads', async t => {
  const { base, filesService, signIn } = await testSite(t);

  const anonymous = await fetch(`${base}/files`, { redirect: 'manual' });
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get('location'), '/login');
  const unsignedUpload = await fetch(`${base}/files/csv`, { method: 'POST', redirect: 'manual' });
  assert.equal(unsignedUpload.headers.get('location'), '/login');

  const headers = await signIn();
  const filesPage = await fetch(`${base}/files`, { headers });
  const token = csrf(await filesPage.text());

  const form = new FormData();
  form.append('csv', new Blob(['Ticket No,Name,Contact\n0042,Mira Perera,0771234567']), 'guests-සිංහල.csv');
  const rejected = await fetch(`${base}/files/csv`, { method: 'POST', headers, body: form });
  assert.equal(rejected.status, 403);
  assert.equal((await filesService.read()).csv, null);

  form.append('_csrf', token);
  const imported = await fetch(`${base}/files/csv`, {
    method: 'POST', redirect: 'manual', headers, body: form,
  });
  assert.equal(imported.status, 303);
  assert.match(await (await fetch(`${base}/files`, { headers })).text(), /Missing image/);

  const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer();
  const images = new FormData();
  images.append('images', new Blob([new Uint8Array(image)]), '0042.png');
  images.append('images', new Blob([new Uint8Array(5 * 1024 * 1024)]), 'broken.png');
  const uploaded = await fetch(`${base}/files/images`, {
    method: 'POST', headers: { ...headers, 'X-CSRF-Token': token, Accept: 'application/json' }, body: images,
  });
  assert.equal(uploaded.status, 200);
  assert.deepEqual(await uploaded.json(), {
    uploaded: ['0042.png'], errors: [{ filename: 'broken.png', reason: 'The file is damaged or larger than 25 megapixels.' }],
  });
  const body = await (await fetch(`${base}/files?view=all`, { headers })).text();
  assert.match(body, /1 of 1 tickets matched/);
  assert.ok(body.includes('guests-සිංහල.csv'), 'CSV summary preserves the original filename');
  assert.match(body, /Mira Perera/);
  const id = (await filesService.read()).images[0].id;
  const privateImage = await fetch(`${base}/files/images/${id}`, { redirect: 'manual' });
  assert.equal(privateImage.headers.get('location'), '/login');
  const allowedImage = await fetch(`${base}/files/images/${id}`, { headers });
  assert.equal(allowedImage.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await allowedImage.arrayBuffer()), image);
});
