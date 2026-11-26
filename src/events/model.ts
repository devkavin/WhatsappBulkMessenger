import type { DeliverySettings } from '../delivery/settings.ts';
import type { Dashboard } from '../delivery/worker.ts';

export type InvitationEvent = {
  id: number; name: string; createdAt: Date; archivedAt: Date | null; archivedMode: DeliverySettings['mode'] | null;
};
export type OpenEvent = InvitationEvent & { sendState: Dashboard['state'] };
export type EventPage<T> = ReturnType<typeof eventPage> & { rows: T[] };
export type EventPreview = {
  event: InvitationEvent; open: EventPage<OpenEvent>; archived: EventPage<InvitationEvent>;
  archive: { event: InvitationEvent; pending: number; inFlight: boolean } | null;
};

export const EVENTS_PER_PAGE = 5;

export function eventPage(total: number, requested: number) {
  const pages = Math.max(1, Math.ceil(total / EVENTS_PER_PAGE));
  const page = Math.max(1, Math.min(pages, requested));
  const offset = (page - 1) * EVENTS_PER_PAGE;
  return { total, page, pages, offset, first: total ? offset + 1 : 0, last: Math.min(total, offset + EVENTS_PER_PAGE) };
}

export interface EventsRepository {
  preview(openPage: number, pastPage: number, archiveId?: number): Promise<EventPreview>;
  findArchived(id: number): Promise<InvitationEvent | null>;
  create(expectedId: number, name: string, now: Date): Promise<void>;
  select(id: number): Promise<void>;
  archive(expectedId: number, expectedPending: number, now: Date): Promise<void>;
}

export class EventConflictError extends Error {
  constructor(message = 'The active event changed. Refresh the page and try again.') { super(message); }
}

export function eventIdFrom(value: unknown) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) return undefined;
  const id = Number(value);
  return id <= 4_294_967_295 ? id : undefined;
}
