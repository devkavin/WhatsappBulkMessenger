import { isDelivered, isProviderId, record, retryDelay } from './policy.ts';
import type { Invitation } from '../invitations/service.ts';
import type { mediaLinks } from './media.ts';

const MESSAGES_URL = 'https://api.wassenger.com/v1/messages';
const TICKET_FIELD = '{{ticket_number}}';
export type ProviderConfig = {
  token: string; device: string; connector: 'business' | 'qr';
  template: { name: string; language: string; body: string } | null;
};

export type Submission =
  | {status: 'submitted'; id: string; alias: string | null}
  | {status: 'delivered'}
  | {status: 'throttled'; delay: number}
  | {status: 'failed' | 'review'; note: string};

export type ProviderLookup = { id: string | null; reference: string; phone: string };
export type ProviderObservation = { id: string; alias: string | null; status: 'delivered' | 'failed' | null };

export interface DeliveryProvider {
  send(invitation: Invitation, reference: string): Promise<Submission>;
  check?(lookup: ProviderLookup): Promise<{ observation?: ProviderObservation; backoff?: number }>;
}

export const simulate: DeliveryProvider = { async send() { return {status: 'delivered'}; } };

export function renderApprovedBody(body: string, ticket: string) {
  return body.replace(TICKET_FIELD, () => ticket);
}

export function wassengerProvider(settings: ProviderConfig, links: ReturnType<typeof mediaLinks>, request = fetch): DeliveryProvider {
  const headers = { Token: settings.token, 'Content-Type': 'application/json' };
  return {
    async send(invitation, reference) {
      const url = links.forImage(invitation.imageId);
      const envelope = { device: settings.device, phone: invitation.phone, reference };
      const approved = settings.template;
      if (settings.connector === 'business' && (!approved || invitation.message !== renderApprovedBody(approved.body, invitation.ticketNumber))) {
        return { status: 'failed', note: 'The saved message differs from the configured approved template.' };
      }
      const payload = settings.connector === 'business' && approved ? {
        ...envelope,
        template: {
          name: approved.name, language: approved.language,
          header: { media: { type: 'image', url } },
          body: [{ name: '1', value: invitation.ticketNumber }],
        },
      } : { ...envelope, message: invitation.message, media: { url } };

      try {
        const response = await request(MESSAGES_URL, {
          method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(20_000),
        });
        if (response.status === 429) return { status: 'throttled', delay: retryDelay(response.headers.get('Retry-After'), Date.now()) };
        if (response.status >= 400 && response.status < 500 && ![408, 409].includes(response.status)) {
          return { status: 'failed', note: `Wassenger rejected the request (HTTP ${response.status}).` };
        }
        if (!response.ok) return { status: 'review', note: `Wassenger returned HTTP ${response.status}. Check the attempt before resending.` };
        const data = record(await response.json());
        if (!isProviderId(data.id)) return { status: 'review', note: 'Wassenger did not return a message ID. Check the attempt before resending.' };
        return { status: 'submitted', id: data.id, alias: isProviderId(data.wid) ? data.wid : null };
      } catch {
        return { status: 'review', note: 'The Wassenger response could not be confirmed. Check the attempt before resending.' };
      }
    },
    async check({id, reference, phone}) {
      try {
        const url = id ? `${MESSAGES_URL}/${encodeURIComponent(id)}` : `${MESSAGES_URL}?${new URLSearchParams({device:settings.device, reference, size:'2'})}`;
        const response = await request(url, {
          headers, redirect: 'error', signal: AbortSignal.timeout(8_000),
        });
        if (response.status === 429) return { backoff: retryDelay(response.headers.get('Retry-After'), Date.now()) };
        if (!response.ok) return {};
        const result: unknown = await response.json();
        const data = id ? record(result) : exactMatch(result, reference, phone, settings.device);
        if (!isProviderId(data.id) || (id && id !== data.id)) return {};
        const status = isDelivered(data.deliveryStatus) || isDelivered(data.ack) ? 'delivered' :
          data.deliveryStatus === 'failed' || data.status === 'failed' ? 'failed' : null;
        return { observation: {id:data.id, alias:isProviderId(data.wid) ? data.wid : null, status} };
      } catch { return {}; }
    },
  };
}

function exactMatch(value: unknown, reference: string, phone: string, device: string) {
  const object = record(value);
  const items = Array.isArray(value) ? value : object.data ?? object.items ?? object.messages;
  if (!Array.isArray(items)) return {};
  const matches = items.map(record).filter(row => {
    const sender = record(row.device).id ?? row.device;
    return row.reference === reference && row.phone === phone && (!sender || sender === device);
  });
  return matches.length === 1 ? matches[0] : {};
}
