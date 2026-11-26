import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { withDraftLock } from '../db/draft.ts';
import { lockControl } from '../delivery/mysql.ts';
import { batchState } from '../delivery/status.ts';
import type { DeliverySettings } from '../delivery/settings.ts';
import { EVENTS_PER_PAGE, EventConflictError, eventPage } from './model.ts';
import type { EventsRepository, InvitationEvent } from './model.ts';

interface EventRow extends RowDataPacket, InvitationEvent {}
interface OpenEventRow extends EventRow { binding: string | null; isActive: number; paused: number }
interface EventCounts extends RowDataPacket { openCount: number; pastCount: number }
interface DraftEventRow extends RowDataPacket { id: number; template: string | null }
interface WorkRow extends RowDataPacket { pending: number; inFlight: number }

const eventColumns = 'e.id, e.name, e.created_at AS createdAt, e.archived_at AS archivedAt, e.archived_mode AS archivedMode';
const cancellable = `j.status = 'queued' OR (j.status = 'submitting' AND j.dispatch_at IS NULL)`;

export function mysqlEventsRepository(pool: Pool, { mode, binding }: Pick<DeliverySettings, 'mode' | 'binding'>): EventsRepository {
  return {
    async preview(openPage, pastPage, archiveId) {
      const [[[event]], [[counts]]] = await Promise.all([
        pool.execute<EventRow[]>(`SELECT ${eventColumns} FROM invitation_events e
          JOIN invitation_draft d ON d.event_id = e.id WHERE d.id = 1`),
        pool.execute<EventCounts[]>(`SELECT COUNT(CASE WHEN archived_at IS NULL THEN 1 END) AS openCount,
          COUNT(archived_at) AS pastCount FROM invitation_events`),
      ]);
      if (!event) throw new Error('Active event is missing. Check migration 005.');
      const open = eventPage(counts.openCount, openPage);
      const archived = eventPage(counts.pastCount, pastPage);
      const [[openRows], [archivedRows], archive] = await Promise.all([
        pool.execute<OpenEventRow[]>(`SELECT ${eventColumns}, q.binding, c.run_id <=> q.run_id AS isActive, c.paused
          FROM invitation_events e LEFT JOIN event_send_queue q ON q.event_id = e.id JOIN outbound_control c ON c.id = 1
          WHERE e.archived_at IS NULL ORDER BY e.id DESC LIMIT ? OFFSET ?`, [EVENTS_PER_PAGE, open.offset]),
        pool.execute<EventRow[]>(`SELECT ${eventColumns} FROM invitation_events e WHERE e.archived_at IS NOT NULL
          ORDER BY e.archived_at DESC, e.id DESC LIMIT ? OFFSET ?`, [EVENTS_PER_PAGE, archived.offset]),
        archiveId === undefined ? null : archivePreview(pool, archiveId, mode),
      ]);
      return { event, open:{...open, rows:openRows.map(({ binding:batchBinding, isActive, paused, ...row }) => ({
        ...row, sendState:batchState(binding, batchBinding === null ? undefined : {binding:batchBinding, isActive, paused}),
      }))}, archived:{...archived, rows:archivedRows}, archive };
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
        await lockControl(connection);
        const [[event]] = await connection.execute<EventRow[]>(`SELECT ${eventColumns} FROM invitation_events e
          WHERE e.id = ? AND e.archived_at IS NULL`, [expectedId]);
        if (!event) throw new EventConflictError('This event is already archived or unavailable.');
        const { pending, inFlight } = await readWork(connection, expectedId, mode);
        if (inFlight) throw new EventConflictError('A submission is in progress. Pause sending, then try again once the submission finishes.');
        if (pending !== expectedPending) throw new EventConflictError('The pending count changed. Review the updated count before confirming.');
        let replacement: DraftEventRow | undefined;
        if (draft.eventId === expectedId) {
          [[replacement]] = await connection.execute<DraftEventRow[]>(`SELECT id, draft_template AS template
            FROM invitation_events WHERE id <> ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1`, [expectedId]);
          if (!replacement) throw new EventConflictError('Create another event before archiving this one.');
        }

        await connection.execute(`UPDATE outbound_jobs j JOIN staged_invitations s ON s.id = j.invitation_id
          SET j.status = 'cancelled', j.lease_until = NULL, j.retryable = 0, j.updated_at = ?,
            j.note = 'Event archived before this send.'
          WHERE s.event_id = ? AND (${cancellable})`, [now, expectedId]);
        await connection.execute(`UPDATE outbound_control c JOIN event_send_queue q ON q.run_id = c.run_id
          SET c.run_id = NULL, c.binding = NULL, c.paused = 0 WHERE c.id = 1 AND q.event_id = ?`, [expectedId]);
        await connection.execute('DELETE FROM event_send_queue WHERE event_id = ?', [expectedId]);
        await connection.execute('UPDATE invitation_events SET archived_at = ?, archived_mode = ? WHERE id = ?', [now, mode, expectedId]);
        if (replacement) await selectEvent(connection, replacement.id, replacement.template);
      });
    },
  };
}

async function archivePreview(pool: Pool, id: number, mode: DeliverySettings['mode']) {
  const [[event]] = await pool.execute<EventRow[]>(`SELECT ${eventColumns} FROM invitation_events e
    WHERE e.id = ? AND e.archived_at IS NULL`, [id]);
  return event ? { event, ...await readWork(pool, id, mode) } : null;
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
