import { createHash } from 'node:crypto';
import type { ProviderConfig } from './providers.ts';

export type DeliveryMode = 'simulate' | 'live';
export type DeliverySettings = {
  mode: DeliveryMode;
  binding: string;
  perMinute: number;
  provider: ProviderConfig | null;
  webhookSecret: string;
};

export function readDeliverySettings(env: NodeJS.ProcessEnv, origin: string): DeliverySettings {
  const mode = env.DELIVERY_MODE || 'simulate';
  const perMinute = Number(env.SEND_PER_MINUTE || 8);
  if (mode !== 'simulate' && mode !== 'live') throw new Error('Set DELIVERY_MODE to simulate or live.');
  if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > 8) throw new Error('Set SEND_PER_MINUTE between 1 and 8.');
  if (mode === 'simulate') return { mode, binding: 'simulation', perMinute, provider: null, webhookSecret: '' };
  const token = env.WASSENGER_API_TOKEN?.trim() ?? '';
  const device = env.WASSENGER_DEVICE_ID?.trim() ?? '';
  const connector = env.WASSENGER_CONNECTOR;
  const webhookSecret = env.WASSENGER_WEBHOOK_SECRET?.trim() ?? '';
  if (!origin.startsWith('https://') || !token || !device || webhookSecret.length < 32 || (connector !== 'business' && connector !== 'qr')) {
    throw new Error('Live sending requires an HTTPS APP_ORIGIN, Wassenger token, device, connector and a webhook secret of at least 32 characters.');
  }
  const template = connector === 'business' ? {
    name: env.WASSENGER_TEMPLATE_NAME?.trim() ?? '', language: env.WASSENGER_TEMPLATE_LANGUAGE?.trim() ?? '',
    body: (env.WASSENGER_TEMPLATE_BODY ?? '').replace(/\r\n?/g, '\n').trim(),
  } : null;
  if (template && (!template.name || !template.language || template.body.split('{{ticket_number}}').length !== 2 ||
      /\{\{|\}\}/.test(template.body.replace('{{ticket_number}}', '')))) {
    throw new Error('Set the approved Wassenger template name, language and matching body with one {{ticket_number}} variable.');
  }
  const binding = createHash('sha256').update(JSON.stringify([origin, device, connector, template])).digest('hex');
  return { mode, binding, perMinute, provider: { token, device, connector, template }, webhookSecret };
}
