import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { withDraftLock } from '../db/draft.ts';
import { EventConflictError } from '../events/model.ts';
import type { Invitation } from '../invitations/service.ts';
import type { WassengerStatus } from './policy.ts';
import { renderApprovedBody } from './providers.ts';
import { DeliveryInputError } from './worker.ts';
import type { DeliveryContext, DeliveryRepository, Job, ProviderStatusSource, TestRecipient } from './worker.ts';

interface Control extends RowDataPacket {
  runId: string | null; binding: string | null; paused: number; nextSendAt: Date | null; nextCheckAt: Date | null;
}
interface JobRow extends RowDataPacket, Job { leaseUntil: Date | null; attemptCount: number }
interface RecipientRow extends RowDataPacket, TestRecipient {}
interface InvitationRow extends RowDataPacket, Invitation { id: string }
interface BatchRow extends RowDataPacket { runId: string; binding: string }
interface DashboardBatch extends BatchRow { isActive: number; paused: number }

const JOB_COLUMNS = `j.id, j.invitation_id AS invitationId, j.run_id AS runId, j.mode, j.status, j.current_ref AS reference,
  j.ticket_no AS ticketNumber, j.name, j.phone, j.image_id AS imageId, j.message, j.note, j.retryable,
  j.updated_at AS updatedAt, j.lease_until AS leaseUntil, j.attempt_count AS attemptCount`;
const PROVIDER_COLUMNS = `a.provider_status AS providerStatus, a.provider_status_source AS providerSource,
  a.provider_webhook_event AS webhookEvent, a.provider_webhook_at AS webhookReceivedAt`;
const LEASE_MS = 60_000;
const REVIEW_NOTE = 'The worker stopped before confirming submission. Check the attempt in Wassenger before resending.';

