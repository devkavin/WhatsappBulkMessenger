import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import cookieSession from 'cookie-session';
import type { Express, Request, RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

const SESSION_AGE = 8 * 60 * 60 * 1000;
export type OperatorConfig = { password: string; sessionSecret: string; origin: string };

export function installOperatorSession(app: Express, config: OperatorConfig) {
  const secure = config.origin.startsWith('https://');
  if (secure) app.set('trust proxy', 1);
  const key = createHmac('sha256', config.sessionSecret).update(config.password).digest('hex');
  const expectedPassword = digest(config.password);

  app.use(cookieSession({ name: 'dinnerdance', keys: [key], secure, sameSite: 'strict', httpOnly: true, maxAge: SESSION_AGE }));
  app.get('/login', (request, response) => {
    if (signedIn(request)) return response.redirect(303, '/files');
    request.session = { csrf: randomUUID() };
    response.set('Cache-Control', 'no-store').render('login', { csrf: request.session.csrf, error: '' });
  });
  app.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, legacyHeaders: false }), requireRequestToken, (request, response) => {
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (!timingSafeEqual(digest(password), expectedPassword)) {
      return response.status(401).set('Cache-Control', 'no-store').render('login', {
        csrf: request.session?.csrf,
        error: 'That password did not match.',
      });
    }
    request.session = { csrf: randomUUID(), expiresAt: Date.now() + SESSION_AGE };
    response.redirect(303, '/files');
  });
  app.post('/logout', requireRequestToken, (request, response) => {
    request.session = null;
    response.redirect(303, '/login');
  });
}

export const requireOperator: RequestHandler = (request, response, next) => {
  response.set('Cache-Control', 'no-store');
  if (signedIn(request)) return next();
  if (wantsJson(request)) return response.status(401).json({ error: 'Sign in again and retry the upload.' });
  response.redirect(303, '/login');
};

export const requireRequestToken: RequestHandler = (request, response, next) => {
  const expected = request.session?.csrf;
  const provided = request.get('X-CSRF-Token') ?? request.body?._csrf;
  if (typeof expected === 'string' && typeof provided === 'string' && timingSafeEqual(digest(expected), digest(provided))) {
    return next();
  }
  const message = 'The form expired. Refresh the page and try again.';
  if (wantsJson(request)) return response.status(403).json({ error: message });
  response.status(403).type('text').send(message);
};

export function wantsJson(request: Request): boolean {
  return request.get('Accept')?.includes('application/json') ?? false;
}

function signedIn(request: Request) {
  const expiresAt = request.session?.expiresAt;
  return typeof expiresAt === 'number' && expiresAt > Date.now();
}

function digest(value: string) {
  return createHash('sha256').update(value).digest();
}
