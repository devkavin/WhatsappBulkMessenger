import { createPool } from 'mysql2/promise';
import { createApp } from './app.ts';
import { readConfig } from './config.ts';
import { mysqlFilesRepository } from './files/mysql-repository.ts';
import { FilesService } from './files/service.ts';
import { mysqlInvitationsRepository } from './invitations/mysql-repository.ts';
import { InvitationsService } from './invitations/service.ts';
import { mysqlDeliveryRepository } from './delivery/mysql.ts';
import { readDeliverySettings } from './delivery/settings.ts';

const config = readConfig(process.env);
const pool = createPool({ ...config.database, connectionLimit: 6, charset: 'UTF8MB4', timezone: 'Z' });
const filesService = new FilesService(mysqlFilesRepository(pool), config.uploadDir, config.country);
const invitationsService = new InvitationsService(filesService, mysqlInvitationsRepository(pool));
const delivery = { repository:mysqlDeliveryRepository(pool), settings:readDeliverySettings(process.env, config.origin), country:config.country };
const server = createApp({ filesService, invitationsService, config, delivery }).listen(config.port, '0.0.0.0', () => {
  console.log(`Dinner Dance is listening on port ${config.port}.`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => { void pool.end(); }));
}
