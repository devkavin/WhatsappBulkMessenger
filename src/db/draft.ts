import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { InvitationDraft } from '../invitations/service.ts';

type ActiveDraft = InvitationDraft & { eventId: number };
interface DraftRow extends RowDataPacket, ActiveDraft {}
const DRAFT_SQL = `SELECT template, revision, event_id AS eventId,
  (SELECT name FROM invitation_events WHERE id = invitation_draft.event_id) AS eventName FROM invitation_draft WHERE id = 1`;

export async function selectDraft(connection: Pool | PoolConnection, lock = false): Promise<ActiveDraft> {
  const [rows] = await connection.execute<DraftRow[]>(lock ? `${DRAFT_SQL} FOR UPDATE` : DRAFT_SQL);
  const row = rows[0];
  if (!row) throw new Error('Invitation draft is missing. Check the database migration.');
  return { template: row.template, revision: row.revision, eventId: row.eventId, eventName:row.eventName };
}

export async function advanceDraft(connection: PoolConnection) {
  await connection.execute('UPDATE invitation_draft SET revision = revision + 1 WHERE id = 1');
}

export async function withDraftLock<T>(pool: Pool, operation: (connection: PoolConnection, draft: ActiveDraft) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const draft = await selectDraft(connection, true);
    const result = await operation(connection, draft);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