export function mysqlDeliveryRepository(pool: Pool): DeliveryRepository {
  return {
    async dashboard(context, eventId) {
      const [[[batch]], [jobs], liveReady] = await Promise.all([
        pool.execute<DashboardBatch[]>(`SELECT q.run_id AS runId, q.binding, c.run_id <=> q.run_id AS isActive, c.paused
          FROM event_send_queue q CROSS JOIN outbound_control c WHERE c.id = 1
          AND q.event_id = COALESCE(?, (SELECT event_id FROM invitation_draft WHERE id = 1))`, [eventId ?? null]),
        pool.execute<JobRow[]>(`SELECT ${JOB_COLUMNS}, ${PROVIDER_COLUMNS} FROM outbound_jobs j
          JOIN staged_invitations s ON s.id = j.invitation_id
          LEFT JOIN outbound_attempts a ON a.reference = j.current_ref
          WHERE j.active_invitation_id IS NOT NULL AND j.mode = ?
            AND s.event_id = COALESCE(?, (SELECT event_id FROM invitation_draft WHERE id = 1)) ORDER BY j.sequence`, [context.mode, eventId ?? null]),
        readyForLive(pool, context),
      ]);
      const state = !batch ? 'waiting' : batch.binding !== context.binding ? 'settings-changed' : !batch.isActive ? 'scheduled' : batch.paused ? 'paused' : 'running';
      return { state, liveReady, jobs, runId:batch?.runId };
    },
    async archivedJobs(eventId, mode) {
      const [rows] = await pool.execute<JobRow[]>(`SELECT ${JOB_COLUMNS}, ${PROVIDER_COLUMNS} FROM outbound_jobs j
        JOIN staged_invitations s ON s.id = j.invitation_id
        LEFT JOIN outbound_attempts a ON a.reference = j.current_ref
        WHERE s.event_id = ? AND j.mode = ? ORDER BY j.active_invitation_id IS NOT NULL, j.sequence`, [eventId, mode]);
      return rows;
    },
    async start(context, now, eventId) {
      await withDraftLock(pool, async (connection, draft) => {
        if (eventId !== draft.eventId) throw new EventConflictError();
        await lockControl(connection);
        if (await eventBatch(connection, draft.eventId)) throw new DeliveryInputError('This event already has a scheduled or running batch.');
        if (!(await readyForLive(connection, context))) throw new DeliveryInputError('Send a live test and wait for delivery before starting the event batch.');
        const [pending] = await connection.execute<InvitationRow[]>(`
          SELECT s.id, s.ticket_no AS ticketNumber, s.name, s.phone, s.image_id AS imageId, s.message
          FROM staged_invitations s LEFT JOIN outbound_jobs j ON j.active_invitation_id = s.id AND j.mode = ?
          WHERE s.event_id = ? AND s.status = 'queued' AND j.id IS NULL ORDER BY s.sequence
        `, [context.mode, draft.eventId]);
        if (context.approvedBody && pending.some(row => row.message !== renderApprovedBody(context.approvedBody!, row.ticketNumber))) {
          throw new DeliveryInputError('A staged invitation differs from the approved template. Remove it and stage it again with the approved wording.');
        }
        const runId = randomUUID();
        for (const invitation of pending) await insertJob(connection, context, invitation, invitation.id, runId, null, now);
        const [retried] = await connection.execute<ResultSetHeader>(`
          UPDATE outbound_jobs j JOIN staged_invitations s ON s.id = j.invitation_id SET j.run_id = ?
          WHERE s.event_id = ? AND j.run_id IS NULL AND j.status = 'queued' AND j.binding = ?
        `, [runId, draft.eventId, context.binding]);
        if (pending.length + retried.affectedRows === 0) throw new DeliveryInputError('Stage invitations before starting a batch.');
        await connection.execute('INSERT INTO event_send_queue (run_id, event_id, binding) VALUES (?, ?, ?)', [runId, draft.eventId, context.binding]);
      });
    },
    async pause(context, paused, eventId) {
      await withDraftLock(pool, async (connection, draft) => {
        if (eventId !== draft.eventId) throw new EventConflictError();
        const control = await lockControl(connection);
        const batch = await eventBatch(connection, draft.eventId);
        if (!batch || control.runId !== batch.runId || batch.binding !== context.binding) throw new DeliveryInputError('This event has no running batch with these settings.');
        await connection.execute('UPDATE outbound_control SET paused = ? WHERE id = 1', [Number(paused)]);
      });
    },
    async endChangedBatch(context, now, eventId) {
      await withDraftLock(pool, async (connection, draft) => {
        if (eventId !== draft.eventId) throw new EventConflictError();
        const control = await lockControl(connection);
        const batch = await eventBatch(connection, draft.eventId);
        if (!batch || batch.binding === context.binding) throw new DeliveryInputError('This event has no batch using previous settings.');
        await connection.execute(`UPDATE outbound_jobs SET status = 'cancelled', lease_until = NULL, updated_at = ?,
          note = 'Batch ended after settings changed.' WHERE run_id = ?
          AND (status = 'queued' OR (status = 'submitting' AND dispatch_at IS NULL))`, [now, batch.runId]);
        await connection.execute('DELETE FROM event_send_queue WHERE run_id = ?', [batch.runId]);
        if (control.runId === batch.runId) await clearRun(connection, control);
      });
    },
    async retry(context, id, now) {
      await withDraftLock(pool, async (connection, draft) => {
        await lockControl(connection);
        const [result] = await connection.execute<ResultSetHeader>(`
          UPDATE outbound_jobs j JOIN staged_invitations s ON s.id = j.invitation_id
          SET j.status = 'queued', j.run_id = NULL, j.current_ref = NULL, j.attempt_count = 0,
            j.retryable = 0, j.note = NULL, j.updated_at = ?
          WHERE s.event_id = ? AND j.id = ? AND j.binding = ? AND j.status = 'failed' AND j.retryable = 1 AND j.lease_until IS NULL
        `, [now, draft.eventId, id, context.binding]);
        if (!result.affectedRows) throw new DeliveryInputError('This invitation is ineligible for retry.');
      });
    },
    async testRecipients() {
      const [rows] = await pool.execute<RecipientRow[]>('SELECT id, name, phone FROM test_recipients ORDER BY name, id');
      return rows;
    },
    async saveTestRecipient(name, phone) {
      await pool.execute('INSERT INTO test_recipients (id, name, phone) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = ?', [randomUUID(), name, phone, name]);
    },
    async removeTestRecipient(id, now) {
      await withControl(pool, async connection => {
        const [rows] = await connection.execute<RecipientRow[]>('SELECT id, name, phone FROM test_recipients WHERE id = ? FOR UPDATE', [id]);
        if (!rows[0]) return;
        await connection.execute('DELETE FROM test_recipients WHERE id = ?', [id]);
        await connection.execute(`UPDATE outbound_jobs SET status = 'cancelled', lease_until = NULL, updated_at = ?, note = 'Test recipient removed.'
          WHERE invitation_id IS NULL AND phone = ? AND (status = 'queued' OR (status = 'submitting' AND dispatch_at IS NULL))`, [now, rows[0].phone]);
      });
    },
    async enqueueTest(context, key, selected, invitation, now) {
      await withControl(pool, async connection => {
        const [previous] = await connection.execute<RowDataPacket[]>('SELECT id FROM outbound_jobs WHERE test_key = ? LIMIT 1', [key]);
        if (previous.length) return;
        const [recipients] = await connection.execute<RecipientRow[]>(
          `SELECT id, name, phone FROM test_recipients WHERE id IN (${selected.map(() => '?').join(',')})`, selected,
        );
        if (recipients.length !== selected.length) throw new DeliveryInputError('The test recipients changed. Review your selection.');
        if (context.approvedBody && invitation.message !== renderApprovedBody(context.approvedBody, invitation.ticketNumber)) {
          throw new DeliveryInputError('The preview must match the configured approved template before sending a live test.');
        }
        for (const { name, phone } of recipients) await insertJob(connection, context, { ...invitation, name, phone }, null, null, key, now);
      });
    },
    async testHistory() {
      const [rows] = await pool.execute<JobRow[]>(`SELECT ${JOB_COLUMNS}, ${PROVIDER_COLUMNS} FROM outbound_jobs j
        LEFT JOIN outbound_attempts a ON a.reference = j.current_ref WHERE j.invitation_id IS NULL ORDER BY j.sequence DESC LIMIT 100`);
      return rows;
    },
    async claim(context, now, gap) {
      return withControl(pool, async (connection, control) => {
        await connection.execute(`UPDATE outbound_jobs SET status = 'queued', current_ref = NULL, lease_until = NULL, updated_at = ?
          WHERE status = 'submitting' AND dispatch_at IS NULL AND lease_until <= ?`, [now, now]);
        await connection.execute(`UPDATE outbound_jobs SET status = 'review', note = ?, updated_at = ?
          WHERE status = 'submitting' AND lease_until <= ?`, [REVIEW_NOTE, now, now]);
        await connection.execute('UPDATE outbound_jobs SET lease_until = NULL WHERE lease_until <= ?', [now]);
        await releaseCompletedRun(connection, control);
        if (control.nextSendAt && control.nextSendAt > now) return null;
        const [inFlight] = await connection.execute<RowDataPacket[]>('SELECT id FROM outbound_jobs WHERE lease_until IS NOT NULL LIMIT 1');
        if (inFlight.length) return null;
        if (!control.runId) await promoteNextRun(connection, control);
        const batch = control.binding === context.binding && !control.paused ? control.runId : null;
        const [jobs] = await connection.execute<JobRow[]>(`
          SELECT ${JOB_COLUMNS}, ${PROVIDER_COLUMNS} FROM outbound_jobs j
          LEFT JOIN outbound_attempts a ON a.reference = j.current_ref WHERE j.binding = ? AND j.status = 'queued'
          AND (j.invitation_id IS NULL OR j.run_id = ?) ORDER BY j.invitation_id IS NOT NULL, j.sequence LIMIT 1
        `, [context.binding, batch]);
        const job = jobs[0];
        if (!job) return null;
        const reference = `dd-${randomUUID()}`;
        const leaseUntil = new Date(now.getTime() + LEASE_MS);
        await connection.execute('INSERT INTO outbound_attempts (reference, job_id, created_at) VALUES (?, ?, ?)', [reference, job.id, now]);
        await connection.execute(`UPDATE outbound_jobs SET status = 'submitting', current_ref = ?, lease_until = ?,
          dispatch_at = NULL, updated_at = ?, note = NULL WHERE id = ?`, [reference, leaseUntil, now, job.id]);
        await pushSendTime(connection, new Date(now.getTime() + gap));
        return { ...job, status: 'submitting', reference, leaseUntil };
      });
    },
    async authorize(context, job, now) {
      return withControl(pool, async (connection, control) => {
        const eventHeld = job.invitationId && (control.runId !== job.runId || control.binding !== context.binding || control.paused);
        if (eventHeld || job.leaseUntil <= now) {
          await connection.execute(`UPDATE outbound_jobs SET status = 'queued', current_ref = NULL, lease_until = NULL, updated_at = ?
            WHERE id = ? AND current_ref = ? AND status = 'submitting' AND dispatch_at IS NULL`, [now, job.id, job.reference]);
          return false;
        }
        const [result] = await connection.execute<ResultSetHeader>(`UPDATE outbound_jobs SET dispatch_at = ?, attempt_count = attempt_count + 1
          WHERE id = ? AND current_ref = ? AND status = 'submitting' AND dispatch_at IS NULL AND lease_until > ?`,
        [now, job.id, job.reference, now]);
        return result.affectedRows === 1;
      });
    },
    async finish(job, result, now, gap) {
      await withControl(pool, async (connection, control) => {
        const [rows] = await connection.execute<JobRow[]>(`SELECT ${JOB_COLUMNS} FROM outbound_jobs j WHERE j.id = ? AND j.current_ref = ?`, [job.id, job.reference]);
        const current = rows[0];
        if (!current) return;
        const providerOutcome = result.status === 'submitted' ? terminalStatus(result.providerStatus) : null;
        if (result.status === 'submitted') {
          await connection.execute('UPDATE outbound_attempts SET provider_id = ?, provider_alias = COALESCE(?, provider_alias) WHERE reference = ?', [result.id, result.alias, job.reference]);
          await recordProviderStatus(connection, job.reference, result.providerStatus, 'submission');
        }
        const advancesOutcome = providerOutcome && (current.status === 'submitted' || (current.status === 'failed' && providerOutcome === 'delivered'));
        if (current.status === 'submitting' || (result.status === 'submitted' && (current.status === 'review' || advancesOutcome))) {
          const throttled = result.status === 'throttled';
          const retryable = throttled && current.attemptCount >= 3;
          const status = throttled ? retryable ? 'failed' : 'queued' : providerOutcome ?? result.status;
          const note = throttled ? retryable ? 'Wassenger kept throttling this request. Retry is available.' : 'Waiting for the provider rate limit.' :
            providerOutcome === 'failed' ? 'Wassenger reported a delivery failure.' : 'note' in result ? result.note : null;
          await connection.execute(`UPDATE outbound_jobs SET status = ?, updated_at = ?, note = ?, retryable = ? WHERE id = ?`,
            [status, now, note, Number(retryable), job.id]);
        }
        await connection.execute('UPDATE outbound_jobs SET lease_until = NULL WHERE id = ?', [job.id]);
        const next = new Date(now.getTime() + Math.max(gap, result.status === 'throttled' ? result.delay : 0));
        await pushSendTime(connection, next);
        if (result.status === 'throttled') await pushCheckTime(connection, next);
        await releaseCompletedRun(connection, control);
      });
    },
    async receipts(device, receipts, now) {
      if (!receipts.length) return true;
      return withControl(pool, async (connection, control) => {
        let unmatched = false;
        for (const { ids, reference, status, event } of receipts) {
          const list = ids.map(() => '?').join(',');
          const [rows] = await connection.execute<JobRow[]>(`SELECT ${JOB_COLUMNS} FROM outbound_jobs j
            JOIN outbound_attempts a ON a.reference = j.current_ref WHERE j.mode = 'live' AND j.device = ?
            AND j.dispatch_at IS NOT NULL
            AND (a.reference = ? ${list ? `OR a.provider_id IN (${list}) OR a.provider_alias IN (${list})` : ''})`, [device, reference, ...ids, ...ids]);
          const row = rows[0];
          if (!rows.length) unmatched = true;
          if (rows.length !== 1 || !row.reference || !['submitting', 'submitted', 'review', 'failed', 'delivered'].includes(row.status)) continue;
          await connection.execute(`UPDATE outbound_attempts SET provider_webhook_event = ?, provider_webhook_at = ?
            WHERE reference = ? AND (provider_webhook_at IS NULL OR provider_webhook_at <= ?)`, [event, now, row.reference, now]);
          if (!status || (row.status === 'delivered' && status !== 'delivered')) continue;
          if (status === 'failed' && row.retryable) continue;
          await recordProviderStatus(connection, row.reference, status, 'webhook');
          const nextStatus = terminalStatus(status) ?? (row.status === 'submitting' || row.status === 'review' ? 'submitted' : row.status);
          if (row.status === nextStatus) continue;
          await connection.execute('UPDATE outbound_jobs SET status = ?, note = ?, retryable = 0, updated_at = ? WHERE id = ?',
            [nextStatus, nextStatus === 'failed' ? 'Wassenger reported a delivery failure. Check its message history for details.' : null, now, row.id]);
        }
        await releaseCompletedRun(connection, control);
        if (!unmatched) return true;
        const [pending] = await connection.execute<RowDataPacket[]>(`SELECT j.id FROM outbound_jobs j
          JOIN outbound_attempts a ON a.reference = j.current_ref
          WHERE j.mode = 'live' AND j.device = ? AND j.status IN ('submitting', 'submitted') AND j.dispatch_at IS NOT NULL
            AND j.lease_until > ? AND a.provider_id IS NULL LIMIT 1`, [device, now]);
        return !pending.length;
      });
    },
    async reserveCheck(context, now) {
      return withControl(pool, async (connection, control) => {
        if (control.nextCheckAt && control.nextCheckAt > now) return null;
        const before = new Date(now.getTime() - 60_000);
        const after = new Date(now.getTime() - 7 * 86_400_000);
        const [rows] = await connection.execute<RowDataPacket[]>(`SELECT j.id, j.phone, a.provider_id AS providerId, a.reference
          FROM outbound_jobs j JOIN outbound_attempts a ON a.reference = j.current_ref
          WHERE j.mode = 'live' AND j.device = ? AND j.status IN ('submitted', 'review') AND j.dispatch_at IS NOT NULL
          AND a.created_at >= ?
          AND COALESCE(j.last_checked_at, j.updated_at) <= ? ORDER BY COALESCE(j.last_checked_at, j.updated_at), j.sequence LIMIT 1`, [context.device, after, before]);
        const row = rows[0];
        if (!row) return null;
        await connection.execute('UPDATE outbound_jobs SET last_checked_at = ? WHERE id = ?', [now, row.id]);
        await connection.execute('UPDATE outbound_control SET next_check_at = ? WHERE id = 1', [new Date(now.getTime() + 15_000)]);
        return { id: row.providerId as string | null, reference: row.reference as string, phone:row.phone as string };
      });
    },
    async reconcile(device, reference, observation, now) {
      await withControl(pool, async connection => {
        const [rows] = await connection.execute<JobRow[]>(`SELECT ${JOB_COLUMNS} FROM outbound_jobs j
          WHERE j.mode = 'live' AND j.device = ? AND j.current_ref = ?`, [device, reference]);
        const row = rows[0];
        if (!row || !['review', 'submitted', 'failed', 'delivered'].includes(row.status)) return;
        await connection.execute('UPDATE outbound_attempts SET provider_id = ?, provider_alias = COALESCE(?, provider_alias) WHERE reference = ?',
          [observation.id, observation.alias, reference]);
        if (row.status !== 'delivered' || observation.status === 'delivered') {
          await recordProviderStatus(connection, reference, observation.status ?? 'accepted', 'lookup');
        }
        if (row.status === 'delivered') return;
        const status = terminalStatus(observation.status) ?? (row.status === 'review' ? 'submitted' : row.status);
        if (row.status === status) return;
        await connection.execute('UPDATE outbound_jobs SET status = ?, updated_at = ?, retryable = 0, note = ? WHERE id = ?',
          [status, now, status === 'failed' ? 'Wassenger reported a delivery failure.' : null, row.id]);
      });
    },
    async defer(until) {
      await withControl(pool, async connection => {
        await pushSendTime(connection, until);
        await pushCheckTime(connection, until);
      });
    },
  };
}

