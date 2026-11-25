import { createConnection } from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { readConfig } from './config.ts';

let connection: Connection | undefined;
try {
  const { database } = readConfig(process.env);
  connection = await createConnection({ ...database, connectTimeout: 4_000 });
  const [rows] = await connection.query<RowDataPacket[]>({
    sql: 'SELECT 1 FROM outbound_control WHERE id = 1',
    timeout: 4_000,
  });
  await connection.end();
  if (rows.length === 0) {
    console.error('Worker health check failed: outbound_control row is missing.');
    process.exitCode = 1;
  }
} catch (error) {
  connection?.destroy();
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
  console.error('Worker health check failed', code);
  process.exitCode = 1;
}
