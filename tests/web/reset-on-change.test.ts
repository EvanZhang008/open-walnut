/**
 * useResetOnChange (web/src/hooks/useResetOnChange.ts): "clear this when the session changes"
 * runs when the key changes under a mounted view, never at mount.
 *
 * Why (2026-11-25, task 9bceb9f2): written as `useEffect(() => { setX(new Map()) }, [sessionId])`
 * it ran at mount too, and each new empty copy drew the session panel (over a thousand hooks)
 * again while it opened.
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';

type ReactModule = typeof import('../../web/node_modules/react/index.js');
let React: ReactModule;
let root: { render(node: unknown): void; unmount(): void };
let host: HTMLElement;
let useResetOnChange: typeof import('../../web/src/hooks/useResetOnChange')['useResetOnChange'];
let resets: string[];
let draws: number;

function View({ sid }: { sid: string }) {
  draws++;
  const [held, setHeld] = React.useState<ReadonlyMap<string, number>>(() => new Map());
  useResetOnChange(sid, () => { resets.push(sid); setHeld(new Map()); });
  void held;
  return null;
}

beforeAll(() => {
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(async () => {
  React = await import('../../web/node_modules/react/index.js');
  const { createRoot } = await import('../../web/node_modules/react-dom/client.js');
  ({ useResetOnChange } = await import('../../web/src/hooks/useResetOnChange'));
  resets = [];
  draws = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host) as typeof root;
});

afterEach(async () => {
  await React.act(async () => { root.unmount(); });
  host.remove();
});

const render = (sid: string) => React.act(async () => { root.render(React.createElement(View, { sid })); });

describe('useResetOnChange', () => {
  it('never resets at mount: the view draws once', async () => {
    await render('sess-a');
    expect(resets).toEqual([]);
    expect(draws).toBe(1);
  });

  it('resets once for each new key, and not for the same key drawn again', async () => {
    await render('sess-a');
    await render('sess-a');
    expect(resets).toEqual([]);
    await render('sess-b');
    expect(resets).toEqual(['sess-b']);
    await render('sess-a');
    expect(resets).toEqual(['sess-b', 'sess-a']);
  });
});
