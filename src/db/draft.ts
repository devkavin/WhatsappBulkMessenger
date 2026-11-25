import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { InvitationDraft } from '../invitations/service.ts';

interface DraftRow extends RowDataPacket, InvitationDraft {}
const DRAFT_SQL = 'SELECT template, revision FROM invitation_draft WHERE id = 1';

export async function selectDraft(connection: Pool | PoolConnection, lock = false): Promise<InvitationDraft> {
  const [rows] = await connection.execute<DraftRow[]>(lock ? `${DRAFT_SQL} FOR UPDATE` : DRAFT_SQL);
  const row = rows[0];
  if (!row) throw new Error('Invitation draft is missing. Check the database migration.');
  return { template: row.template, revision: row.revision };
}

export async function advanceDraft(connection: PoolConnection) {
  await connection.execute('UPDATE invitation_draft SET revision = revision + 1 WHERE id = 1');
}

export async function withDraftLock<T>(pool: Pool, operation: (connection: PoolConnection, draft: InvitationDraft) => Promise<T>): Promise<T> {
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
