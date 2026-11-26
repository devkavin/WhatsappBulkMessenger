import { Router, urlencoded } from 'express';
import type { Request, Response } from 'express';
import { requireOperator, requireRequestToken } from '../auth/session.ts';
import { deliveryView } from '../delivery/status.ts';
import { EventConflictError, eventIdFrom } from './model.ts';
import type { EventsRepository, InvitationEvent } from './model.ts';

export function eventRoutes(repository: EventsRepository) {
  const router = Router();
  router.use('/events', requireOperator);
  const render = async (request: Request, response: Response, status: number, error = '', name = '') => {
    response.status(status).render('events', { ...await repository.preview(), csrf:request.session?.csrf, error, name, ...deliveryView });
  };
  router.get('/events', (request, response) => render(request, response, 200));
  const readForm = urlencoded({extended:false, limit:'8kb'});
  router.post('/events', readForm, requireRequestToken, async (request, response) => {
    const id = eventIdFrom(request.body?.eventId);
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
    if (!id) return render(request, response, 409, 'Refresh the events page before creating an event.', name);
    if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) {
      return render(request, response, 422, 'Enter an event name of 120 characters or fewer.');
    }
    try {
      await repository.create(id, name, new Date());
    } catch (error) {
      if (!(error instanceof EventConflictError)) throw error;
      return render(request, response, 409, error.message, name);
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
      return render(request, response, 409, error.message);
    }
    response.redirect(303, '/queue');
  });
  router.post('/events/:eventId/archive', readForm, requireRequestToken, async (request, response) => {
    const id = eventIdFrom(request.params.eventId);
    const count = request.body?.pending;
    if (!id || typeof count !== 'string' || !/^\d{1,10}$/.test(count) || request.body?.confirm !== 'yes') {
      return render(request, response, 422, 'Review the pending count and confirm before archiving.');
    }
    try {
      await repository.archive(id, Number(count), new Date());
    } catch (error) {
      if (!(error instanceof EventConflictError)) throw error;
      return render(request, response, 409, error.message);
    }
    response.redirect(303, '/events');
  });
  return router;
}

export async function findArchivedEvent(repository: EventsRepository, value: unknown): Promise<InvitationEvent | null> {
  const id = eventIdFrom(value);
  return id === undefined ? null : repository.findArchived(id);
}
