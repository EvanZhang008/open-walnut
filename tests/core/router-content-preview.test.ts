import { describe, expect, it } from 'vitest';
import { ROUTER_BODY_PREVIEW_CHARS, routerContentPreview } from '../../src/core/router/content-preview.js';
import { ROUTER_SOURCE_KINDS } from '../../src/core/router/types.js';
import type { RouterItemContent } from '../../src/core/router/source-registry.js';
import { largeRouterMails } from '../fixtures/mail/large-router-mails.js';

const content = (over: Partial<RouterItemContent> = {}): RouterItemContent => ({
  item: { source: { kind: 'mail', account: 'fixture', message: '1' }, key: '1', sender: 'sender@example.invalid', subject: 'Fixture' },
  body: { text: 'Readable' }, bodyAvailable: true, attachments: [], attachmentsAvailable: false,
  ...over,
});

describe('bounded router evidence, with the original retained', () => {
  it.each(largeRouterMails)('keeps the meaningful text and headers of $name, not raw HTML', (mail) => {
    const original = content({ body: mail, headers: mail.payload });
    const before = JSON.stringify(original);
    const preview = routerContentPreview(original);
    expect(preview.body?.text).toBe(mail.text.slice(0, ROUTER_BODY_PREVIEW_CHARS));
    expect(preview.body).not.toHaveProperty('html');
    expect(JSON.stringify(preview)).not.toContain('.layout');
    expect(preview.headers.bulkHeaders?.precedence).toBe('bulk');
    expect(JSON.stringify(original)).toBe(before);
    expect(JSON.stringify(preview).length).toBeLessThan(8000);
  });

  // Enumerate the registry, so a newly supported source cannot quietly return an unlimited body.
  it.each(ROUTER_SOURCE_KINDS)('bounds %s text at below, exactly and above the limit', (kind) => {
    for (const size of [0, ROUTER_BODY_PREVIEW_CHARS - 1, ROUTER_BODY_PREVIEW_CHARS, ROUTER_BODY_PREVIEW_CHARS + 1, 200_000]) {
      const original = content({ body: { text: 'x'.repeat(size) } });
      original.item.source.kind = kind;
      const preview = routerContentPreview(original);
      expect(preview.body?.text.length).toBe(Math.min(size, ROUTER_BODY_PREVIEW_CHARS));
      expect(preview.bodyTruncated).toBe(size > ROUTER_BODY_PREVIEW_CHARS);
    }
  });

  it('converts HTML-only mail after stripping a long stylesheet, scripts and head', () => {
    const html = `<head><style>${'css '.repeat(30_000)}</style></head><script>NOT_EVIDENCE</script><h1>Register &amp; attend</h1><p>${'Promotion '.repeat(1000)}</p>`;
    const preview = routerContentPreview(content({ body: { text: '  ', html } }));
    expect(preview.body?.text).toMatch(/^Register & attend\nPromotion/);
    expect(preview.body?.text.length).toBeLessThanOrEqual(ROUTER_BODY_PREVIEW_CHARS);
    expect(preview.bodyTruncated).toBe(true);
    expect(JSON.stringify(preview)).not.toMatch(/NOT_EVIDENCE|css|<head>|<p>/);
  });

  it('cuts Unicode without leaving an unpaired surrogate', () => {
    const preview = routerContentPreview(content({ body: { text: 'a'.repeat(5999) + '\u{1F600}\u4E2D' } }));
    expect(preview.body?.text).toBe('a'.repeat(5999));
    expect(preview.bodyTruncated).toBe(true);
  });

  it('distinguishes an empty available body, a missing body and an ingest-truncated body', () => {
    expect(routerContentPreview(content({ body: { text: '' } }))).toMatchObject({ body: { text: '' }, bodyAvailable: true, bodyTruncated: false });
    expect(routerContentPreview(content({ body: null, bodyAvailable: false, bodyUnavailableReason: 'too-large' })))
      .toMatchObject({ body: null, bodyAvailable: false, bodyUnavailableReason: 'too-large' });
    expect(routerContentPreview(content({ bodyTruncated: true }))).toMatchObject({ bodyTruncated: true });
  });

  it('projects and bounds all outside metadata instead of copying arbitrary payloads', () => {
    const preview = routerContentPreview(content({
      headers: { listUnsubscribe: { https: Array(40).fill('https://example.invalid/' + 'x'.repeat(3000)), oneClick: true, listId: 'x'.repeat(400) }, bulkHeaders: { precedence: 'bulk', autoSubmitted: 'auto-generated', unknown: 'NOT_EVIDENCE' } } as RouterItemContent['headers'],
      attachments: Array(200).fill({ filename: 'x'.repeat(9000), mimeType: 'x'.repeat(500) }),
    }));
    expect(preview.headers.listUnsubscribe?.https).toHaveLength(4);
    expect(preview.headers.listUnsubscribe?.https?.[0]).toHaveLength(512);
    expect(preview.headers.listUnsubscribe?.listId).toHaveLength(200);
    expect(preview.attachments).toHaveLength(20);
    expect(preview.attachments[0].filename).toHaveLength(200);
    expect(preview.attachmentsTruncated).toBe(true);
    expect(JSON.stringify(preview)).not.toContain('NOT_EVIDENCE');
  });
});