function terminalStatus(status: WassengerStatus | null) {
  return status === 'delivered' || status === 'failed' ? status : null;
}

async function recordProviderStatus(connection: PoolConnection, reference: string, status: WassengerStatus, source: ProviderStatusSource) {
  const precedence = "'accepted','queued','sent','failed','delivered'";
  await connection.execute(`UPDATE outbound_attempts SET provider_status = ?, provider_status_source = ?
    WHERE reference = ? AND (provider_status IS NULL OR FIELD(CAST(provider_status AS CHAR), ${precedence}) < FIELD(?, ${precedence}))`,
    [status, source, reference, status]);
}

async function insertJob(connection: PoolConnection, context: DeliveryContext, invitation: Invitation, invitationId: string | null,
  runId: string | null, testKey: string | null, now: Date) {
  await connection.execute(`INSERT INTO outbound_jobs (id, invitation_id, run_id, test_key, mode, binding, device, ticket_no, name, phone, image_id, message, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`, [randomUUID(), invitationId, runId, testKey, context.mode, context.binding, context.device,
    invitation.ticketNumber, invitation.name, invitation.phone, invitation.imageId, invitation.message, now]);
}

async function readyForLive(connection: Pool | PoolConnection, context: DeliveryContext) {
  if (context.mode === 'simulate') return true;
  const [rows] = await connection.execute<RowDataPacket[]>(`SELECT id FROM outbound_jobs
    WHERE invitation_id IS NULL AND mode = 'live' AND binding = ? AND status = 'delivered' LIMIT 1`, [context.binding]);
  return rows.length > 0;
}

