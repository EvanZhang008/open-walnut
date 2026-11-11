import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { act, createElement, StrictMode } from '../../web/node_modules/react/index.js';
import { createRoot, type Root } from '../../web/node_modules/react-dom/client.js';

const { MemoryRouter } = await import('../../web/node_modules/react-router-dom');
vi.mock('../../web/src/utils/open-anywhere', () => ({ openFileAnywhere: vi.fn(), openLetterAnywhere: vi.fn() }));
const { OpenAgentRefPage, OPEN_REF_PATIENCE_MS } = await import('../../web/src/pages/OpenAgentRefPage');
const { AGENT_REF_CHANNEL, claimAgentRef, registerAgentRef } = await import('../../web/src/utils/agent-ref-open');

const token = 'ab'.repeat(16);
const href = `http://localhost:3457/open-ref#token=${token}&kind=letter&id=lt-abc1234-9f3k`;
const deliveries: Array<() => void> = [];
const channels = new Set<Channel>();
const posts: unknown[] = [];

class Channel {
  onmessage: ((event: { data: any }) => void) | null = null;
  closed = false;
  constructor(readonly name: string) { channels.add(this); }
  postMessage(data: unknown) {
    posts.push(data);
    for (const target of channels) {
      if (target === this || target.name !== this.name || target.closed) continue;
      deliveries.push(() => { if (!target.closed) target.onmessage?.({ data }); });
    }
  }
  close() { this.closed = true; channels.delete(this); }
}

let root: Root | undefined;
let unregister: (() => void) | undefined;
let close: ReturnType<typeof vi.fn>;
let replace: ReturnType<typeof vi.fn>;
beforeEach(() => {
  deliveries.length = 0;
  posts.length = 0;
  channels.clear();
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  close = vi.fn();
  replace = vi.fn();
  Object.assign(dom.window, {
    location: { href, origin: 'http://localhost:3457' },
    history: { state: {}, replaceState: replace },
    close,
  });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  unregister?.();
  unregister = undefined;
  vi.unstubAllGlobals();
});

async function mount(strict: boolean) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const page = createElement(MemoryRouter, null, createElement(OpenAgentRefPage));
  await act(async () => root!.render(strict ? createElement(StrictMode, null, page) : page));
  return host;
}
async function deliver() {
  await act(async () => {
    while (deliveries.length) deliveries.shift()!();
  });
}

describe('agent reference hand-off acknowledgement', () => {
  it.each([false, true])('a letter that unmounts its source reader still closes its popup, StrictMode=%s', async (strict) => {
    const open = vi.fn(() => { unregister?.(); });
    unregister = registerAgentRef(token, open);
    const reader = new Channel(AGENT_REF_CHANNEL);
    reader.onmessage = ({ data }) => {
      if (claimAgentRef(data.href)) reader.postMessage({ answer: data.ask });
    };
    const host = await mount(strict);
    await deliver();
    expect(open).toHaveBeenCalledExactlyOnceWith({ kind: 'letter', id: 'lt-abc1234-9f3k' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Opened in Walnut');
    expect(replace).toHaveBeenCalledWith({}, '', '/open-ref');
  });

  it('a plain HTTP context without randomUUID still sends and acknowledges the hand-off', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const open = vi.fn();
    unregister = registerAgentRef(token, open);
    const reader = new Channel(AGENT_REF_CHANNEL);
    reader.onmessage = ({ data }) => {
      if (claimAgentRef(data.href)) reader.postMessage({ answer: data.ask });
    };
    const host = await mount(true);
    await deliver();
    expect(open).toHaveBeenCalledExactlyOnceWith({ kind: 'letter', id: 'lt-abc1234-9f3k' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Opened in Walnut');
  });

  it('an unclaimed token leaves an explicit Open button and never closes', async () => {
    const host = await mount(true);
    await deliver();
    expect(host.textContent).toContain('Open in Walnut');
    expect(host.querySelector('button')?.textContent).toBe('Open');
    expect(close).not.toHaveBeenCalled();
  });

  it('an expired file token never offers a source-less open or probes a guessed machine', async () => {
    window.location.href = `http://localhost:3457/open-ref#token=${token}&kind=file&path=%2Frepo%2Fa.txt`;
    vi.useFakeTimers();
    try {
      const host = await mount(true);
      await deliver();
      // A normal hand-off ends inside a second: the window says only that it is opening, never a sentence that reads as a fault.
      expect(host.textContent).toContain('Opening in Walnut');
      expect(host.textContent).not.toContain('reopen it and click the path again');
      await act(async () => { vi.advanceTimersByTime(OPEN_REF_PATIENCE_MS + 10); });
      expect(host.textContent).toContain('reopen it and click the path again');
      expect(host.querySelector('button')).toBeNull();
      expect(close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an answer for another popup cannot claim this one', async () => {
    const host = await mount(true);
    const reader = new Channel(AGENT_REF_CHANNEL);
    reader.postMessage({ answer: 'unrelated-request' });
    await deliver();
    expect(close).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Open in Walnut');
    expect(posts).toContainEqual({ answer: 'unrelated-request' });
  });
});
