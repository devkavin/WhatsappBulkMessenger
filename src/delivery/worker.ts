import type { Invitation } from '../invitations/service.ts';
import { submissionGap } from './policy.ts';
import type { DeliveryReceipt, DeliveryStatus, WassengerStatus, WassengerWebhookEvent } from './policy.ts';
import type { DeliveryProvider, ProviderLookup, ProviderObservation, Submission } from './providers.ts';
import type { DeliverySettings } from './settings.ts';

export type ProviderStatusSource = 'submission' | 'lookup' | 'webhook';

export type Job = Invitation & {
  id: string; invitationId: string | null; runId: string | null; mode: DeliverySettings['mode'];
  status: DeliveryStatus | 'cancelled'; reference: string | null; note: string | null; retryable: number;
  updatedAt: Date;
  providerStatus?: WassengerStatus | null;
  providerId?: string | null;
  wasSent?: number;
  recoveryReference?: string | null;
  leaseUntil?: Date | null;
  providerSource?: ProviderStatusSource | null;
  webhookEvent?: WassengerWebhookEvent | null;
  webhookReceivedAt?: Date | null;
};
export type Claimed = Job & { reference: string; leaseUntil: Date };
export type TestRecipient = { id: string; name: string; phone: string };
export type DeliveryContext = Pick<DeliverySettings, 'mode' | 'binding'> & { device: string | null; approvedBody: string | null };
export type Dashboard = { state: 'waiting' | 'scheduled' | 'running' | 'paused' | 'settings-changed'; liveReady: boolean; jobs: Job[]; runId?: string | null };

export interface DeliveryRepository {
  dashboard(context: DeliveryContext, eventId?: number): Promise<Dashboard>;
  archivedJobs(eventId: number, mode: DeliverySettings['mode']): Promise<Job[]>;
  start(context: DeliveryContext, now: Date, eventId?: number): Promise<void>;
  pause(context: DeliveryContext, paused: boolean, eventId?: number): Promise<void>;
  endChangedBatch(context: DeliveryContext, now: Date, eventId?: number): Promise<void>;
  retry(context: DeliveryContext, id: string, now: Date): Promise<void>;
  startRecovery(context: DeliveryContext, eventId: number | undefined, runId: string, lastSentId: string | null, references: string[], now: Date): Promise<void>;
  testRecipients(): Promise<TestRecipient[]>;
  saveTestRecipient(name: string, phone: string): Promise<void>;
  removeTestRecipient(id: string, now: Date): Promise<void>;
  enqueueTest(context: DeliveryContext, key: string, selected: string[], invitation: Omit<Invitation, 'name' | 'phone'>, now: Date): Promise<void>;
  testHistory(): Promise<Job[]>;
  claim(context: DeliveryContext, now: Date, gap: number): Promise<Claimed | null>;
  authorize(context: DeliveryContext, job: Claimed, now: Date): Promise<boolean>;
  finish(job: Claimed, result: Submission, now: Date, gap: number): Promise<void>;
  receipts(device: string, receipts: DeliveryReceipt[], now: Date): Promise<boolean | void>;
  reserveCheck(context: DeliveryContext, now: Date): Promise<ProviderLookup | null>;
  reconcile(device: string, reference: string, observation: ProviderObservation, now: Date): Promise<void>;
  defer(now: Date): Promise<void>;
}

export class DeliveryInputError extends Error {}

export function deliveryContext(settings: DeliverySettings): DeliveryContext {
  return { mode: settings.mode, binding: settings.binding, device: settings.provider?.device ?? null, approvedBody: settings.provider?.template?.body ?? null };
}

export function deliveryWorker(
  repository: DeliveryRepository,
  settings: DeliverySettings,
  provider: DeliveryProvider,
  imageExists: (id: string) => Promise<boolean>,
  options = { now: () => new Date(), random: Math.random },
) {
  const context = deliveryContext(settings);
  return async function tick() {
    const gap = submissionGap(settings.perMinute, options.random());
    const job = await repository.claim(context, options.now(), gap);
    if (job) {
      let result: Submission;
      if (!(await imageExists(job.imageId))) result = { status: 'failed', note: 'The saved ticket image is unavailable.' };
      else {
        if (!(await repository.authorize(context, job, options.now()))) return;
        result = await provider.send(job, job.reference);
      }
      await repository.finish(job, result, options.now(), gap);
      return;
    }

    if (!provider.check || !context.device) return;
    const known = await repository.reserveCheck(context, options.now());
    if (!known) return;
    const result = await provider.check(known);
    if (result.backoff) await repository.defer(new Date(options.now().getTime() + result.backoff));
    if (result.observation) await repository.reconcile(context.device, known.reference, result.observation, options.now());
  };
}