async function releaseCompletedRun(connection: PoolConnection, control: Control) {
  if (!control.runId) return;
  const [rows] = await connection.execute<RowDataPacket[]>(`SELECT id FROM outbound_jobs WHERE run_id = ?
    AND (status IN ('queued', 'submitting') OR lease_until IS NOT NULL) LIMIT 1`, [control.runId]);
  if (rows.length) return;
  await connection.execute('DELETE FROM event_send_queue WHERE run_id = ?', [control.runId]);
  await clearRun(connection, control);
}

async function eventBatch(connection: PoolConnection, eventId: number) {
  const [[batch]] = await connection.execute<BatchRow[]>(`SELECT run_id AS runId, binding FROM event_send_queue WHERE event_id = ?`, [eventId]);
  return batch;
}

async function promoteNextRun(connection: PoolConnection, control: Control) {
  const [[batch]] = await connection.execute<BatchRow[]>(`SELECT run_id AS runId, binding FROM event_send_queue ORDER BY sequence LIMIT 1`);
  if (!batch) return;
  await connection.execute('UPDATE outbound_control SET run_id = ?, binding = ?, paused = 0 WHERE id = 1', [batch.runId, batch.binding]);
  control.runId = batch.runId;
  control.binding = batch.binding;
  control.paused = 0;
}

