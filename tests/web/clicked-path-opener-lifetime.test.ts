import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { act, createElement } from '../../web/node_modules/react/index.js';
import { createRoot, type Root } from '../../web/node_modules/react-dom/client.js';

const h = vi.hoisted(() => ({ locate: vi.fn() }));
vi.mock('@/api/files', () => ({ locatePath: h.locate }));
vi.mock('@/utils/log', () => ({ log: { info: vi.fn() } }));
import { useClickedPathOpener, type ClickedPathContext, type ClickedPathTarget } from '../../web/src/hooks/useClickedPathOpener';

let open: ReturnType<typeof useClickedPathOpener>;
function Probe({ ctx, sink }: { ctx: ClickedPathContext; sink: (target: ClickedPathTarget) => void }) {
  open = useClickedPathOpener(sink, ctx);
  return null;
}
function deferred() {
  let resolve!: (target: { path: string; host?: string; found: boolean }) => void;
  const promise = new Promise<{ path: string; host?: string; found: boolean }>((done) => { resolve = done; });
  return { promise, resolve };
}
let root: Root;
let container: HTMLElement;
beforeAll(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
});
beforeEach(() => {
  h.locate.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});
const render = async (ctx: ClickedPathContext, sink: (target: ClickedPathTarget) => void) => {
  await act(async () => { root.render(createElement(Probe, { ctx, sink })); });
};

describe('a clicked path lookup belongs to its mounted source', () => {
  it.each([
    { host: 'other' }, { cwd: '/other' }, { sessionId: 'other' }, { sourceOnly: false },
  ])('drops a late answer after the source changes and changes back: %j', async (change) => {
    const late = deferred();
    h.locate.mockReturnValue(late.promise);
    const sink = vi.fn();
    const ctx = { host: 'devbox', cwd: '/repo', sessionId: 'writer', sourceOnly: true };
    await render(ctx, sink);
    open('/repo/a.ts', 4);
    await render({ ...ctx, ...change }, sink);
    await render(ctx, sink);
    await act(async () => { late.resolve({ path: '/repo/a.ts', host: 'devbox', found: true }); await late.promise; });
    expect(sink).not.toHaveBeenCalled();
  });

  it('drops an answer after unmount and accepts only the newest click', async () => {
    const first = deferred(), second = deferred();
    h.locate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const sink = vi.fn();
    await render({ host: 'devbox', sourceOnly: true }, sink);
    open('/repo/a.ts');
    open('/repo/b.ts');
    await act(async () => { second.resolve({ path: '/repo/b.ts', host: 'devbox', found: true }); await second.promise; });
    expect(sink).toHaveBeenCalledExactlyOnceWith({ path: '/repo/b.ts', host: 'devbox', elsewhere: false });
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => { first.resolve({ path: '/repo/a.ts', host: 'devbox', found: true }); await first.promise; });
    expect(sink).toHaveBeenCalledOnce();
  });

  it('keeps a lookup when only its sink callback changes', async () => {
    const late = deferred();
    h.locate.mockReturnValue(late.promise);
    const old = vi.fn(), latest = vi.fn();
    await render({ host: 'devbox' }, old);
    open('/repo/a.ts', 4);
    await render({ host: 'devbox' }, latest);
    await act(async () => { late.resolve({ path: '/repo/a.ts', host: 'devbox', found: true }); await late.promise; });
    expect(old).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledExactlyOnceWith({ path: '/repo/a.ts', host: 'devbox', elsewhere: false, line: 4 });
  });
});
