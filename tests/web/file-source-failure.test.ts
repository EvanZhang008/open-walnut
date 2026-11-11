/**
 * A path whose source machine is unknown (FileViewer `sourceFailure`): the viewer reads nothing,
 * keeps its "No file was read" error, and offers this machine and every known host as explicit
 * choices. Only a press on one named machine looks there, and only there (`sourceOnly`). That an
 * older server answering with another host is still refused is pinned in agent-text-source.test.ts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { act, createElement } from '../../web/node_modules/react/index.js';
import { createRoot, type Root } from '../../web/node_modules/react-dom/client.js';

const h = vi.hoisted(() => ({ locate: vi.fn(), explorer: vi.fn(), hosts: [] as Array<{ host: string; label: string }> }));
vi.mock('@/hooks/useHostDisplayLabel', () => ({ useHostDisplayLabel: () => '' }));
vi.mock('@/hooks/useHostStatus', () => ({ useAllHostStatus: () => h.hosts }));
vi.mock('@/utils/host-display-label', () => ({
  remoteHostTag: (host: string) => host,
  hostDisplayLabel: (alias: string, label?: string) => (!alias || alias === '__local__' ? 'Local' : label || alias),
}));
vi.mock('@/hooks/useClickedPathOpener', () => ({ locateClickedPath: h.locate, missingPathLine: () => 'Not found' }));
vi.mock('../../web/src/components/sessions/SessionFileExplorer', () => ({ SessionFileExplorer: (props: unknown) => { h.explorer(props); return null; } }));

const { FileViewer } = await import('../../web/src/components/common/FileViewer');

const NOTE_FILE = '/srv/notes.txt';
const FAILURE = "Couldn't open the path: Walnut did not record which session wrote these words. No file was read.";
const LOOKUP_FAILURE = "Couldn't open the path: its source session could not be read just now. No file was read. Close this preview and click the path again to retry.";
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
  close.mockReset();
  h.hosts = [{ host: 'devbox', label: 'Dev box' }, { host: 'gpu', label: 'GPU box' }];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const hostButton = (alias: string) => document.querySelector<HTMLButtonElement>(`[data-testid="file-source-host"][data-host="${alias}"]`);
const press = async (el: Element | null) => {
  expect(el, 'the button is drawn').not.toBeNull();
  await act(async () => { (el as HTMLButtonElement).dispatchEvent(new window.Event('click', { bubbles: true })); });
};
const render = async (props: Record<string, unknown>) => {
  await act(async () => { root.render(createElement(FileViewer, { path: NOTE_FILE, onClose: close, ...props } as never)); });
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('a path whose source machine is unknown', () => {
  it('shows the error and the machine choices without locating or reading files; a recovered source removes both', async () => {
    h.locate.mockResolvedValue({ path: NOTE_FILE, host: 'devbox', elsewhere: false });
    await render({ sourceFailure: FAILURE });
    expect(q('file-viewer-source-error')?.textContent).toContain('No file was read');
    expect(q('file-source-choice')?.textContent).toContain('Choose a machine');
    expect(q('file-source-local')?.textContent).toBe('Local');
    expect(hostButton('devbox')?.textContent).toBe('Dev box');
    expect(hostButton('gpu')?.textContent).toBe('GPU box');
    expect(document.querySelectorAll('[data-testid="file-source-choice"] select')).toHaveLength(0);
    expect(h.locate).not.toHaveBeenCalled();
    expect(h.explorer).not.toHaveBeenCalled();
    const escape = new window.Event('keydown');
    Object.assign(escape, { key: 'Escape' });
    window.dispatchEvent(escape);
    expect(close).toHaveBeenCalledOnce();

    await render({ host: 'devbox', sourceOnly: true });
    expect(q('file-viewer-source-error')).toBeNull();
    expect(q('file-source-choice')).toBeNull();
    expect(h.locate).toHaveBeenCalledExactlyOnceWith(NOTE_FILE, { host: 'devbox', sourceOnly: true }, NO_POS);
    expect(h.explorer).toHaveBeenCalled();
  });

  it('Local looks on this machine only; a named host looks on that host only', async () => {
    h.locate.mockResolvedValueOnce({ path: NOTE_FILE, elsewhere: false });
    await render({ sourceFailure: FAILURE, line: 4 });
    await press(q('file-source-local'));
    expect(h.locate).toHaveBeenCalledExactlyOnceWith(NOTE_FILE, { host: '__local__', sourceOnly: true }, { line: 4, endLine: undefined });
    expect(q('file-viewer-source-error')).toBeNull();
    expect(h.explorer).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: NOTE_FILE, host: undefined }));

    await act(async () => { root.unmount(); });
    root = createRoot(container);
    h.locate.mockReset().mockResolvedValueOnce({ path: NOTE_FILE, host: 'gpu', elsewhere: false });
    h.explorer.mockReset();
    await render({ sourceFailure: FAILURE });
    expect(h.locate).not.toHaveBeenCalled();
    await press(hostButton('gpu'));
    expect(h.locate).toHaveBeenCalledExactlyOnceWith(NOTE_FILE, { host: 'gpu', sourceOnly: true }, NO_POS);
    expect(h.explorer).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: NOTE_FILE, host: 'gpu' }));
  });

  it('a failed session read (a lookup that may recover) offers the same choices and confirms no writer', async () => {
    h.locate.mockResolvedValueOnce({ path: NOTE_FILE, host: 'devbox', elsewhere: false });
    await render({ sourceFailure: LOOKUP_FAILURE });
    expect(q('file-viewer-source-error')?.textContent).toContain('No file was read');
    expect(q('file-source-local')).not.toBeNull();
    expect(document.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    expect(h.locate).not.toHaveBeenCalled();
    await press(hostButton('devbox'));
    expect(h.locate).toHaveBeenCalledExactlyOnceWith(NOTE_FILE, { host: 'devbox', sourceOnly: true }, NO_POS);
  });

  it('a chosen machine without the file says so and keeps the choices, so another machine can be named', async () => {
    h.locate.mockResolvedValueOnce({ path: NOTE_FILE, elsewhere: false, missing: { checked: ['Local'] } });
    await render({ sourceFailure: FAILURE });
    await press(q('file-source-local'));
    expect(q('file-viewer-missing')?.textContent).toBe('Not found');
    expect(q('file-source-local')?.getAttribute('aria-pressed')).toBe('true');
    expect(h.explorer).not.toHaveBeenCalled();
    h.locate.mockResolvedValueOnce({ path: NOTE_FILE, host: 'devbox', elsewhere: false });
    await press(hostButton('devbox'));
    expect(h.locate).toHaveBeenLastCalledWith(NOTE_FILE, { host: 'devbox', sourceOnly: true }, NO_POS);
    expect(h.locate).toHaveBeenCalledTimes(2);
    expect(h.explorer).toHaveBeenLastCalledWith(expect.objectContaining({ host: 'devbox' }));
  });

  it('the next path clears the choice and a lookup still in flight opens nothing late', async () => {
    const late = deferred<unknown>();
    h.locate.mockReturnValueOnce(late.promise);
    await render({ sourceFailure: FAILURE });
    await press(hostButton('devbox'));
    expect(h.locate).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Looking for');

    await render({ path: '/srv/other.txt', sourceFailure: FAILURE });
    expect(q('file-viewer-source-error')?.textContent).toContain('No file was read');
    expect(document.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    await act(async () => { late.resolve({ path: NOTE_FILE, host: 'devbox', elsewhere: false }); await late.promise; });
    expect(h.explorer).not.toHaveBeenCalled();
    expect(q('file-viewer-source-error')).not.toBeNull();
    expect(h.locate).toHaveBeenCalledOnce();

    // Back to the first path: its earlier choice does not come back.
    await render({ sourceFailure: FAILURE });
    expect(q('file-viewer-source-error')).not.toBeNull();
    expect(h.locate).toHaveBeenCalledOnce();
  });

  it('a new failure on the same path clears the choice; closing with a lookup in flight opens nothing', async () => {
    h.locate.mockResolvedValueOnce({ path: NOTE_FILE, elsewhere: false });
    await render({ sourceFailure: FAILURE });
    await press(q('file-source-local'));
    expect(h.explorer).toHaveBeenCalled();
    h.explorer.mockReset();
    await render({ sourceFailure: LOOKUP_FAILURE });
    expect(q('file-viewer-source-error')?.textContent).toContain('could not be read just now');
    expect(h.explorer).not.toHaveBeenCalled();

    const late = deferred<unknown>();
    h.locate.mockReturnValueOnce(late.promise);
    await press(hostButton('gpu'));
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => { late.resolve({ path: NOTE_FILE, host: 'gpu', elsewhere: false }); await late.promise; });
    expect(h.explorer).not.toHaveBeenCalled();
    expect(document.querySelector('.file-viewer-overlay')).toBeNull();
  });

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

  it('a host entry naming this machine, or one listed twice, adds no second Local button', async () => {
    h.hosts = [{ host: 'local', label: 'Local' }, { host: '__local__', label: 'This Mac' }, { host: '', label: '' }, { host: 'devbox', label: 'Dev box' }, { host: 'devbox', label: 'Dev box' }];
    await render({ sourceFailure: FAILURE });
    expect(document.querySelectorAll('[data-testid="file-source-local"]')).toHaveLength(1);
    const remotes = [...document.querySelectorAll('[data-testid="file-source-host"]')].map((b) => b.getAttribute('data-host'));
    expect(remotes).toEqual(['devbox']);
    expect([...document.querySelectorAll('[data-testid="file-source-choice"] button')].filter((b) => b.textContent === 'Local')).toHaveLength(1);
  });

  it('no known hosts still offers this machine', async () => {
    h.hosts = [];
    await render({ sourceFailure: FAILURE });
    expect(q('file-source-local')).not.toBeNull();
    expect(document.querySelectorAll('[data-testid="file-source-host"]')).toHaveLength(0);
    expect(h.locate).not.toHaveBeenCalled();
  });
});

describe('a source that asks for a machine reads as a question, and a lookup that failed offers a retry', () => {
  const stubStorage = () => {
    const store = new Map<string, string>();
    Object.assign(window, {
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      },
    });
    return store;
  };
  afterEach(() => { Reflect.deleteProperty(window, 'sessionStorage'); });

  it('an unrecorded, task-less or gone writer is a status line with the choices, never an alert or a retry', async () => {
    for (const sourceReason of ['unrecorded', 'no-session', 'gone'] as const) {
      await render({ sourceFailure: FAILURE, sourceReason, onRetry: vi.fn() });
      expect(q('file-viewer-source-error')?.getAttribute('role'), sourceReason).toBe('status');
      expect(q('file-viewer-source-retry'), sourceReason).toBeNull();
      expect(q('file-source-local')).not.toBeNull();
    }
  });

  it('a failed lookup is an alert with Try again, which runs the retry once', async () => {
    const onRetry = vi.fn();
    await render({ sourceFailure: LOOKUP_FAILURE, sourceReason: 'lookup', onRetry });
    expect(q('file-viewer-source-error')?.getAttribute('role')).toBe('alert');
    expect(q('file-source-local')).not.toBeNull();
    await press(q('file-viewer-source-retry'));
    expect(onRetry).toHaveBeenCalledOnce();
    await render({ sourceFailure: LOOKUP_FAILURE, sourceReason: 'lookup', onRetry: undefined });
    expect(q('file-viewer-source-retry')).toBeNull();
  });

  it('the machine a person named for a path is used when the same path asks again, says so, and can be undone', async () => {
    const store = stubStorage();
    h.locate.mockResolvedValue({ path: NOTE_FILE, elsewhere: false });
    await render({ sourceFailure: FAILURE, sourceReason: 'unrecorded' });
    expect(h.locate).not.toHaveBeenCalled();
    await press(q('file-source-local'));
    expect(h.locate).toHaveBeenCalledExactlyOnceWith(NOTE_FILE, { host: '__local__', sourceOnly: true }, NO_POS);
    expect(q('file-viewer-remembered'), 'a pick made in this viewer needs no banner').toBeNull();
    expect([...store.values()].join()).toContain(NOTE_FILE);

    await act(async () => { root.unmount(); });
    root = createRoot(container);
    h.locate.mockClear();
    await render({ sourceFailure: FAILURE, sourceReason: 'unrecorded' });
    expect(h.locate).toHaveBeenCalledExactlyOnceWith(NOTE_FILE, { host: '__local__', sourceOnly: true }, NO_POS);
    expect(q('file-viewer-source-error')).toBeNull();
    expect(q('file-viewer-remembered')?.textContent).toContain('the machine you chose for this path before');

    await press(q('file-viewer-choose-another'));
    expect(q('file-viewer-remembered')).toBeNull();
    expect(q('file-viewer-source-error')).not.toBeNull();
    expect(q('file-source-local')).not.toBeNull();
    expect(store.size === 0 || ![...store.values()].join().includes(NOTE_FILE)).toBe(true);
  });

  it('another path, and a lookup that failed this time, never use a remembered machine', async () => {
    const store = stubStorage();
    h.locate.mockResolvedValue({ path: NOTE_FILE, elsewhere: false });
    await render({ sourceFailure: FAILURE, sourceReason: 'unrecorded' });
    await press(q('file-source-local'));
    expect(store.size).toBe(1);
    h.locate.mockClear();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render({ path: '/srv/other.txt', sourceFailure: FAILURE, sourceReason: 'unrecorded' });
    expect(h.locate).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render({ sourceFailure: LOOKUP_FAILURE, sourceReason: 'lookup' });
    expect(h.locate).not.toHaveBeenCalled();
    expect(q('file-viewer-source-error')).not.toBeNull();
  });
});
