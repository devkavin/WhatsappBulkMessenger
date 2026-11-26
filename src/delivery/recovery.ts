import type { ProviderLookup, RecoveryStatus } from './providers.ts';
import type { Job } from './worker.ts';

function confirmedSent(job: Job) {
  return Boolean(job.wasSent) || sentStatus(job.providerStatus);
}

export function canRecover(job: Job) {
  return Boolean(job.reference && !job.leaseUntil && ['submitted', 'review', 'failed'].includes(job.status) && !confirmedSent(job));
}

export function recoveryLookups(jobs: Job[]): ProviderLookup[] {
  return jobs.flatMap(job => job.reference && (canRecover(job) || (job.status === 'delivered' && !confirmedSent(job)))
    ? [{id:job.providerId ?? null, reference:job.reference, phone:job.phone}] : []);
}

export function recoveryPreview(jobs: Job[], statuses: ReadonlyMap<string, RecoveryStatus>) {
  const lastSent = lastSentIndex(jobs, statuses);
  const candidates = [];
  const review = [];
  let queuedCount = 0;
  for (const job of jobs.slice(lastSent + 1)) {
    if (job.status === 'queued') queuedCount++;
    if (!canRecover(job) || !job.reference) continue;
    const status = statuses.get(job.reference);
    const missingAfterHandoff = status === 'missing' && job.providerId && job.status === 'submitted' &&
      (!job.providerStatus || job.providerStatus === 'queued' || job.providerStatus === 'accepted');
    if (status === 'cleared' || missingAfterHandoff) candidates.push({job, reference:job.reference, missing:status === 'missing'});
    else review.push(job);
  }
  const queuedBefore = jobs.slice(0, lastSent + 1).filter(job => job.status === 'queued').length;
  return { lastSent:jobs[lastSent], candidates, review, queuedCount, queuedBefore };
}

export function lastSentIndex(jobs: Job[], statuses?: ReadonlyMap<string, RecoveryStatus>) {
  for (let index = jobs.length - 1; index >= 0; index--) {
    const job = jobs[index];
    if (confirmedSent(job) || sentStatus(statuses?.get(job.reference ?? ''))) return index;
  }
  return -1;
}

function sentStatus(value: RecoveryStatus | null | undefined) {
  return value === 'sent' || value === 'delivered';
}
