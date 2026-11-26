import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { advanceDraft, selectDraft, withDraftLock } from '../db/draft.ts';
import { EventConflictError } from '../events/model.ts';
import type { TicketImage } from '../imports/matches.ts';
import type { ContactImport, FilesRepository } from './service.ts';

interface CsvRow extends RowDataPacket {
  filename: string;
  contacts: ContactImport['contacts'];
}

interface ImageRow extends RowDataPacket, TicketImage {}

export function mysqlFilesRepository(pool: Pool): FilesRepository {
  return {
    async read(eventId) {
      const id = eventId ?? (await selectDraft(pool)).eventId;
      const [[imports], [images]] = await Promise.all([
        pool.execute<CsvRow[]>('SELECT filename, contacts FROM draft_csv WHERE event_id = ?', [id]),
        pool.execute<ImageRow[]>(`
          SELECT image.id, image.filename, image.content_type AS contentType
          FROM draft_images AS draft
          JOIN ticket_images AS image ON image.id = draft.image_id
          WHERE draft.event_id = ?
          ORDER BY draft.filename
        `, [id]),
      ]);
      return { csv: imports[0] ?? null, images, eventId:id };
    },
    async replaceCsv({ filename, contacts }, eventId) {
      const json = JSON.stringify(contacts);
      await withDraftLock(pool, async (connection, draft) => {
        if (eventId !== draft.eventId) throw new EventConflictError();
        await connection.execute(`
          INSERT INTO draft_csv (event_id, filename, contacts) VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE filename = ?, contacts = ?
        `, [draft.eventId, filename, json, filename, json]);
        await advanceDraft(connection);
      });
    },
    async addImage({ id, filename, contentType }, draft = true, eventId) {
      if (!draft) {
        await pool.execute('INSERT INTO ticket_images (id, filename, content_type) VALUES (?, ?, ?)', [id, filename, contentType]);
        return;
      }
      await withDraftLock(pool, async (connection, current) => {
        if (current.eventId !== eventId) throw new EventConflictError();
        await connection.execute('INSERT INTO ticket_images (id, filename, content_type) VALUES (?, ?, ?)', [id, filename, contentType]);
        await connection.execute(`
          INSERT INTO draft_images (event_id, filename, image_id) VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE image_id = ?
        `, [current.eventId, filename, id, id]);
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
      return withDraftLock(pool, async (connection, draft) => {
        const [result] = await connection.execute<ResultSetHeader>('DELETE FROM draft_images WHERE event_id = ? AND image_id = ?', [draft.eventId, id]);
        if (result.affectedRows !== 1) return false;
        await advanceDraft(connection);
        return true;
      });
    },
  };
}
