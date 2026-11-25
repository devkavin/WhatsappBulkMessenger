import { randomUUID } from 'node:crypto';
import { StaleReviewError } from '../../src/invitations/service.ts';
import type { InvitationDraft, InvitationsRepository, StagedInvitation } from '../../src/invitations/service.ts';

export function memoryInvitationsRepository(): InvitationsRepository & { advanceRevision(): void } {
  const draft: InvitationDraft = { template: null, revision: 0 };
  const queue: StagedInvitation[] = [];

  return {
    async readDraft() { return { ...draft }; },
    async saveMessage(next) { draft.template = next; draft.revision++; },
    async readQueue() { return queue.map(row => ({ ...row })); },
    async stage(invitations, expected) {
      if (draft.template !== expected.template || draft.revision !== expected.revision) throw new StaleReviewError();
      let added = 0;
      for (const invitation of invitations) {
        if (queue.some(row => row.ticketNumber === invitation.ticketNumber && row.status !== 'removed')) continue;
        queue.push({ ...invitation, id: randomUUID(), status: 'queued', updatedAt: new Date() });
        added++;
      }
      return added;
    },
    async remove(id) {
      const row = queue.find(item => item.id === id && item.status === 'queued');
      if (!row) return false;
      row.status = 'removed';
      row.updatedAt = new Date();
      draft.revision++;
      return true;
    },
    advanceRevision() { draft.revision++; },
  };
}
