import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createApp } from '../../src/app.ts';
import { FilesService } from '../../src/files/service.ts';
import { InvitationsService } from '../../src/invitations/service.ts';
import { memoryFilesRepository } from './files-repository.ts';
import { memoryInvitationsRepository } from './invitations-repository.ts';

export async function testSite(t: TestContext, delivery?: object) {
  const path = await mkdtemp(join(tmpdir(), 'dinnerdance-http-'));
  const invitations = memoryInvitationsRepository();
  const filesService = new FilesService(memoryFilesRepository(() => invitations.advanceRevision()), path, 'LK');
  const invitationsService = new InvitationsService(filesService, invitations);
  const config = {
    password: 'local test password',
    sessionSecret: '12345678901234567890123456789012',
    origin: 'http://localhost:3000',
  };
  const server = createApp({ filesService, invitationsService, config, delivery }).listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(path, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  async function signIn() {
    const loginPage = await fetch(`${base}/login`);
    const login = await fetch(`${base}/login`, {
      method: 'POST', redirect: 'manual', headers: { Cookie: cookie(loginPage) },
      body: new URLSearchParams({ _csrf: csrf(await loginPage.text()), password: config.password }),
    });
    assert.equal(login.status, 303);
    return { Cookie: cookie(login) };
  }

  return { base, filesService, invitationsService, signIn };
}

export function csrf(html: string) {
  const token = html.match(/name="_csrf" value="([a-f0-9-]+)"/i)?.[1];
  assert.ok(token, 'Page includes a request token');
  return token;
}

function cookie(response: Response) {
  const values = response.headers.getSetCookie();
  assert.ok(values.length, 'Response sets a session cookie');
  return values.map(value => value.split(';', 1)[0]).join('; ');
}
