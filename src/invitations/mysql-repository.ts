import { randomUUID } from 'node:crypto';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { advanceDraft, selectDraft, withDraftLock } from '../db/draft.ts';
import { lockControl } from '../delivery/mysql.ts';
import { StaleReviewError } from './service.ts';
import type { InvitationsRepository, StagedInvitation } from './service.ts';

interface QueueRow extends RowDataPacket, StagedInvitation {}

export function mysqlInvitationsRepository(pool: Pool): InvitationsRepository {
  return {
    async readDraft() {
      return selectDraft(pool);
    },
    async saveMessage(template) {
      await pool.execute('UPDATE invitation_draft SET template = ?, revision = revision + 1 WHERE id = 1', [template]);
    },
    async readQueue() {
      const [rows] = await pool.execute<QueueRow[]>(`
        SELECT id, ticket_no AS ticketNumber, name, phone, image_id AS imageId, message, status, updated_at AS updatedAt
        FROM staged_invitations WHERE draft_id = 1 ORDER BY sequence
      `);
      return rows;
    },
    async stage(invitations, expected) {
      return withDraftLock(pool, async (connection, draft) => {
        if (draft.revision !== expected.revision || draft.template !== expected.template) throw new StaleReviewError();
        const [existing] = await connection.execute<RowDataPacket[]>(`
          SELECT active_ticket_no AS ticketNumber FROM staged_invitations
          WHERE draft_id = 1 AND active_ticket_no IS NOT NULL
        `);
        const active = new Set(existing.map(row => row.ticketNumber));
        const pending = invitations.filter(invitation => !active.has(invitation.ticketNumber));
        const now = new Date();

        for (const { ticketNumber, name, phone, imageId, message } of pending) {
          await connection.execute(`
            INSERT INTO staged_invitations (draft_id, id, ticket_no, name, phone, image_id, message, status, updated_at)
            VALUES (1, ?, ?, ?, ?, ?, ?, 'queued', ?)
          `, [randomUUID(), ticketNumber, name, phone, imageId, message, now]);
        }
        return pending.length;
      });
    },
    async remove(id) {
      return withDraftLock(pool, async connection => {
        await lockControl(connection);
        const [result] = await connection.execute<ResultSetHeader>(`
          UPDATE staged_invitations s SET s.status = 'removed', s.updated_at = ?
          WHERE s.draft_id = 1 AND s.id = ? AND s.status = 'queued'
          AND NOT EXISTS (SELECT 1 FROM outbound_jobs j WHERE j.invitation_id = s.id
            AND ((j.lease_until IS NOT NULL AND j.dispatch_at IS NOT NULL) OR (j.mode = 'live' AND j.attempt_count > 0)))
        `, [new Date(), id]);
        if (result.affectedRows === 0) return false;
        await connection.execute(`UPDATE outbound_jobs SET status = 'cancelled', lease_until = NULL, updated_at = ?
          WHERE invitation_id = ? AND (status = 'queued' OR (status = 'submitting' AND dispatch_at IS NULL))`, [new Date(), id]);
        await advanceDraft(connection);
        return true;
      });
    },
  };
}
