import { resolve } from 'node:path';
import express from 'express';
import type { ErrorRequestHandler, Request, Response } from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { installOperatorSession, requireOperator, requireRequestToken, wantsJson } from './auth/session.ts';
import type { OperatorConfig } from './auth/session.ts';
import { CSV_MAX_BYTES, IMAGE_BATCH_SIZE, IMAGE_MAX_BYTES } from './files/service.ts';
import type { FilesService } from './files/service.ts';
import { ImportError } from './imports/contacts.ts';
import { invitationRoutes } from './invitations/routes.ts';
import type { InvitationsService } from './invitations/service.ts';
import { deliveryRoutes } from './delivery/routes.ts';
import type { DeliveryUi } from './delivery/routes.ts';
import { eventRoutes, findArchivedEvent } from './events/routes.ts';
import { EventConflictError, eventIdFrom } from './events/model.ts';
import type { EventsRepository, InvitationEvent } from './events/model.ts';

const PAGE_SIZE = 25;
const csvUpload = multer({
  preservePath: true,
  defParamCharset: 'utf8',
  limits: { fileSize: CSV_MAX_BYTES + 1, files: 1, fields: 2, parts: 4 },
}).single('csv');
const imageUpload = multer({
  preservePath: true,
  defParamCharset: 'utf8',
  limits: { fileSize: IMAGE_MAX_BYTES + 1, files: IMAGE_BATCH_SIZE, fields: 3, parts: IMAGE_BATCH_SIZE + 4 },
}).array('images', IMAGE_BATCH_SIZE);

export function createApp({ filesService, invitationsService, config, delivery, events }: {
  filesService: FilesService;
  invitationsService: InvitationsService;
  config: OperatorConfig;
  delivery?: DeliveryUi;
  events?: EventsRepository;
}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', resolve('views'));
  app.locals.eventsEnabled = Boolean(events);
  app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: null, imgSrc: ["'self'", 'data:', 'blob:'] } } }));
  app.use('/assets', express.static(resolve('public'), { index: false }));
  const smallForm = express.urlencoded({ extended: false, limit: '8kb' });
  app.use(['/login', '/logout'], smallForm);
  app.get('/health', (_request, response) => response.type('text').send('OK'));
  installOperatorSession(app, config);

  app.get('/', requireOperator, (_request, response) => response.redirect(303, '/files'));
  app.use('/files', requireOperator);

  app.get('/files', (request, response) => renderFiles(request, response, filesService));
  app.post('/files/csv', csvUpload, requireRequestToken, async (request, response) => {
    const eventId = eventIdFrom(request.body?.eventId);
    if (events && !eventId) throw new EventConflictError();
    try {
      if (!request.file) throw new ImportError('Choose a CSV file to upload.');
      await filesService.replaceCsv(request.file.originalname, request.file.buffer, eventId);
    } catch (error) {
      if (!(error instanceof ImportError)) throw error;
      return renderFiles(request, response, filesService, error.message, 422);
    }
    response.redirect(303, '/files?notice=csv');
  });
  app.post('/files/images', imageUpload, requireRequestToken, async (request, response) => {
    const eventId = eventIdFrom(request.body?.eventId);
    if (events && !eventId) throw new EventConflictError();
    const images = Array.isArray(request.files) ? request.files : [];
    if (!images.length) return uploadError(request, response, 'Choose at least one image to upload.', 422);
    const ticket = typeof request.body?.ticket === 'string' ? request.body.ticket : '';
    if (ticket && (images.length !== 1 || images[0].originalname.replace(/\.[^.]+$/, '') !== ticket)) {
      return uploadError(request, response, 'Choose an image named for the ticket you’re updating.', 422);
    }
    const result = await filesService.uploadImages(images.map(file => ({ filename: file.originalname, bytes: file.buffer })), eventId);
    if (wantsJson(request)) return response.json(result);
    if (result.errors.length) {
      const message = result.errors.map(issue => `${issue.filename} — ${issue.reason}`).join(' ');
      return renderFiles(request, response, filesService, message, 422);
    }
    response.redirect(303, '/files?notice=images#images');
  });
  app.get('/files/images/:id', async (request, response, next) => {
    const image = await filesService.openImage(request.params.id);
    if (!image) return response.sendStatus(404);
    response.type(image.contentType).sendFile(image.path, { cacheControl: false }, error => {
      if (error) next(error);
    });
  });
  app.post('/files/images/:id/remove', smallForm, requireRequestToken, async (request, response) => {
    const { id } = request.params;
    if (typeof id !== 'string') return response.sendStatus(404);
    await filesService.removeDraftImage(id);
    response.redirect(303, '/files#images');
  });
  if (events) {
    app.use(eventRoutes(events));
    app.get('/events/:eventId/files', async (request, response) => {
      const event = await findArchivedEvent(events, request.params.eventId);
      if (!event) return response.sendStatus(404);
      await renderFiles(request, response, filesService, '', 200, event);
    });
  }
  app.use(invitationRoutes(invitationsService, delivery, events));
  if (delivery) app.use(deliveryRoutes({ ...delivery, files:filesService, invitations:invitationsService, origin:config.origin, secret:config.sessionSecret }));

  const displayError: ErrorRequestHandler = (error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (error instanceof EventConflictError) {
      uploadError(request, response, error.message, 409);
      return;
    }
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? 'An upload exceeds the size limit.' : 'Choose fewer files and try again.';
      uploadError(request, response, message, 422);
      return;
    }
    if (error?.status === 404) { response.sendStatus(404); return; }
    if (error?.status === 400 || error?.status === 413) {
      uploadError(request, response, 'The form could not be read. Try a smaller selection.', error.status);
      return;
    }
    console.error('Request failed', typeof error?.code === 'string' ? error.code : 'UNKNOWN');
    uploadError(request, response, 'The request could not be saved or loaded. Check the app’s database and storage settings.', 500);
  };
  app.use(displayError);
  return app;
}

