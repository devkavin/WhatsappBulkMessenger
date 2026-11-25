import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { advanceDraft, withDraftLock } from '../db/draft.ts';
import type { TicketImage } from '../imports/matches.ts';
import type { ContactImport, FilesRepository } from './service.ts';

interface CsvRow extends RowDataPacket {
  filename: string;
  contacts: ContactImport['contacts'];
}

interface ImageRow extends RowDataPacket, TicketImage {}

export function mysqlFilesRepository(pool: Pool): FilesRepository {
  return {
    async read() {
      const [[imports], [images]] = await Promise.all([
        pool.execute<CsvRow[]>('SELECT filename, contacts FROM draft_csv WHERE id = 1'),
        pool.execute<ImageRow[]>(`
          SELECT image.id, image.filename, image.content_type AS contentType
          FROM draft_images AS draft
          JOIN ticket_images AS image ON image.id = draft.image_id
          ORDER BY draft.filename
        `),
      ]);
      return { csv: imports[0] ?? null, images };
    },
    async replaceCsv({ filename, contacts }) {
      const json = JSON.stringify(contacts);
      await withDraftLock(pool, async connection => {
        await connection.execute(`
          INSERT INTO draft_csv (id, filename, contacts) VALUES (1, ?, ?)
          ON DUPLICATE KEY UPDATE filename = ?, contacts = ?
        `, [filename, json, filename, json]);
        await advanceDraft(connection);
      });
    },
    async addImage({ id, filename, contentType }, draft = true) {
      if (!draft) {
        await pool.execute('INSERT INTO ticket_images (id, filename, content_type) VALUES (?, ?, ?)', [id, filename, contentType]);
        return;
      }
      await withDraftLock(pool, async connection => {
        await connection.execute('INSERT INTO ticket_images (id, filename, content_type) VALUES (?, ?, ?)', [id, filename, contentType]);
        await connection.execute(`
          INSERT INTO draft_images (filename, image_id) VALUES (?, ?)
          ON DUPLICATE KEY UPDATE image_id = ?
        `, [filename, id, id]);
        await advanceDraft(connection);
      });
    },
    async findImage(id) {
      const [images] = await pool.execute<ImageRow[]>(
        'SELECT id, filename, content_type AS contentType FROM ticket_images WHERE id = ?', [id],
      );
      return images[0] ?? null;
    },
    async removeDraftImage(id) {
      return withDraftLock(pool, async connection => {
        const [result] = await connection.execute<ResultSetHeader>('DELETE FROM draft_images WHERE image_id = ?', [id]);
        if (result.affectedRows !== 1) return false;
        await advanceDraft(connection);
        return true;
      });
    },
  };
}
