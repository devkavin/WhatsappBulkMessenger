import { resolve } from 'node:path';
import { isSupportedCountry } from 'libphonenumber-js/max';
import type { CountryCode } from 'libphonenumber-js/max';

export function readConfig(env: NodeJS.ProcessEnv) {
  const database = readDatabaseUrl(env.DATABASE_URL);
  const password = env.APP_PASSWORD ?? '';
  const sessionSecret = env.SESSION_SECRET ?? '';
  if (password.length < 12) throw new Error('Set APP_PASSWORD to at least 12 characters.');
  if (sessionSecret.length < 32) throw new Error('Set SESSION_SECRET to at least 32 characters.');

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Set PORT to a valid TCP port.');
  const origin = readAppOrigin(env.APP_ORIGIN ?? `http://localhost:${port}`);
  const country = (env.DEFAULT_COUNTRY ?? 'LK').toUpperCase();
  if (!isSupportedCountry(country)) throw new Error('Set DEFAULT_COUNTRY to a supported two-letter country code.');

  return {
    database,
    password,
    sessionSecret,
    origin,
    port,
    country: country as CountryCode,
    uploadDir: resolve(env.UPLOAD_DIR ?? 'data/uploads'),
  };
}

function readDatabaseUrl(value: string | undefined) {
  try {
    const url = new URL(value ?? '');
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname.slice(1));
    const port = Number(url.port || 3306);
    if (url.protocol !== 'mysql:' || !url.hostname || !user || !password || !database || /[/\u0000]/.test(database) ||
        url.hash || port < 1 || port > 65_535 || (url.search && url.search !== '?ssl=true')) {
      throw new Error();
    }

    const connection = { host: url.hostname.replace(/^\[|\]$/g, ''), port, user, password, database };
    return url.search ? { ...connection, ssl: { rejectUnauthorized: true } } : connection;
  } catch {
    throw new Error('Set DATABASE_URL to a valid MySQL connection URL.');
  }
}

function readAppOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new Error('Set APP_ORIGIN to the app’s public HTTP or HTTPS origin.');
  }
}
