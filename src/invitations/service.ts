import { createHash } from 'node:crypto';
import type { FilesService } from '../files/service.ts';
import type { ImageMatch } from '../imports/matches.ts';

export const DEFAULT_TEMPLATE = 'You’re invited to the Dinner Dance! Ticket {{ticket_number}}.';
export const MESSAGE_MAX_LENGTH = 2000;
const TICKET_PLACEHOLDER = /\{\{\s*ticket_number\s*\}\}/g;

export type InvitationDraft = { template: string | null; revision: number; eventId?: number; eventName?: string };
export type Invitation = {
  ticketNumber: string;
  name: string;
  phone: string;
  imageId: string;
  message: string;
};

export type StagedInvitation = Invitation & { id: string; status: 'queued' | 'removed'; updatedAt: Date };

export interface InvitationsRepository {
  readDraft(): Promise<InvitationDraft>;
  saveMessage(template: string, eventId?: number): Promise<void>;
  readQueue(eventId?: number): Promise<StagedInvitation[]>;
  stage(invitations: Invitation[], expected: InvitationDraft): Promise<number>;
  remove(id: string): Promise<boolean>;
}

export class InvitationInputError extends Error {}

export class StaleReviewError extends InvitationInputError {
  constructor() { super('The draft or queue changed. Review the updated invitations before adding them.'); }
}

type ReviewRow = Omit<ImageMatch, 'status'> & {
  imageStatus: ImageMatch['status'];
  status: 'ready' | 'attention' | 'queued';
  selectionKey: string;
  candidateIndex: number | null;
  message: string;
};

type Review = {
  filename: string | null;
  imageCount: number;
  template: string;
  rows: ReviewRow[];
  candidateCount: number;
  version: string;
  eventId?: number;
  eventName?: string;
};

export class InvitationsService {
  private readonly files: Pick<FilesService, 'read'>;
  private readonly repository: InvitationsRepository;

  constructor(files: Pick<FilesService, 'read'>, repository: InvitationsRepository) {
    this.files = files;
    this.repository = repository;
  }

  async review(): Promise<Review> {
    return (await this.load()).review;
  }

  async saveMessage(value: string, eventId?: number) {
    const template = value.replace(/\r\n?/g, '\n').trim();
    if (template.length > MESSAGE_MAX_LENGTH) {
      throw new InvitationInputError(`Keep the message to ${MESSAGE_MAX_LENGTH} characters or fewer.`);
    }
    const literal = template.replace(TICKET_PLACEHOLDER, '');
    if (literal === template || literal.includes('{{') || literal.includes('}}')) {
      throw new InvitationInputError('Use {{ticket_number}} for the ticket number. It is the only supported variable.');
    }
    await this.repository.saveMessage(template, eventId);
  }

  async stage(version: string, submitted: string[] | { bitmap: string }) {
    const { draft, review, candidates } = await this.load();
    if (version !== review.version) throw new StaleReviewError();

    const tickets = Array.isArray(submitted) ? submitted : decodeSelection(submitted.bitmap, candidates);
    const selection = new Set(tickets);
    if (!selection.size) throw new InvitationInputError('Select at least one eligible recipient.');
    const invitations = candidates.filter(invitation => selection.has(invitation.ticketNumber));
    if (selection.size !== invitations.length) {
      throw new InvitationInputError('A selected ticket is no longer eligible. Review the rows before adding them.');
    }
    return this.repository.stage(invitations, draft);
  }

  readDraft() { return this.repository.readDraft(); }
  readQueue(eventId?: number) { return this.repository.readQueue(eventId); }

  async remove(id: string) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) return false;
    return this.repository.remove(id);
  }

  private async load() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const draft = await this.repository.readDraft();
      const [files, queue] = await Promise.all([this.files.read(draft.eventId), this.repository.readQueue(draft.eventId)]);
      const current = await this.repository.readDraft();
      if (draft.revision === current.revision && draft.template === current.template && draft.eventId === current.eventId) {
        return { draft, ...buildReview(files, draft, queue) };
      }
    }
    throw new StaleReviewError();
  }
}

function buildReview(files: Awaited<ReturnType<FilesService['read']>>, draft: InvitationDraft, queue: StagedInvitation[]) {
  const template = draft.template ?? DEFAULT_TEMPLATE;
  const activeTickets = new Set(queue.filter(item => item.status !== 'removed').map(item => item.ticketNumber));
  const candidates: Invitation[] = [];
  const rows = files.matches.rows.map((row): ReviewRow => {
    const { contact } = row;
    const message = renderInvitation(template, contact.ticketNumber);
    const problems = [...contact.issues];
    if (row.status === 'missing') problems.push('Missing image');
    if (row.status === 'conflict') problems.push('Conflicting images');
    let candidateIndex = null;
    if (contact.phone && !problems.length) {
      candidateIndex = candidates.length;
      candidates.push({ ticketNumber: contact.ticketNumber, name: contact.name, phone: contact.phone, imageId: row.images[0].id, message });
    }
    const status = activeTickets.has(contact.ticketNumber) ? 'queued' : !contact.phone || problems.length ? 'attention' : 'ready';
    return { ...row, imageStatus: row.status, status, candidateIndex, message, selectionKey: digest([contact.ticketNumber, contact.phone]) };
  });

  return {
    candidates,
    review: {
      filename: files.csv?.filename ?? null,
      imageCount: files.images.length,
      template,
      rows,
      candidateCount: candidates.length,
      version: digest([draft.eventId, draft.revision, template, candidates]),
      eventId: draft.eventId,
      eventName: draft.eventName,
    },
  };
}

export function renderInvitation(template: string, ticket: string) {
  return template.replace(TICKET_PLACEHOLDER, () => ticket);
}

function decodeSelection(value: string, candidates: Invitation[]) {
  const bytes = Buffer.from(value, 'base64url');
  const remainder = candidates.length % 8;
  if (bytes.length !== Math.ceil(candidates.length / 8) || bytes.toString('base64url') !== value ||
      (remainder && bytes[bytes.length - 1] >> remainder)) {
    throw new InvitationInputError('The selection is invalid. Refresh the review and select recipients again.');
  }
  return candidates.filter((_invitation, index) => bytes[index >> 3] & (1 << (index % 8))).map(invitation => invitation.ticketNumber);
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}
