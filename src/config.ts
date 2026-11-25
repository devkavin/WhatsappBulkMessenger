import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { isSupportedCountry } from 'libphonenumber-js/max';
import type { CountryCode } from 'libphonenumber-js/max';

export function readConfig(env: NodeJS.ProcessEnv) {
  const database = readDatabaseConfig(env);
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

function readDatabaseConfig(env: NodeJS.ProcessEnv) {
  const hostSetting = env.DB_HOST?.trim() ?? '';
  const host = hostSetting.startsWith('[') && hostSetting.endsWith(']') ? hostSetting.slice(1, -1) : hostSetting;
  if (!/^[a-z0-9_.-]+$/i.test(hostSetting) && isIP(host) !== 6) {
    throw new Error('Set DB_HOST to the MySQL hostname or IP address.');
  }

  const portSetting = env.DB_PORT?.trim() || '3306';
  const port = Number(portSetting);
  if (!/^\d+$/.test(portSetting) || port < 1 || port > 65_535) {
    throw new Error('Set DB_PORT to a valid TCP port.');
  }

  const user = env.DB_USER;
  const password = env.DB_PASSWORD;
  const database = env.DB_NAME;
  if (!user) throw new Error('Set DB_USER to the MySQL username.');
  if (!password) throw new Error('Set DB_PASSWORD to the MySQL password.');
  if (!database?.trim() || /[/\u0000]/.test(database)) throw new Error('Set DB_NAME to the MySQL database name.');

  const ssl = env.DB_SSL?.trim() || 'false';
  if (ssl !== 'true' && ssl !== 'false') throw new Error('Set DB_SSL to true or false.');
  const ca = env.DB_SSL_CA?.trim();
  if (ca && ssl === 'false') throw new Error('Set DB_SSL to true when providing DB_SSL_CA.');

  const connection = { host, port, user, password, database };
  if (ssl === 'false') return connection;
  return { ...connection, ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) } };
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
