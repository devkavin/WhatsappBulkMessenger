import { randomUUID } from 'node:crypto';
import { Router, json, urlencoded } from 'express';
import multer from 'multer';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import type { CountryCode } from 'libphonenumber-js/max';
import type { Request, Response } from 'express';
import { requireOperator, requireRequestToken } from '../auth/session.ts';
import { IMAGE_MAX_BYTES } from '../files/service.ts';
import type { FilesService } from '../files/service.ts';
import { ImportError } from '../imports/contacts.ts';
import { renderInvitation } from '../invitations/service.ts';
import type { InvitationsService } from '../invitations/service.ts';
import { mediaLinks, safeEqual } from './media.ts';
import { receiptEvents } from './policy.ts';
import { deliveryDisplay, wassengerLabels } from './status.ts';
import type { DeliverySettings } from './settings.ts';
import { deliveryContext, DeliveryInputError } from './worker.ts';
import type { DeliveryRepository } from './worker.ts';

export type DeliveryUi = { repository: DeliveryRepository; settings: DeliverySettings; country?: CountryCode };
export const deliveryLabels = {
  queued: 'Queued', submitting: 'Submitting', submitted: 'Submitted', delivered: 'Delivered', failed: 'Failed',
  review: 'Needs review', cancelled: 'Cancelled', removed: 'Removed',
};
export const deliveryTime = new Intl.DateTimeFormat('en-LK', {timeZone:'Asia/Colombo', dateStyle:'medium', timeStyle:'short'});
const readForm = urlencoded({ extended:false, limit:'16kb' });
const readImage = multer({ preservePath:true, defParamCharset:'utf8', limits:{files:1, fields:105, fileSize:IMAGE_MAX_BYTES + 1} }).single('image');

export function deliveryRoutes(deps: DeliveryUi & {
  files: FilesService; invitations: InvitationsService; origin: string; secret: string;
}) {
  const { repository, settings, files, invitations } = deps;
  const context = deliveryContext(settings);
  const links = mediaLinks(deps.origin, deps.secret);
  const router = Router();
  const historyView = { deliveryLabels, deliveryDisplay, wassengerLabels, displayTime:deliveryTime };

  router.post('/webhooks/wassenger', (request, response, next) => {
    if (!settings.provider) return response.sendStatus(404);
    const secret = request.get('X-Dinner-Dance-Webhook-Secret') ?? request.query.secret;
    if (typeof secret !== 'string' || !safeEqual(secret, settings.webhookSecret)) return response.sendStatus(401);
    next();
  }, json({limit:'1mb'}), async (request, response) => {
    const device = settings.provider!.device;
    const processed = await repository.receipts(device, receiptEvents(request.body, device), new Date());
    if (processed === false) return response.sendStatus(503);
    response.status(204).end();
  });

  router.get('/delivery-media/:id/:expires/:signature', async (request, response, next) => {
    const {id, expires, signature} = request.params;
    if (!links.verify(id, expires, signature)) return response.sendStatus(404);
    const image = await files.openImage(id);
    if (!image) return response.sendStatus(404);
    response.set('Cache-Control','private, no-store').type(image.contentType).sendFile(image.path, {cacheControl:false}, error => {
      if (error) next(error);
    });
  });

  router.use('/test-sends', requireOperator);
  router.get('/test-sends', (request, response) => render(request, response));
  router.get('/test-sends/status', async (_request, response) => {
    response.render('test-history', { ...historyView, history:await repository.testHistory() });
  });
  router.post('/test-sends/recipients', readForm, requireRequestToken, async (request, response) => {
    const name = text(request.body?.name).trim();
    const phone = parsePhoneNumberFromString(text(request.body?.phone).trim(), { defaultCountry:deps.country ?? 'LK', extract:false });
    if (!name || name.length > 200 || !phone?.isValid() || phone.ext || request.body?.consent !== 'yes') {
      return render(request, response, 'Enter a name, a valid phone number and confirmation that the recipient agreed to receive tests.');
    }
    await repository.saveTestRecipient(name, phone.number);
    response.redirect(303,'/test-sends');
  });
  router.post('/test-sends/recipients/:id/remove', readForm, requireRequestToken, async (request, response) => {
    if (isUuid(text(request.params.id))) await repository.removeTestRecipient(text(request.params.id), new Date());
    response.redirect(303,'/test-sends');
  });
  router.post('/test-sends/send', readImage, requireRequestToken, async (request, response) => {
    try {
      const key = text(request.body?.testKey);
      const ticketNumber = text(request.body?.ticket).trim();
      const raw = request.body?.recipient;
      const selected = [...new Set((Array.isArray(raw) ? raw : [raw]).map(text))];
      if (!isUuid(key) || !selected.length || selected.length > 100 || selected.some(id => !isUuid(id))) {
        throw new DeliveryInputError('Select saved test recipients and try again.');
      }
      if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(ticketNumber) || !request.file) {
        throw new DeliveryInputError('Enter a sample ticket number and attach a PNG or JPEG test image.');
      }
      const review = await invitations.review();
      if (review.version !== request.body?.version) throw new DeliveryInputError('The invitation changed. Preview the updated message before sending the test.');
      const message = renderInvitation(review.template, ticketNumber);
      if (context.approvedBody && message !== renderInvitation(context.approvedBody, ticketNumber)) {
        throw new DeliveryInputError('Update the invitation to match the configured approved template before sending a live test.');
      }
      const saved = new Set((await repository.testRecipients()).map(row => row.id));
      if (selected.some(id => !saved.has(id))) throw new DeliveryInputError('A selected test recipient was removed. Refresh the selection.');
      const imageId = await files.saveTestImage({filename:request.file.originalname, bytes:request.file.buffer});
      await repository.enqueueTest(context, key, selected, {ticketNumber, imageId, message}, new Date());
      response.redirect(303, '/test-sends?queued=1');
    } catch (error) {
      if (!(error instanceof DeliveryInputError) && !(error instanceof ImportError)) throw error;
      return render(request, response, error.message);
    }
  });

  async function render(request: Request, response: Response, error = '') {
    const [review, recipients, history] = await Promise.all([invitations.review(), repository.testRecipients(), repository.testHistory()]);
    return response.status(error ? 422 : 200).render('test-sends', { csrf: request.session?.csrf, error, recipients, history,
      mode:settings.mode, template:review.template, version:review.version, key:randomUUID(), queued:request.query.queued === '1',
      ...historyView });
  }
  return router;
}

function text(value: unknown) { return typeof value === 'string' ? value : ''; }
function isUuid(value: string) { return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value); }
