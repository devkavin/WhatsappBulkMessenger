import { access } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { createPool } from 'mysql2/promise';
import { readConfig } from './config.ts';
import { FilesService } from './files/service.ts';
import { mysqlFilesRepository } from './files/mysql-repository.ts';
import { mediaLinks } from './delivery/media.ts';
import { mysqlDeliveryRepository } from './delivery/mysql.ts';
import { simulate, wassengerProvider } from './delivery/providers.ts';
import { readDeliverySettings } from './delivery/settings.ts';
import { deliveryWorker } from './delivery/worker.ts';

const config = readConfig(process.env);
const settings = readDeliverySettings(process.env, config.origin);
const pool = createPool({ ...config.database, connectionLimit:2, charset:'UTF8MB4', timezone:'Z' });
const files = new FilesService(mysqlFilesRepository(pool), config.uploadDir, config.country);
const provider = settings.provider ? wassengerProvider(settings.provider, mediaLinks(config.origin, config.sessionSecret)) : simulate;
const tick = deliveryWorker(mysqlDeliveryRepository(pool), settings, provider, async id => {
  const image = await files.openImage(id);
  if (!image) return false;
  try { await access(image.path); return true; } catch { return false; }
});

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { stopping = true; });
console.log(`Dinner Dance worker started in ${settings.mode} mode.`);
while (!stopping) {
  let delay = 1_000;
  try { await tick(); }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
    console.error('Delivery worker tick failed', code);
    delay = 5_000;
  }
  if (!stopping) await setTimeout(delay);
}
await pool.end();
