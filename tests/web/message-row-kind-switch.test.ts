/**
 * A chat or session message row can change kind while it stays mounted, and must
 * not crash when it does.
 *
 * ChatMessage returned its special rows (the heartbeat line, the compaction
 * divider, the interrupt marker) below some hooks and above the rest, so a row
 * that switched between a bubble and a special row ran a different number of
 * hooks and React threw ("Rendered fewer hooks than expected"), taking the whole
 * tree down. SessionMessage had the same shape with no hook above its returns. A live row does switch:
 * agent:response retro-tags a streamed reply as a heartbeat, and a list keyed by
 * position hands a row another message when earlier history loads. Found with
 * the hook-order ratchet (tests/web/hook-order-ratchet.test.ts) after the fork
 * r6 gate's pop-out crash (MED-1, the same mistake in App). Mounted for real
 * here: react-dom over a linkedom document, as tests/web/use-integrations-cache.test.ts.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement, act, type ReactElement } from '../../web/node_modules/react/index.js';
import { createRoot, type Root } from '../../web/node_modules/react-dom/client.js';

let doc: Document;
let ChatMessage: typeof import('../../web/src/components/chat/ChatMessage').ChatMessage;
let SessionMessage: typeof import('../../web/src/components/sessions/SessionMessage').SessionMessage;
let MemoryRouter: typeof import('../../web/node_modules/react-router-dom').MemoryRouter;
const errors: unknown[] = [];
let root: Root | null = null;
let host: Element | null = null;

beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>');
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  doc = dom.document as unknown as Document;
  // After the document exists: the markdown sanitizer binds to it at import.
  ({ ChatMessage } = await import('../../web/src/components/chat/ChatMessage'));
  ({ SessionMessage } = await import('../../web/src/components/sessions/SessionMessage'));
  // The same router module the components import (attention-banner-session.test.ts does the same).
  ({ MemoryRouter } = await import('../../web/node_modules/react-router-dom'));
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
  errors.length = 0;
});

/** Render each element in turn into ONE root (the same mounted row), and return the html after each. */
async function renderInTurn(elements: ReactElement[]): Promise<string[]> {
  host = doc.createElement('div');
  doc.body.appendChild(host);
  root = createRoot(host, { onUncaughtError: (error: unknown) => { errors.push(error); } });
  const out: string[] = [];
  for (const element of elements) {
    await act(async () => { root!.render(createElement(MemoryRouter, null, element)); });
    out.push(host!.innerHTML);
  }
  return out;
}

const T = '2026-10-12T09:30:00.000Z';

describe('a mounted message row that changes kind', () => {
  it('ChatMessage: a reply retro-tagged as a heartbeat, and back', async () => {
    const reply = { role: 'assistant' as const, content: 'All systems normal.', timestamp: T };
    const html = await renderInTurn([
      createElement(ChatMessage, reply),
      createElement(ChatMessage, { ...reply, source: 'heartbeat', notification: true }),
      createElement(ChatMessage, reply),
    ]);
    expect(errors).toEqual([]);
    expect(html[0]).toContain('chat-message');
    expect(html[1]).toContain('chat-heartbeat-line');
    expect(html[1]).not.toContain('chat-message-assistant');
    expect(html[2]).toContain('chat-message');
  });

  it('ChatMessage: a compaction placeholder that becomes its divider, then a bubble', async () => {
    const html = await renderInTurn([
      createElement(ChatMessage, { role: 'assistant', content: '', timestamp: T, source: 'compacting' }),
      createElement(ChatMessage, { role: 'assistant', content: 'Context compacted\nDetails', timestamp: T, source: 'compaction' }),
      createElement(ChatMessage, { role: 'user', content: 'Thanks', timestamp: T }),
      createElement(ChatMessage, { role: 'user', content: '[Request interrupted by user]', timestamp: T }),
    ]);
    expect(errors).toEqual([]);
    expect(html[0]).toContain('Compacting conversation history');
    expect(html[1]).toContain('chat-compaction-divider');
    expect(html[2]).toContain('chat-message');
    expect(html[3]).toContain('chat-interrupt-banner');
  });

  // Before the split this one did not crash: SessionMessage's special rows ran no hook at all, and
  // React re-mounts the hooks of a row whose last render had none. It pins that the split keeps it so.
  it('SessionMessage: a row handed a system line, an interrupt and a reply in turn', async () => {
    const html = await renderInTurn([
      createElement(SessionMessage, { message: { role: 'assistant', text: 'Here is the plan.', timestamp: T } }),
      createElement(SessionMessage, { message: { role: 'system', text: 'Context compacted', timestamp: T, systemVariant: 'compact' } }),
      createElement(SessionMessage, { message: { role: 'user', text: '[Request interrupted by user]', timestamp: T } }),
      createElement(SessionMessage, { message: { role: 'assistant', text: 'Back to the plan.', timestamp: T } }),
    ]);
    expect(errors).toEqual([]);
    expect(html[0]).toContain('Here is the plan.');
    expect(html[1]).toContain('Context compacted');
    expect(html[2]).toContain('chat-interrupt-banner');
    expect(html[3]).toContain('Back to the plan.');
  });
});
