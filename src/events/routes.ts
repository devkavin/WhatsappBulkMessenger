import { Router, urlencoded } from 'express';
import type { Request, Response } from 'express';
import { requireOperator, requireRequestToken } from '../auth/session.ts';
import { deliveryView } from '../delivery/status.ts';
import { EventConflictError, eventIdFrom } from './model.ts';
import type { EventsRepository, InvitationEvent } from './model.ts';

export function eventRoutes(repository: EventsRepository) {
  const router = Router();
  router.use('/events', requireOperator);
  const render = async (request: Request, response: Response, options: {
    status?: number; error?: string; name?: string; create?: boolean; archiveId?: number;
  } = {}) => {
    const preview = await repository.preview(pageNumber(request.query.openPage), pageNumber(request.query.pastPage), options.archiveId);
    const pageUrl = (openPage = preview.open.page, pastPage = preview.archived.page) =>
      `/events?${new URLSearchParams({openPage:String(openPage), pastPage:String(pastPage)})}`;
    const unavailable = options.archiveId !== undefined && !preview.archive;
    response.status(options.status ?? (unavailable ? 404 : 200)).render('events', {
      ...preview, ...deliveryView, csrf:request.session?.csrf, pageUrl, name:options.name ?? '',
      createOpen:options.create ?? false, error:options.error ?? (unavailable ? 'This event is already archived or unavailable.' : ''),
    });
  };
  router.get('/events', (request, response) => render(request, response, {
    create:request.query.create === '1', archiveId:eventIdFrom(request.query.archiveEvent),
  }));
  const readForm = urlencoded({extended:false, limit:'8kb'});
  router.post('/events', readForm, requireRequestToken, async (request, response) => {
    const id = eventIdFrom(request.body?.eventId);
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
    if (!id) return render(request, response, { status:409, error:'Refresh the events page before creating an event.', name, create:true });
    if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) {
      return render(request, response, { status:422, error:'Enter an event name of 120 characters or fewer.', create:true });
    }
    try {
      await repository.create(id, name, new Date());
    } catch (error) {
      if (!(error instanceof EventConflictError)) throw error;
      return render(request, response, { status:409, error:error.message, name, create:true });
    }
    response.redirect(303, '/files?notice=event');
  });
  router.post('/events/:eventId/select', readForm, requireRequestToken, async (request, response) => {
    const id = eventIdFrom(request.params.eventId);
    if (!id) return response.sendStatus(404);
    try {
      await repository.select(id);
    } catch (error) {
      if (!(error instanceof EventConflictError)) throw error;
      return render(request, response, { status:409, error:error.message });
    }
    response.redirect(303, '/queue');
  });
  router.post('/events/:eventId/archive', readForm, requireRequestToken, async (request, response) => {
    const id = eventIdFrom(request.params.eventId);
    const count = request.body?.pending;
    if (!id || typeof count !== 'string' || !/^\d{1,10}$/.test(count) || request.body?.confirm !== 'yes') {
      return render(request, response, { status:422, error:'Review the pending count and confirm before archiving.', archiveId:id });
    }
    try {
      await repository.archive(id, Number(count), new Date());
    } catch (error) {
      if (!(error instanceof EventConflictError)) throw error;
      return render(request, response, { status:409, error:error.message, archiveId:id });
    }
    const params = new URLSearchParams({openPage:String(pageNumber(request.query.openPage)), pastPage:String(pageNumber(request.query.pastPage))});
    response.redirect(303, `/events?${params}`);
  });
  return router;
}

function pageNumber(value: unknown) {
  return typeof value === 'string' && /^\d{1,10}$/.test(value) ? Math.max(1, Number(value)) : 1;
}

export async function findArchivedEvent(repository: EventsRepository, value: unknown): Promise<InvitationEvent | null> {
  const id = eventIdFrom(value);
  return id === undefined ? null : repository.findArchived(id);
}
