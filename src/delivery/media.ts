import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const MEDIA_LIFETIME = 86_400_000;
const IMAGE_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function mediaLinks(origin: string, secret: string) {
  const signature = (id: string, expires: string) => createHmac('sha256', secret)
    .update(`dinnerdance-media:${id}:${expires}`).digest('base64url');
  return {
    forImage(id: string, now = Date.now()) {
      const expires = String(now + MEDIA_LIFETIME);
      return new URL(`/delivery-media/${id}/${expires}/${signature(id, expires)}`, origin).href;
    },
    verify(id: string, expires: string, value: string, now = Date.now()) {
      const until = Number(expires);
      return IMAGE_ID.test(id) && /^\d{1,16}$/.test(expires) && Number.isSafeInteger(until) &&
        until > now && until - now <= MEDIA_LIFETIME && safeEqual(value, signature(id, expires));
    },
  };
}

export function safeEqual(first: string, second: string) {
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(first), hash(second));
}