async function clearRun(connection: PoolConnection, control: Control) {
  await connection.execute('UPDATE outbound_control SET run_id = NULL, binding = NULL, paused = 0 WHERE id = 1');
  control.runId = null;
}

async function pushSendTime(connection: PoolConnection, next: Date) {
  await connection.execute('UPDATE outbound_control SET next_send_at = GREATEST(COALESCE(next_send_at, ?), ?) WHERE id = 1', [next, next]);
}

async function pushCheckTime(connection: PoolConnection, next: Date) {
  await connection.execute('UPDATE outbound_control SET next_check_at = GREATEST(COALESCE(next_check_at, ?), ?) WHERE id = 1', [next, next]);
}

async function readControl(connection: Pool | PoolConnection, lock = false): Promise<Control> {
  const [rows] = await connection.execute<Control[]>(`SELECT run_id AS runId, binding, paused, next_send_at AS nextSendAt,
    next_check_at AS nextCheckAt FROM outbound_control WHERE id = 1${lock ? ' FOR UPDATE' : ''}`);
  if (!rows[0]) throw new Error('Delivery control is missing. Check migration 003.');
  return rows[0];
}

export function lockControl(connection: PoolConnection) { return readControl(connection, true); }

async function withControl<T>(pool: Pool, operation: (connection: PoolConnection, control: Control) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await operation(connection, await lockControl(connection));
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}
