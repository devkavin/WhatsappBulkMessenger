import { Router, urlencoded } from 'express';
import type { Request, Response } from 'express';
import { requireOperator, requireRequestToken } from '../auth/session.ts';
import { InvitationInputError, MESSAGE_MAX_LENGTH, renderInvitation, StaleReviewError } from './service.ts';
import type { InvitationsService } from './service.ts';
import { deliveryLabels } from '../delivery/routes.ts';
import { deliveryDisplay, wassengerLabels } from '../delivery/status.ts';
import type { DeliveryUi } from '../delivery/routes.ts';
import { deliveryContext, DeliveryInputError } from '../delivery/worker.ts';

const readForm = urlencoded({ extended: false, limit: '512kb', parameterLimit: 10_000 });
const displayTime = new Intl.DateTimeFormat('en-LK', {
  timeZone: 'Asia/Colombo', dateStyle: 'medium', timeStyle: 'short',
});

export function invitationRoutes(service: InvitationsService, delivery?: DeliveryUi) {
  const router = Router();
  router.use(['/recipients', '/queue'], requireOperator);
  router.get('/recipients', (request, response) => renderReview(service, request, response));
  router.post('/recipients/message', readForm, requireRequestToken, async (request, response) => {
    const template = formText(request.body?.template);
    try {
      await service.saveMessage(template);
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
  if (delivery && context) {
    const {repository, settings} = delivery;
    router.post('/queue/control', readForm, requireRequestToken, async (request, response) => {
      try {
        const action = request.body?.action;
        if (action === 'start') {
          if (settings.mode === 'live' && request.body?.consent !== 'yes') throw new DeliveryInputError('Confirm WhatsApp opt-in before starting a live batch.');
          await repository.start(context, new Date());
        } else if (action === 'pause' || action === 'resume') {
          await repository.pause(context, action === 'pause');
        } else if (action === 'end-changed') {
          await repository.endChangedBatch(context, new Date());
        } else { return response.sendStatus(400); }
        response.redirect(303, '/queue');
      } catch (error) {
        if (!(error instanceof DeliveryInputError)) throw error;
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

  async function renderQueue(request: Request, response: Response, error = '') {
    const [staged, dashboard] = await Promise.all([service.readQueue(), delivery && context ? delivery.repository.dashboard(context) : null]);
    const byInvitation = new Map(dashboard?.jobs.map(job => [job.invitationId, job]));
    const all = staged.map(row => {
      const job = byInvitation.get(row.id);
      const { appStatus, provider } = deliveryDisplay(job);
      const removed = row.status === 'removed';
      return {...row, job, provider, status: removed ? row.status : job?.status ?? row.status,
        appStatus: removed ? row.status : appStatus ?? row.status, updatedAt:job?.updatedAt ?? row.updatedAt};
    });
    const counts = {queued:0, submitting:0, submitted:0, delivered:0, failed:0, review:0, removed:0, cancelled:0};
    const appCounts = {...counts};
    const providerCounts = {accepted:0, queued:0, sent:0, delivered:0, failed:0};
    for (const row of all) {
      counts[row.status]++;
      appCounts[row.appStatus]++;
      if (row.status !== 'removed' && row.provider?.status) providerCounts[row.provider.status]++;
    }
    const requested = formText(request.query.view);
    const view = Object.hasOwn(counts, requested) ? requested : 'all';
    const search = formText(request.query.q).trim();
    const needle = search.toLocaleLowerCase();
    const matching = all.filter(row => (view === 'all' ? row.status !== 'removed' : row.status === view) &&
      `${row.ticketNumber} ${row.name} ${row.phone}`.toLocaleLowerCase().includes(needle));
    const pages = Math.max(1, Math.ceil(matching.length / 25));
    const page = Math.max(1, Math.min(pages, Number.parseInt(formText(request.query.page), 10) || 1));
    const rows = matching.slice((page - 1) * 25, page * 25);
    const added = /^\d+$/.test(formText(request.query.added)) ? Number(request.query.added) : null;
    const notice = added === 0 ? 'The selected tickets are already queued.' : added === null ? '' : `${added} ${added === 1 ? 'invitation' : 'invitations'} added to the queue.`;
    const canStart = dashboard?.state === 'waiting' && dashboard.liveReady && counts.queued > 0;
    const refreshUrl = `/queue?${new URLSearchParams({view, q:search, page:String(page)})}`;
    response.status(error ? 409 : 200).render('queue', {
      csrf:request.session?.csrf, dashboard, counts, canStart, error, mode:delivery?.settings.mode,
      rate:delivery?.settings.perMinute, rows, view, search, page, pages, total:matching.length, notice, displayTime,
      deliveryLabels, appCounts, providerCounts, wassengerLabels, refreshUrl,
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
