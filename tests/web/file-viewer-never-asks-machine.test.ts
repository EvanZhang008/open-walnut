/**
 * A path whose writer's machine is unknown (FileViewer `anywhere`): the viewer looks it up on every
 * machine at once, the task the words belong to first, and opens it from the one that has it. It never
 * asks the person to pick a machine (2026-11-23, Evan, on a Threads card whose writer Walnut had not
 * recorded: "Why walnut not auto pic the host it need me to pick bro", "or which task it is ... then
 * walnut will take care find it"). The static guard over every surface is in
 * tests/web/never-ask-which-machine.test.ts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { act, createElement } from '../../web/node_modules/react/index.js';
import { createRoot, type Root } from '../../web/node_modules/react-dom/client.js';

const h = vi.hoisted(() => ({ locate: vi.fn(), explorer: vi.fn(), missingLine: vi.fn((p: string, c: readonly string[], any?: boolean) => `Not found ${p} ${c.join('|')} ${any ? 'anywhere' : ''}`.trim()) }));
vi.mock('@/hooks/useHostDisplayLabel', () => ({ useHostDisplayLabel: () => '', useHostRoute: () => 'ssh' }));
vi.mock('@/utils/host-display-label', () => ({ remoteHostTag: (host: string) => host }));
vi.mock('@/hooks/useClickedPathOpener', () => ({ locateClickedPath: h.locate, missingPathLine: h.missingLine }));
vi.mock('../../web/src/components/sessions/SessionFileExplorer', () => ({ SessionFileExplorer: (props: unknown) => { h.explorer(props); return null; } }));

const { FileViewer } = await import('../../web/src/components/common/FileViewer');

const NOTE_FILE = '/srv/notes.txt';
const NO_POS = { line: undefined, endLine: undefined };

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><body></body></html>');
  Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
});

let container: HTMLElement;
let root: Root;
const close = vi.fn();

beforeEach(() => {
  h.locate.mockReset();
  h.explorer.mockReset();
  h.missingLine.mockClear();
  close.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const render = async (props: Record<string, unknown>) => {
  await act(async () => { root.render(createElement(FileViewer, { path: NOTE_FILE, onClose: close, ...props } as never)); });
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('a path whose writer machine is unknown is looked up everywhere, never asked', () => {
  it('asks every machine with the task hint, opens the file where it was found, and draws no machine buttons', async () => {
    h.locate.mockResolvedValue({ path: NOTE_FILE, host: 'devbox', elsewhere: true });
    await render({ anywhere: true, taskId: 'task-1', line: 4 });
    expect(h.locate).toHaveBeenCalledExactlyOnceWith(NOTE_FILE, { anywhere: true, taskId: 'task-1' }, { line: 4, endLine: undefined });
    expect(h.explorer).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: NOTE_FILE, host: 'devbox', onHostNote: { host: 'devbox', found: true } }));
    expect(document.querySelectorAll('.file-viewer-overlay button').length, 'only Copy Path and Close').toBe(2);
    expect(document.body.textContent).not.toMatch(/choose a machine|pick the machine/i);
  });

  it('no task hint still asks every machine; a host or sourceOnly given with it is a named machine, not unknown', async () => {
    h.locate.mockResolvedValue({ path: NOTE_FILE, elsewhere: false });
    await render({ anywhere: true });
    expect(h.locate).toHaveBeenLastCalledWith(NOTE_FILE, { anywhere: true }, NO_POS);
    await render({ anywhere: true, host: 'gpu' });
    expect(h.locate).toHaveBeenLastCalledWith(NOTE_FILE, { host: 'gpu', sourceOnly: undefined }, NO_POS);
    await render({ anywhere: true, sourceOnly: true });
    expect(h.locate).toHaveBeenLastCalledWith(NOTE_FILE, { host: undefined, sourceOnly: true }, NO_POS);
  });

  it('a path no machine has says so in one line, naming the machines asked, with no buttons to pick another', async () => {
    h.locate.mockResolvedValue({ path: NOTE_FILE, elsewhere: false, missing: { checked: ['Local', 'Dev box'] } });
    await render({ anywhere: true });
    expect(q('file-viewer-missing')?.textContent).toBe(`Not found ${NOTE_FILE} Local|Dev box anywhere`);
    expect(h.explorer).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.file-viewer-overlay button').length).toBe(2);
  });

  it('a machine that did not answer offers Try again, which asks every machine once more', async () => {
    h.locate.mockResolvedValueOnce({ path: NOTE_FILE, elsewhere: false, missing: { checked: ['Local'], unreachable: ['home-pc'] } })
    await render({ anywhere: true, hintSessions: ['w1', '__local__'] });
    expect(h.locate).toHaveBeenLastCalledWith(NOTE_FILE, { anywhere: true, hintSessions: ['w1', '__local__'] }, NO_POS);
    expect(h.missingLine).toHaveBeenLastCalledWith(NOTE_FILE, ['Local'], true, ['home-pc']);
    h.locate.mockResolvedValueOnce({ path: NOTE_FILE, host: 'home-pc', elsewhere: true });
    const again = q('file-viewer-try-again');
    expect(again?.textContent).toBe('Try again');
    await act(async () => { again!.dispatchEvent(new window.Event('click', { bubbles: true })); });
    expect(h.locate).toHaveBeenCalledTimes(2);
    expect(h.explorer).toHaveBeenLastCalledWith(expect.objectContaining({ host: 'home-pc' }));
    // Every machine answered "no": nothing to try again.
    h.locate.mockResolvedValueOnce({ path: '/srv/b.txt', elsewhere: false, missing: { checked: ['Local'] } });
    await render({ anywhere: true, path: '/srv/b.txt' });
    expect(q('file-viewer-try-again')).toBeNull();
  });

  it('a lookup still in flight when the path changes, or the viewer closes, opens nothing late', async () => {
    const late = deferred<unknown>();
    h.locate.mockReturnValueOnce(late.promise).mockReturnValueOnce(new Promise(() => {}));
    await render({ anywhere: true });
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Looking for');
    await render({ anywhere: true, path: '/srv/other.txt' });
    await act(async () => { late.resolve({ path: NOTE_FILE, host: 'devbox', elsewhere: true }); await late.promise; });
    expect(h.explorer).not.toHaveBeenCalled();

    const closing = deferred<unknown>();
    h.locate.mockReset().mockReturnValueOnce(closing.promise);
    await render({ anywhere: true, path: '/srv/third.txt' });
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => { closing.resolve({ path: '/srv/third.txt', elsewhere: false }); await closing.promise; });
    expect(h.explorer).not.toHaveBeenCalled();
    expect(document.querySelector('.file-viewer-overlay')).toBeNull();
  });
});

describe('a lookup that was replaced never draws', () => {
  it('a change of path, host or sourceOnly never draws the previous explorer, even once its answer is in', async () => {
    const answers = new Map<string, unknown>();
    h.locate.mockImplementation(async (p: string, ctx: { host?: string; sourceOnly?: boolean }) => answers.get(`${p}|${ctx.host ?? ''}|${!!ctx.sourceOnly}`) ?? new Promise(() => {}));
    answers.set(`${NOTE_FILE}|devbox|true`, { path: NOTE_FILE, host: 'devbox', elsewhere: false });
    await render({ host: 'devbox', sourceOnly: true });
    expect(h.explorer).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: NOTE_FILE, host: 'devbox' }));
    for (const next of [{ path: '/srv/other.txt', host: 'devbox', sourceOnly: true }, { host: 'gpu', sourceOnly: true }, { host: 'devbox' }]) {
      h.explorer.mockReset();
      // Every render before the new answer: the old explorer is gone at once, the look-up line shows.
      await render(next);
      expect(h.explorer, `no stale explorer for ${JSON.stringify(next)}`).not.toHaveBeenCalled();
      expect(document.querySelector('[role="status"]')?.textContent).toContain('Looking for');
      // Back to the first lookup again: it is asked anew, never shown from the earlier answer before that.
      h.explorer.mockReset();
      await render({ host: 'devbox', sourceOnly: true });
      expect(h.explorer).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: NOTE_FILE, host: 'devbox' }));
    }
  });

  it('an answer that lands after its lookup was replaced is never drawn', async () => {
    const first = deferred<unknown>();
    h.locate.mockReturnValueOnce(first.promise).mockReturnValueOnce(new Promise(() => {}));
    await render({ host: 'devbox', sourceOnly: true });
    await render({ host: 'gpu', sourceOnly: true });
    await act(async () => { first.resolve({ path: NOTE_FILE, host: 'devbox', elsewhere: false }); await first.promise; });
    expect(h.explorer).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Looking for');
  });

});