async function renderFiles(request: Request, response: Response, service: FilesService, error = '', status = 200, archive?: InvitationEvent) {
  const state = await service.read(archive?.id);
  const issues = state.csv?.contacts.filter(contact => contact.issues.length) ?? [];
  const attention = state.matches.rows.filter(row => row.status !== 'matched');
  const views = ['all', 'attention', 'unmatched'] as const;
  const view = views.find(value => value === request.query.view) ?? (attention.length ? 'attention' : 'all');
  const displayed = view === 'attention' ? attention : state.matches.rows;
  const total = view === 'unmatched' ? state.matches.unmatched.length : displayed.length;
  const requestedPage = typeof request.query.page === 'string' && /^\d+$/.test(request.query.page) ? Number(request.query.page) : 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, requestedPage));
  const offset = (page - 1) * PAGE_SIZE;

  response.status(status).render('files', {
    csrf: request.session?.csrf,
    archive, eventId:state.eventId, eventName:state.eventName, filesPath:archive ? `/events/${archive.id}/files` : '/files',
    csv: state.csv,
    issues,
    allCount: state.matches.rows.length,
    attentionCount: attention.length,
    unmatchedCount: state.matches.unmatched.length,
    matchedCount: state.matches.rows.length - attention.length,
    view,
    rows: displayed.slice(offset, offset + PAGE_SIZE),
    unmatched: state.matches.unmatched.slice(offset, offset + PAGE_SIZE),
    page,
    pages,
    total,
    offset,
    end: Math.min(offset + PAGE_SIZE, total),
    batchSize: IMAGE_BATCH_SIZE,
    maxImageBytes: IMAGE_MAX_BYTES,
    error,
    notice: archive ? '' : request.query.notice === 'event' ? 'Event created. Upload the contact list and ticket images.' :
      request.query.notice === 'csv' ? 'Contact list updated.' : request.query.notice === 'images' ? 'Ticket images uploaded.' : '',
  });
}

function uploadError(request: Request, response: Response, message: string, status: number) {
  if (wantsJson(request)) return response.status(status).json({ error: message });
  return response.status(status).type('html').render('upload-error', { message });
}
