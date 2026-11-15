import { plainTextOf } from '../../lib/message-text.js';
import type { RouterItemContent } from './source-registry.js';

/** Triage sees evidence, not raw markup. Delivery and mail_read still read the original. */
export const ROUTER_BODY_PREVIEW_CHARS = 6000;

function clip(value: string, max: number): string {
  const cut = value.slice(0, max);
  // Never end with half an astral code point.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const label = (value: unknown, max = 200) => typeof value === 'string' ? clip(value, max) : undefined;
const strings = (value: unknown, count: number) => Array.isArray(value)
  ? value.filter((one): one is string => typeof one === 'string').slice(0, count).map((one) => clip(one, 512)) : undefined;

/** Optional cache headers are projected, never copied wholesale from a provider payload. */
function headerEvidence(raw: unknown) {
  const headers = object(raw);
  const list = object(headers.listUnsubscribe);
  const bulk = object(headers.bulkHeaders);
  return {
    ...(Object.keys(list).length ? { listUnsubscribe: {
      https: strings(list.https, 4), mailto: strings(list.mailto, 2),
      oneClick: list.oneClick === true, listId: label(list.listId),
    } } : {}),
    ...(Object.keys(bulk).length ? { bulkHeaders: {
      precedence: label(bulk.precedence), autoSubmitted: label(bulk.autoSubmitted),
    } } : {}),
  };
}

/** Bounded context for every source kind, without changing snapshot checks or stored content. */
export function routerContentPreview(content: RouterItemContent) {
  const text = content.bodyAvailable && content.body ? plainTextOf(content.body) : '';
  return {
    body: content.bodyAvailable && content.body ? { text: clip(text, ROUTER_BODY_PREVIEW_CHARS) } : null,
    bodyAvailable: content.bodyAvailable,
    bodyTruncated: content.bodyTruncated === true || text.length > ROUTER_BODY_PREVIEW_CHARS,
    ...(!content.bodyAvailable ? { bodyUnavailableReason: label(content.bodyUnavailableReason, 300) || 'The source body is not available in the cache.' } : {}),
    headers: headerEvidence(content.headers),
    attachments: content.attachments.slice(0, 20).map((one) => ({
      filename: label(one.filename, 200), mimeType: label(one.mimeType, 100),
      ...(typeof one.bytes === 'number' && Number.isFinite(one.bytes) ? { bytes: one.bytes } : {}),
    })),
    attachmentsTruncated: content.attachments.length > 20,
    attachmentsAvailable: content.attachmentsAvailable,
  };
}
