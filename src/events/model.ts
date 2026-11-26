import type { DeliverySettings } from '../delivery/settings.ts';

export type InvitationEvent = {
  id: number; name: string; createdAt: Date; archivedAt: Date | null; archivedMode: DeliverySettings['mode'] | null;
};
export type EventPreview = { event: InvitationEvent; pending: number; inFlight: boolean; archived: InvitationEvent[] };

export interface EventsRepository {
  preview(): Promise<EventPreview>;
  findArchived(id: number): Promise<InvitationEvent | null>;
  startNext(expectedId: number, expectedPending: number, name: string, now: Date): Promise<void>;
}

export class EventConflictError extends Error {
  constructor(message = 'The active event changed. Refresh the page and try again.') { super(message); }
}

export function eventIdFrom(value: unknown) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) return undefined;
  const id = Number(value);
  return id <= 4_294_967_295 ? id : undefined;
}
