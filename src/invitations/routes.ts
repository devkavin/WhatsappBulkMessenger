import { Router, urlencoded } from 'express';
import type { Request, Response } from 'express';
import { requireOperator, requireRequestToken } from '../auth/session.ts';
import { InvitationInputError, MESSAGE_MAX_LENGTH, renderInvitation, StaleReviewError } from './service.ts';
import type { InvitationsService } from './service.ts';
import { deliveryDisplay, deliveryView } from '../delivery/status.ts';
import type { DeliveryUi } from '../delivery/routes.ts';
import { WassengerLookupError } from '../delivery/providers.ts';
import type { WassengerQueue } from '../delivery/providers.ts';
import { recoveryLookups, recoveryPreview } from '../delivery/recovery.ts';
import { deliveryContext, DeliveryInputError } from '../delivery/worker.ts';
import { EventConflictError, eventIdFrom } from '../events/model.ts';
import type { EventsRepository, InvitationEvent } from '../events/model.ts';
import { findArchivedEvent } from '../events/routes.ts';

const readForm = urlencoded({ extended: false, limit: '512kb', parameterLimit: 10_000 });

export function invitationRoutes(service: InvitationsService, delivery?: DeliveryUi, events?: EventsRepository) {
  const router = Router();
  router.use(['/recipients', '/queue'], requireOperator);
  router.get('/recipients', (request, response) => renderReview(service, request, response));
  router.post('/recipients/message', readForm, requireRequestToken, async (request, response) => {
    const template = formText(request.body?.template);
    const eventId = eventIdFrom(request.body?.eventId);
    if (events && !eventId) throw new EventConflictError();
    try {
      await service.saveMessage(template, eventId);
    } catch (error) {
      if (!(error instanceof InvitationInputError)) throw error;
      return renderReview(service, request, response, { editorValue: template, error: error.message, status: 422 });
    }
    response.redirect(303, '/recipients?notice=message');
  });
  router.post('/recipients/stage', readForm, requireRequestToken, async (request, response) => {
    const version = formText(request.body?.version);
    const ticket = request.body?.ticket;
    const bitmap = request.body?.selection;
    const tickets: string[] = Array.isArray(ticket) ? ticket.filter(value => typeof value === 'string') : typeof ticket === 'string' ? [ticket] : [];
    try {
      const added = await service.stage(version, typeof bitmap === 'string' ? { bitmap } : tickets);
      response.redirect(303, `/queue?added=${added}`);
    } catch (error) {
      if (!(error instanceof InvitationInputError)) throw error;
      return renderReview(service, request, response, { error: error.message, status: error instanceof StaleReviewError ? 409 : 422 });
    }
  });

  const context = delivery && deliveryContext(delivery.settings);
  router.get('/queue', (request, response) => renderQueue(request, response));
  if (events) router.get('/events/:eventId/queue', async (request, response) => {
    const event = await findArchivedEvent(events, request.params.eventId);
    if (!event) return response.sendStatus(404);
    await renderQueue(request, response, '', event);
  });
  if (delivery && context) {
    const {repository, settings, wassenger} = delivery;
    if (settings.mode === 'live' && wassenger) {
      router.post(['/queue/wassenger', '/queue/recovery'], readForm, requireRequestToken, async (request, response) => {
        const start = /^\/queue\/recovery\/?$/i.test(request.path);
        const eventId = eventIdFrom(request.body?.eventId);
        let queue: WassengerQueue | undefined;
        let preview: ReturnType<typeof recoveryPreview> | undefined;
        let runId: string | undefined;
        let eventName: string | undefined;
        let error = '';
        let status = 200;
        try {
          if (events) {
            const draft = await service.readDraft();
            if (!eventId || eventId !== draft.eventId) throw new EventConflictError();
            eventName = draft.eventName;
          }
          if (start && request.body?.confirm !== 'yes') {
            throw new DeliveryInputError('Review the remaining invitations and confirm that sending can continue.');
          }
          queue = await wassenger.queueStatus();
          const dashboard = await repository.dashboard(context, eventId);
          runId = dashboard.runId ?? undefined;
          if (queue.size === 0 && queue.status === 'active' && dashboard.state === 'paused' && runId) {
            const jobs = dashboard.jobs.filter(job => job.runId === runId);
            if (jobs.some(job => job.leaseUntil)) {
              throw new DeliveryInputError('A send is still in progress. Check again when it finishes.');
            }
            preview = recoveryPreview(jobs, await wassenger.recoveryStatuses(recoveryLookups(jobs)));
          }
          if (start) {
            const raw = request.body?.attempt;
            const selected = [...new Set((Array.isArray(raw) ? raw : [raw]).map(formText).filter(Boolean))];
            const eligible = new Set(preview?.candidates.map(candidate => candidate.reference));
            const lastSentId = preview?.lastSent?.id ?? null;
            if (!runId || request.body?.runId !== runId || !preview || request.body?.lastSent !== (lastSentId ?? '') ||
              preview.queuedBefore || (!selected.length && !preview.queuedCount) || selected.some(ref => !eligible.has(ref))) {
              throw new DeliveryInputError('The queue or remaining invitations changed. Check Wassenger again before continuing.');
            }
            queue = await wassenger.queueStatus();
            if (queue.size !== 0 || queue.status !== 'active') throw new DeliveryInputError('Wassenger’s queue changed. Check it again before continuing.');
            await repository.startRecovery(context, eventId, runId, lastSentId, selected, new Date());
            return response.redirect(303, `/queue?recovery=${selected.length}`);
          }
        } catch (failure) {
          if (!(failure instanceof DeliveryInputError || failure instanceof EventConflictError || failure instanceof WassengerLookupError)) throw failure;
          error = failure.message;
          status = failure instanceof WassengerLookupError ? 502 : 409;
          preview = undefined;
        }
        response.status(status).render('queue-recovery', {
          csrf:request.session?.csrf, eventId, eventName, queue, preview, runId, error, checkedAt:new Date(), ...deliveryView,
        });
      });
    }
    router.post('/queue/control', readForm, requireRequestToken, async (request, response) => {
      try {
        const action = request.body?.action;
        const eventId = eventIdFrom(request.body?.eventId);
        if (events && !eventId) throw new EventConflictError();
        if (action === 'start') {
          if (settings.mode === 'live' && request.body?.consent !== 'yes') throw new DeliveryInputError('Confirm WhatsApp opt-in before starting a live batch.');
          await repository.start(context, new Date(), eventId);
        } else if (action === 'pause' || action === 'resume') {
          await repository.pause(context, action === 'pause', eventId);
        } else if (action === 'end-changed') {
          await repository.endChangedBatch(context, new Date(), eventId);
        } else { return response.sendStatus(400); }
        response.redirect(303, '/queue');
      } catch (error) {
        if (!(error instanceof DeliveryInputError || error instanceof EventConflictError)) throw error;
        return renderQueue(request, response, error.message);
      }
    });
    router.post('/queue/retry', readForm, requireRequestToken, async (request, response) => {
      try {
        await repository.retry(context, formText(request.body?.job), new Date());
        response.redirect(303, '/queue');
      } catch (error) {
        if (!(error instanceof DeliveryInputError)) throw error;
        return renderQueue(request, response, error.message);
      }
    });
  }

  async function renderQueue(request: Request, response: Response, error = '', archive?: InvitationEvent) {
    const draft = !archive && events ? await service.readDraft() : undefined;
    const eventId = archive?.id ?? draft?.eventId;
    const requestedMode = request.query.mode;
    const mode = archive && (requestedMode === 'live' || requestedMode === 'simulate') ? requestedMode :
      archive?.archivedMode ?? delivery?.settings.mode;
    const [staged, dashboard, archivedJobs] = await Promise.all([
      service.readQueue(eventId),
      !archive && delivery && context ? delivery.repository.dashboard(context, eventId) : null,
      archive && delivery && mode ? delivery.repository.archivedJobs(archive.id, mode) : [],
    ]);
    const byInvitation = new Map((dashboard?.jobs ?? archivedJobs).map(job => [job.invitationId, job]));
    const archivedStatus: 'cancelled' | 'unsent' | undefined = archive && (mode === archive.archivedMode ? 'cancelled' : 'unsent');
    const all = staged.map(row => {
      const job = byInvitation.get(row.id);
      const { appStatus, provider } = deliveryDisplay(job);
      const removed = row.status === 'removed';
      const status = removed ? row.status : archivedStatus ?? row.status;
      return {...row, job, provider, status: removed ? status : job?.status ?? status,
        appStatus: removed ? status : appStatus ?? status,
        updatedAt:job?.updatedAt ?? (status === 'cancelled' ? archive?.archivedAt ?? row.updatedAt : row.updatedAt)};
    });
    const counts = {queued:0, submitting:0, submitted:0, delivered:0, failed:0, review:0, removed:0, cancelled:0, unsent:0};
    const appCounts = {...counts};
    const providerCounts = {accepted:0, queued:0, sent:0, delivered:0, failed:0};
    for (const row of all) {
      counts[row.status]++;
      appCounts[row.appStatus]++;
      if (row.status !== 'removed' && row.provider?.status) providerCounts[row.provider.status]++;
    }
    const requested = formText(request.query.view);
    const statuses = Object.keys(counts).filter(status => archive || status !== 'unsent');
    const view = statuses.includes(requested) ? requested : 'all';
    const search = formText(request.query.q).trim();
    const needle = search.toLocaleLowerCase();
    const matching = all.filter(row => (view === 'all' ? row.status !== 'removed' : row.status === view) &&
      `${row.ticketNumber} ${row.name} ${row.phone}`.toLocaleLowerCase().includes(needle));
    const pages = Math.max(1, Math.ceil(matching.length / 25));
    const page = Math.max(1, Math.min(pages, Number.parseInt(formText(request.query.page), 10) || 1));
    const rows = matching.slice((page - 1) * 25, page * 25);
    const added = !archive && /^\d+$/.test(formText(request.query.added)) ? Number(request.query.added) : null;
    const recoveryCount = !archive && /^\d+$/.test(formText(request.query.recovery)) ? Number(request.query.recovery) : null;
    const notice = recoveryCount === 0 ? 'Event sending resumed after checking Wassenger.' :
      recoveryCount ? `Event sending resumed with ${recoveryCount} ${recoveryCount === 1 ? 'invitation' : 'invitations'} queued for resend.` :
      added === 0 ? 'The selected tickets are already queued.' : added === null ? '' : `${added} ${added === 1 ? 'invitation' : 'invitations'} added to the queue.`;
    const canStart = dashboard?.state === 'waiting' && dashboard.liveReady && counts.queued > 0;
    const queuePath = archive ? `/events/${archive.id}/queue` : '/queue';
    const queueUrl = (targetPage: number) => {
      const query = new URLSearchParams({view, q:search, page:String(targetPage)});
      if (archive && mode) query.set('mode', mode);
      return `${queuePath}?${query}`;
    };
    response.status(error ? 409 : 200).render('queue', {
      csrf:request.session?.csrf, dashboard, counts, statuses, canStart, error, mode, archive, eventId, eventName:draft?.eventName, queuePath, queueUrl,
      rate:delivery?.settings.perMinute, rows, view, search, page, pages, total:matching.length, notice,
      ...deliveryView, appCounts, providerCounts, refreshUrl:queueUrl(page),
    });
  }
  router.post('/queue/:id/remove', readForm, requireRequestToken, async (request, response) => {
    const removed = await service.remove(formText(request.params.id));
    if (!removed) return response.status(409).render('upload-error', { title: 'Invitation unavailable', message: 'The invitation is no longer queued.', back: '/queue', backLabel: 'Back to queue' });
    response.redirect(303, '/queue?view=removed');
  });

  return router;
}

async function renderReview(
  service: InvitationsService,
  request: Request,
  response: Response,
  options: { error?: string; status?: number; editorValue?: string } = {},
) {
  const review = await service.review();
  const ready = review.rows.filter(row => row.status === 'ready').length;
  const attention = review.rows.filter(row => row.status === 'attention').length;
  const edit = request.query.edit === '1' || options.editorValue !== undefined;
  const editorValue = options.editorValue ?? review.template;
  const previewRow = edit ? review.rows.find(row => row.status === 'ready') : undefined;
  const previewTicket = previewRow?.contact.ticketNumber ?? '0042';
  response.status(options.status ?? 200).render('recipients', {
    csrf: request.session?.csrf, review, ready, attention,
    edit, editorValue, messageMaxLength: MESSAGE_MAX_LENGTH,
    previewTicket, previewImage:previewRow?.images[0]?.id,
    previewMessage:edit ? renderInvitation(editorValue.trim(), previewTicket) : '',
    error: options.error ?? '', notice: request.query.notice === 'message' ? 'Message updated.' : '',
  });
}

function formText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
