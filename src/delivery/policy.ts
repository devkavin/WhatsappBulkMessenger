export type DeliveryStatus = 'queued' | 'submitting' | 'submitted' | 'delivered' | 'failed' | 'review';
export type DeliveryReceipt = { ids: string[]; reference: string | null; status: 'delivered' | 'failed' };

export function submissionGap(perMinute: number, random: number) {
  return Math.ceil(60_000 / perMinute) + Math.floor(random * 1251);
}

export function retryDelay(header: string | null, now: number) {
  const ms = header && /^\d+$/.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - now : 0;
  return Number.isFinite(ms) ? Math.max(15_000, Math.min(ms, 365 * 86_400_000)) : 15_000;
}

export function receiptEvents(body: unknown, device: string): DeliveryReceipt[] {
  const receipts: DeliveryReceipt[] = [];
  for (const item of Array.isArray(body) ? body : [body]) {
    const event = record(item);
    const data = record(event.data);
    const sender = record(event.device).id ?? record(data.device).id ?? data.device;
    if (sender !== device) continue;
    const name = event.event;
    const status = name === 'message:out:failed' ? 'failed' :
      (name === 'message:out:ack' || name === 'message:out:new') && isDelivered(event.ack ?? data.ack ?? data.deliveryStatus) ? 'delivered' : null;
    if (!status) continue;
    const ids = [...new Set([event.entityId, data.id, data.wid].filter(isProviderId))];
    const value = data.reference ?? event.reference;
    const reference = typeof value === 'string' && /^dd-[\da-f-]{36}$/.test(value) ? value : null;
    if (ids.length || reference) receipts.push({ ids, reference, status });
  }
  return receipts;
}

export function isDelivered(ack: unknown) {
  return ack === 'delivered' || ack === 'received' || ack === 'read' || ack === 'played' || ack === 'viewed';
}

export function isProviderId(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,255}$/.test(value);
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
