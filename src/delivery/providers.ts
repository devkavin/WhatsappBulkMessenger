import { isProviderId, record, retryDelay, wassengerStatus } from './policy.ts';
import type { WassengerStatus } from './policy.ts';
import type { Invitation } from '../invitations/service.ts';
import type { mediaLinks } from './media.ts';

const API_URL = 'https://api.wassenger.com/v1';
const MESSAGES_URL = `${API_URL}/messages`;
const TICKET_FIELD = '{{ticket_number}}';
export type ProviderConfig = {
  token: string; device: string; connector: 'business' | 'qr';
  template: { name: string; language: string; body: string } | null;
};

export type Submission =
  | {status: 'submitted'; id: string; alias: string | null; providerStatus: WassengerStatus}
  | {status: 'delivered'}
  | {status: 'throttled'; delay: number}
  | {status: 'failed' | 'review'; note: string};

export type ProviderLookup = { id: string | null; reference: string; phone: string };
export type ProviderObservation = { id: string; alias: string | null; status: WassengerStatus | null };
export type WassengerQueue = { status: string; size: number };
export type RecoveryStatus = WassengerStatus | 'cleared' | 'missing' | 'unknown';

export interface WassengerRecoveryProvider {
  queueStatus(): Promise<WassengerQueue>;
  recoveryStatuses(attempts: ProviderLookup[]): Promise<Map<string, RecoveryStatus>>;
}

export class WassengerLookupError extends Error {}

export interface DeliveryProvider {
  send(invitation: Invitation, reference: string): Promise<Submission>;
  check?(lookup: ProviderLookup): Promise<{ observation?: ProviderObservation; backoff?: number }>;
}

export const simulate: DeliveryProvider = { async send() { return {status: 'delivered'}; } };

export function renderApprovedBody(body: string, ticket: string) {
  return body.replace(TICKET_FIELD, () => ticket);
}

export function wassengerProvider(settings: ProviderConfig, links: ReturnType<typeof mediaLinks>, request = fetch): DeliveryProvider & WassengerRecoveryProvider {
  const headers = { Token: settings.token, 'Content-Type': 'application/json' };

  async function read(url: string, subject: string, signal: AbortSignal): Promise<unknown> {
    try {
      const response = await request(url, { headers, redirect:'error', signal });
      if (!response.ok) throw new WassengerLookupError(`Could not check ${subject} in Wassenger (HTTP ${response.status}). Try again.`);
      return await response.json();
    } catch (error) {
      if (error instanceof WassengerLookupError) throw error;
      throw new WassengerLookupError(`Could not check ${subject} in Wassenger. Try again.`);
    }
  }

  return {
    async queueStatus() {
      const payload = await read(`${API_URL}/devices/${encodeURIComponent(settings.device)}/queue`, 'the sender queue', AbortSignal.timeout(8000));
      const {status, size} = record(record(payload).queue);
      if (typeof status !== 'string' || !status || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
        throw new WassengerLookupError('Wassenger did not return a valid queue size. Try again.');
      }
      return {status, size};
    },
    async recoveryStatuses(attempts) {
      const statuses = new Map<string, RecoveryStatus>();
      const signal = AbortSignal.timeout(12_000);
      // Keep URLs short and leave room to detect duplicate references without mistaking a full page for missing records.
      const batchSize = 25;
      for (let offset = 0; offset < attempts.length; offset += batchSize) {
        const batch = attempts.slice(offset, offset + batchSize);
        const query = new URLSearchParams({device:settings.device, status:'any', size:'100', reference:batch.map(row => row.reference).join(',')});
        const payload = await read(`${MESSAGES_URL}?${query}`, 'message history', signal);
        if (!Array.isArray(payload) || payload.length >= 100) {
          throw new WassengerLookupError('Wassenger did not return complete message history. Try again.');
        }
        const rows = payload.map(record);
        const expected = new Set(batch.map(attempt => attempt.reference));
        if (rows.some(row => typeof row.reference !== 'string' || !expected.has(row.reference))) {
          throw new WassengerLookupError('Wassenger returned unmatched message history. Try again.');
        }
        for (const attempt of batch) {
          const matches = rows.filter(row => row.reference === attempt.reference);
          const [row] = matches;
          statuses.set(attempt.reference, !row ? 'missing' : matches.length === 1 && isProviderId(row.id) &&
            (!attempt.id || attempt.id === row.id) && matchesRecipient(row, attempt.phone, settings.device) ? recoveryStatus(row) : 'unknown');
        }
      }
      return statuses;
    },
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
        return { status: 'submitted', id: data.id, alias: isProviderId(data.wid) ? data.wid : null,
          providerStatus: wassengerStatus(data.ack, data.deliveryStatus, data.status) ?? 'accepted' };
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
        const status = wassengerStatus(data.ack, data.deliveryStatus, data.status);
        return { observation: {id:data.id, alias:isProviderId(data.wid) ? data.wid : null, status} };
      } catch { return {}; }
    },
  };
}

function exactMatch(value: unknown, reference: string, phone: string, device: string) {
  const object = record(value);
  const items = Array.isArray(value) ? value : object.data ?? object.items ?? object.messages;
  if (!Array.isArray(items)) return {};
  const matches = items.map(record).filter(row => row.reference === reference && matchesRecipient(row, phone, device));
  return matches.length === 1 ? matches[0] : {};
}

function matchesRecipient(row: Record<string, unknown>, phone: string, device: string) {
  const sender = record(row.device).id ?? row.device;
  return row.phone === phone && (!sender || sender === device);
}

function recoveryStatus(row: Record<string, unknown>): RecoveryStatus {
  const status = wassengerStatus(row.ack, row.deliveryStatus, row.status);
  if (status === 'sent' || status === 'delivered') return status;
  if (row.status === 'processing' || row.deliveryStatus === 'processing') return 'unknown';
  if (row.status === 'removed' || row.status === 'expired' || row.deliveryStatus === 'cancelled') return 'cleared';
  return status ?? 'unknown';
}
