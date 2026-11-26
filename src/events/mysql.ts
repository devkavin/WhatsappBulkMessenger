import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { withDraftLock } from '../db/draft.ts';
import { lockControl } from '../delivery/mysql.ts';
import type { DeliverySettings } from '../delivery/settings.ts';
import { EventConflictError } from './model.ts';
import type { EventsRepository, InvitationEvent } from './model.ts';

interface EventRow extends RowDataPacket, InvitationEvent {}
interface DraftEventRow extends RowDataPacket { id: number; template: string | null }
interface WorkRow extends RowDataPacket { pending: number; inFlight: number }

const eventColumns = 'e.id, e.name, e.created_at AS createdAt, e.archived_at AS archivedAt, e.archived_mode AS archivedMode';
const cancellable = `j.status = 'queued' OR (j.status = 'submitting' AND j.dispatch_at IS NULL)`;

export function mysqlEventsRepository(pool: Pool, mode: DeliverySettings['mode']): EventsRepository {
  return {
    async preview() {
      const [[active], [events]] = await Promise.all([
        pool.execute<EventRow[]>(`SELECT ${eventColumns} FROM invitation_events e
          JOIN invitation_draft d ON d.event_id = e.id WHERE d.id = 1`),
        pool.execute<EventRow[]>(`SELECT ${eventColumns} FROM invitation_events e
          ORDER BY e.id DESC`),
      ]);
      const event = active[0];
      if (!event) throw new Error('Active event is missing. Check migration 005.');
      return { event, open:events.filter(row => !row.archivedAt), archived:events.filter(row => row.archivedAt), ...await readWork(pool, event.id, mode) };
    },
    async findArchived(id) {
      const [rows] = await pool.execute<EventRow[]>(`SELECT ${eventColumns} FROM invitation_events e
        WHERE e.id = ? AND e.archived_at IS NOT NULL`, [id]);
      return rows[0] ?? null;
    },
    async create(expectedId, name, now) {
      await withDraftLock(pool, async (connection, draft) => {
        if (draft.eventId !== expectedId) throw new EventConflictError();
        const [created] = await connection.execute<ResultSetHeader>(
          'INSERT INTO invitation_events (name, created_at) VALUES (?, ?)', [name, now]);
        await storeDraftTemplate(connection, draft.eventId, draft.template);
        await selectEvent(connection, created.insertId, null);
      });
    },
    async select(id) {
      await withDraftLock(pool, async (connection, draft) => {
        if (id === draft.eventId) return;
        const [[target]] = await connection.execute<DraftEventRow[]>(`SELECT id, draft_template AS template
          FROM invitation_events WHERE id = ? AND archived_at IS NULL`, [id]);
        if (!target) throw new EventConflictError('Choose an open event.');
        await storeDraftTemplate(connection, draft.eventId, draft.template);
        await selectEvent(connection, target.id, target.template);
      });
    },
    async archive(expectedId, expectedPending, now) {
      await withDraftLock(pool, async (connection, draft) => {
        if (draft.eventId !== expectedId) throw new EventConflictError();
        await lockControl(connection);
        const { pending, inFlight } = await readWork(connection, expectedId, mode);
        if (inFlight) throw new EventConflictError('A submission is in progress. Pause sending, then try again once the submission finishes.');
        if (pending !== expectedPending) throw new EventConflictError('The pending count changed. Review the updated count before confirming.');
        const [[target]] = await connection.execute<DraftEventRow[]>(`SELECT id, draft_template AS template
          FROM invitation_events WHERE id <> ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1`, [expectedId]);
        if (!target) throw new EventConflictError('Create another event before archiving this one.');

        await connection.execute(`UPDATE outbound_jobs j JOIN staged_invitations s ON s.id = j.invitation_id
          SET j.status = 'cancelled', j.lease_until = NULL, j.retryable = 0, j.updated_at = ?,
            j.note = 'Event archived before this send.'
          WHERE s.event_id = ? AND (${cancellable})`, [now, expectedId]);
        await connection.execute(`UPDATE outbound_control c JOIN event_send_queue q ON q.run_id = c.run_id
          SET c.run_id = NULL, c.binding = NULL, c.paused = 0 WHERE c.id = 1 AND q.event_id = ?`, [expectedId]);
        await connection.execute('DELETE FROM event_send_queue WHERE event_id = ?', [expectedId]);
        await connection.execute('UPDATE invitation_events SET archived_at = ?, archived_mode = ? WHERE id = ?', [now, mode, expectedId]);
        await selectEvent(connection, target.id, target.template);
      });
    },
  };
}

async function storeDraftTemplate(connection: PoolConnection, eventId: number, template: string | null) {
  await connection.execute('UPDATE invitation_events SET draft_template = ? WHERE id = ?', [template, eventId]);
}

async function selectEvent(connection: PoolConnection, eventId: number, template: string | null) {
  await connection.execute('UPDATE invitation_draft SET event_id = ?, template = ?, revision = revision + 1 WHERE id = 1', [eventId, template]);
}

async function readWork(connection: Pool | PoolConnection, eventId: number, mode: DeliverySettings['mode']) {
  const [[work]] = await connection.execute<WorkRow[]>(`SELECT
    (SELECT COUNT(*) FROM staged_invitations s WHERE s.event_id = ? AND s.status = 'queued'
      AND (NOT EXISTS (SELECT 1 FROM outbound_jobs j WHERE j.invitation_id = s.id AND j.mode = ? AND j.status <> 'cancelled')
        OR EXISTS (SELECT 1 FROM outbound_jobs j WHERE j.invitation_id = s.id AND (${cancellable})))) AS pending,
    EXISTS (SELECT 1 FROM outbound_jobs j JOIN staged_invitations s ON s.id = j.invitation_id
      WHERE s.event_id = ? AND j.dispatch_at IS NOT NULL AND j.lease_until IS NOT NULL) AS inFlight`, [eventId, mode, eventId]);
  return { pending: work.pending, inFlight: Boolean(work.inFlight) };
}
