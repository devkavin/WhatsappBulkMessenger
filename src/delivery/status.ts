import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import type { WassengerStatus } from './policy.ts';
import type { Job, ProviderStatusSource } from './worker.ts';

const deliveryLabels = {
  queued: 'Queued', submitting: 'Submitting', submitted: 'Submitted', delivered: 'Delivered', failed: 'Failed',
  review: 'Needs review', cancelled: 'Cancelled', removed: 'Removed',
};

export const wassengerLabels: Record<WassengerStatus, string> = {
  accepted: 'Accepted', queued: 'Queued', sent: 'Sent', delivered: 'Delivered', failed: 'Failed',
};

const sourceLabels: Record<ProviderStatusSource, string> = {
  submission: 'Submission response', lookup: 'API check', webhook: 'Webhook',
};

export const deliveryView = {
  deliveryLabels, wassengerLabels,
  displayTime: new Intl.DateTimeFormat('en-LK', { timeZone:'Asia/Colombo', dateStyle:'medium', timeStyle:'short' }),
  deliveryClock: new Intl.DateTimeFormat('en-US', { timeZone:'Asia/Colombo', hour:'numeric', minute:'2-digit' }),
  deliveryDate: new Intl.DateTimeFormat('en-US', { timeZone:'Asia/Colombo', month:'short', day:'numeric' }),
  maskDeliveryPhone(phone: string) {
    const countryCode = parsePhoneNumberFromString(phone)?.countryCallingCode;
    return `${countryCode ? `+${countryCode} ` : ''}•• ••• ${phone.slice(-4)}`;
  },
};

export function deliveryDisplay(job?: Job) {
  if (job?.mode !== 'live') return { appStatus: job?.status, provider: null };

  const providerFailure = job.status === 'failed' && job.note?.startsWith('Wassenger reported a delivery failure');
  const historicalStatus = job.status === 'delivered' ? 'delivered' : providerFailure ? 'failed' :
    job.status === 'submitted' ? 'accepted' : null;
  const status = job.status === 'delivered' || providerFailure ? historicalStatus : job.providerStatus ?? historicalStatus;
  const source = job.providerStatus === status && job.providerSource ? sourceLabels[job.providerSource] : null;
  const appStatus = job.status === 'delivered' || providerFailure ? 'submitted' : job.status;
  return { appStatus, provider: { status, source, webhookEvent: job.webhookEvent, webhookReceivedAt: job.webhookReceivedAt } };
}
