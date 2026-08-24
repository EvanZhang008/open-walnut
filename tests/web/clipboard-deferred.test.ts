/**
 * copyTextDeferred — the "copy text that is only known after a network call" path.
 *
 * The incident this pins: the notes tree's "Copy path" awaited
 * `/api/notes-v2/reveal` and THEN called navigator.clipboard.writeText. Safari and
 * the Mac app's WKWebView void the click's user-activation while that request is
 * in flight, so the write was rejected and every use showed "Copy failed".
 *
 * Two invariants, both asserted here:
 *  1. In the Mac app (native bridge present) the bridge is used, not the web
 *     clipboard — it writes NSPasteboard directly, so no gesture is needed.
 *  2. Without the bridge, `navigator.clipboard.write` is handed the PROMISE
 *     synchronously (before the text resolves). Any future refactor that awaits
 *     the text first reintroduces the bug and fails this test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { copyTextDeferred, copyTextRobust } from '@/utils/clipboard';

type Stub = { restore: () => void };

function stubGlobal(name: string, value: unknown): Stub {
  const had = name in globalThis;
  const prev = (globalThis as Record<string, unknown>)[name];
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return {
    restore: () => {
      if (had) Object.defineProperty(globalThis, name, { value: prev, configurable: true, writable: true });
      else delete (globalThis as Record<string, unknown>)[name];
    },
  };
}

describe('copyTextDeferred', () => {
  let stubs: Stub[] = [];

  const install = (opts: { bridge?: (t: string) => void; write?: () => Promise<void> }) => {
    stubs.push(stubGlobal('window', opts.bridge
      ? { webkit: { messageHandlers: { walnutClipboard: { postMessage: opts.bridge } } } }
      : {}));
    stubs.push(stubGlobal('navigator', {
      clipboard: {
        write: opts.write ?? vi.fn(() => Promise.resolve()),
        writeText: vi.fn(() => Promise.resolve()),
      },
    }));
    stubs.push(stubGlobal('ClipboardItem', class {
      items: Record<string, unknown>;
      constructor(items: Record<string, unknown>) { this.items = items; }
    }));
  };

  beforeEach(() => { stubs = []; });
  afterEach(() => { for (const s of stubs.reverse()) s.restore(); });

  it('uses the desktop bridge and never touches the web clipboard', async () => {
    const posted: string[] = [];
    install({ bridge: (t) => posted.push(t) });
    const write = (globalThis as unknown as { navigator: { clipboard: { write: ReturnType<typeof vi.fn> } } })
      .navigator.clipboard.write;

    const result = await copyTextDeferred(Promise.resolve('/abs/path/Note.md'));

    expect(result).toBe('clipboard');
    expect(posted).toEqual(['/abs/path/Note.md']);
    expect(write).not.toHaveBeenCalled();
  });

  it('hands the clipboard the promise synchronously — no await before the write', async () => {
    install({});
    const nav = (globalThis as unknown as { navigator: { clipboard: { write: ReturnType<typeof vi.fn> } } }).navigator;

    // A text promise that never settles: the write must already have happened.
    const pending = new Promise<string>(() => {});
    void copyTextDeferred(pending);
    await Promise.resolve(); // one microtask — nowhere near enough to resolve `pending`

    expect(nav.clipboard.write).toHaveBeenCalledTimes(1);
  });

  it('rejects when the text itself cannot be resolved, so the caller can report it', async () => {
    install({ bridge: () => {} });
    await expect(copyTextDeferred(Promise.reject(new Error('404')))).rejects.toThrow('404');
  });

  it('copyTextRobust prefers the bridge over writeText', async () => {
    const posted: string[] = [];
    install({ bridge: (t) => posted.push(t) });
    const nav = (globalThis as unknown as { navigator: { clipboard: { writeText: ReturnType<typeof vi.fn> } } }).navigator;

    expect(await copyTextRobust('hello')).toBe('clipboard');
    expect(posted).toEqual(['hello']);
    expect(nav.clipboard.writeText).not.toHaveBeenCalled();
  });
});
