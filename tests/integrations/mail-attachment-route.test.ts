/**
 * `GET /api/plugins/mail/messages/:a/:m/attachments/:id` through a REAL server (contract 1.14.0).
 *
 * Everything below the route is real: the plugin loader, a fixture provider declaring
 * `attachments: 'download'`, the worker-thread cache and ingest. What this file is for:
 *
 * - The headers, which are the whole safety story of serving bytes a stranger wrote: a PDF inline in
 *   a sandbox, html and every other type as an `application/octet-stream` download, `nosniff`, no
 *   cache, and a filename with quotes, a CRLF and non-Latin text that reaches the header clean.
 * - The refusals that come before the provider is asked: an id the envelope never listed, a message
 *   the cache does not have, a provider that only lists metadata.
 * - A browser that goes away stops the provider's stream (its signal aborts).
 * - The Mac app's Download (`POST .../save`): the file lands in Downloads under its cleaned name,
 *   never over another file, never in a folder it made, never half written; and only for a caller on
 *   this Mac that is not a test run.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import yaml from 'js-yaml';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('mail-attachment-route-test'));

import { WALNUT_HOME, CONFIG_FILE, TASKS_FILE } from '../../src/constants.js';
import { mailDatabaseForTesting } from '../../src/integrations/mail/db.js';
import { startServer, stopServer } from '../../src/web/server.js';

const FIXTURE_ID = 'mail-attachment-fixture';
const ACCOUNT = 'files:one';
const META_ACCOUNT = 'names:one';
const MESSAGE = 'INBOX:700:1';
const CALLS_FILE = path.join(WALNUT_HOME, 'attachment-fixture-calls.json');

/** The name a stranger can put on a file: quotes, a header injection attempt, two CJK characters. */
const CJK = '\u65e5\u672c';
const HOSTILE_NAME = `Q3 "final"\r\nSet-Cookie: stolen=1 ${CJK}.html`;

let server: HttpServer;
let port = 0;

const url = (accountId: string, messageId: string, attachmentId: string, query = '') =>
  `http://127.0.0.1:${port}/api/plugins/mail/messages/${encodeURIComponent(accountId)}/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}${query}`;

async function calls(): Promise<Array<{ method: string; attachmentId?: string }>> {
  try { return JSON.parse(await fsp.readFile(CALLS_FILE, 'utf8')); }
  catch { return []; }
}

async function writeFixtureProvider(): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'plugins', FIXTURE_ID);
  await fsp.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: FIXTURE_ID,
    name: 'Mail Attachment Fixture',
    description: 'A mail provider whose attachments download',
    version: '1.0.0',
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs',
    dependencies: { mail: '^1.0.0' },
  }));
  await fsp.writeFile(path.join(dir, 'dist', 'server.mjs'), `
import fs from 'node:fs';

const CALLS = ${JSON.stringify(CALLS_FILE)};
function record(entry) {
  let held = [];
  try { held = JSON.parse(fs.readFileSync(CALLS, 'utf8')); } catch { held = []; }
  held.push(entry);
  const staging = CALLS + '.' + process.pid + '.tmp';
  fs.writeFileSync(staging, JSON.stringify(held));
  fs.renameSync(staging, CALLS);
}
function failure(code, message) { const error = new Error(message); error.code = code; return error; }

const FILES = {
  '2': { filename: 'survey.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4\\n% fixture\\n%%EOF\\n') },
  '3': { filename: ${JSON.stringify(HOSTILE_NAME)}, mimeType: 'text/html', bytes: Buffer.from('<script>alert(1)</script>') },
  '4': { filename: 'pier.png', mimeType: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
  '5': { filename: 'huge.bin', mimeType: 'application/octet-stream', bytes: Buffer.alloc(16) },
  // 1 MB at 1 KB per 40 ms: forty seconds, so an abort that arrives in a few is the browser's, not the end's.
  '6': { filename: 'slow.pdf', mimeType: 'application/pdf', bytes: Buffer.alloc(1024 * 1024, 0x41) },
  // Half a file, then the mail server drops the connection.
  '7': { filename: 'cut.pdf', mimeType: 'application/pdf', bytes: Buffer.alloc(4096, 0x43) },
};

const caps = (attachments) => ({
  search: false, watch: false, drafts: false, markRead: false, flags: false, threads: false,
  send: false, sendAsReply: false, bodies: 'text', attachments,
});

function envelope() {
  return {
    messageId: ${JSON.stringify(MESSAGE)},
    rfcMessageId: '<files-1@example.invalid>',
    mailboxId: 'INBOX',
    from: { name: 'Harbour Office', address: 'office@example.invalid' },
    to: [{ address: 'reader@example.invalid' }],
    subject: 'The survey, with files',
    sentAt: Date.UTC(2026, 10, 1, 9, 0, 0),
    flags: [],
    attachments: Object.entries(FILES).map(([id, one]) => ({ id, filename: one.filename, mimeType: one.mimeType, bytes: one.bytes.length })),
  };
}

function spec(id, accountId, attachments, extra) {
  return {
    id,
    label: id,
    capabilities: caps(attachments),
    setup: {
      fields: [{ name: 'which', label: 'Which', kind: 'text' }],
      submit: async () => ({ accountId, providerId: id, displayName: id, address: 'reader@example.invalid', state: 'active' }),
    },
    listAccounts: async () => [{ accountId, providerId: id, displayName: id, address: 'reader@example.invalid', state: 'active' }],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [{ mailboxId: 'INBOX', name: 'INBOX', role: 'inbox', unread: 0, total: 1 }],
    poll: async (_accountId, request) => ({ messages: request.mailbox === 'INBOX' ? [envelope()] : [], cursor: 'c:1', more: false }),
    getBody: async () => ({ format: 'text', text: 'See the files.', bytes: 14 }),
    send: async () => { throw new Error('this fixture cannot send'); },
    ...extra,
  };
}

async function* slowly(bytes, signal) {
  for (let at = 0; at < bytes.length; at += 1024) {
    if (signal.aborted) return;
    yield bytes.subarray(at, at + 1024);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

export function activate(walnut) {
  const base = walnut.services.require('mail:base');
  const files = base.registerProvider(spec('files', ${JSON.stringify(ACCOUNT)}, 'download', {
    async getAttachment(_accountId, messageId, attachmentId, options) {
      record({ method: 'getAttachment', messageId, attachmentId, maxBytes: options.maxBytes });
      options.signal.addEventListener('abort', () => record({ method: 'aborted', attachmentId }), { once: true });
      if (attachmentId === '5') throw failure('too-large', 'That attachment is over the cap Walnut opens.');
      const file = FILES[attachmentId];
      if (!file) throw failure('not-found', 'no such attachment');
      return {
        filename: file.filename,
        mimeType: file.mimeType,
        content: attachmentId === '6' ? slowly(file.bytes, options.signal)
          : attachmentId === '7' ? (async function* () { yield file.bytes.subarray(0, 2048); throw failure('unreachable', 'The mail server closed the connection.'); })()
          : (async function* () { yield file.bytes; })(),
      };
    },
  }));
  // Lists the same attachments and cannot download any of them.
  const names = base.registerProvider(spec('names', ${JSON.stringify(META_ACCOUNT)}, 'metadata', {}));
  return { dispose: () => { files.dispose(); names.dispose(); } };
}
`);
}

async function rows<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
  return mailDatabaseForTesting()!.all<T>(sql);
}

async function addAccount(providerId: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/api/plugins/mail/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId, values: { which: 'one' } }),
  });
  expect(response.status).toBe(201);
}

beforeAll(async () => {
  // A request labelled as a test run is one on this server (decided at boot, src/core/test-run.ts).
  process.env.WALNUT_TEST_RUN_MARK = '1';
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true });
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }));
  await writeFixtureProvider();
  await fsp.writeFile(CONFIG_FILE, yaml.dump({
    version: 1,
    user: { name: 'test' },
    defaults: { priority: 'none' },
    plugins: { mail: { poll_interval_seconds: 3600, retention_days: 3650 } },
  }), 'utf-8');
  server = await startServer({ port: 0, dev: true });
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;

  await addAccount('files');
  await addAccount('names');
  // Wait on the state the first sync leaves, never a clock (tests/core/fixed-sleep-wait-guard.test.ts).
  await vi.waitFor(async () => {
    expect(await rows('SELECT rowid FROM messages')).toHaveLength(2);
  }, { timeout: 30_000, interval: 200 });
}, 180_000);

afterAll(async () => {
  delete process.env.WALNUT_TEST_RUN_MARK;
  await stopServer();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => undefined);
});

describe('reading a message', () => {
  it('asks the provider for no attachment at all', async () => {
    const read = await fetch(`http://127.0.0.1:${port}/api/plugins/mail/messages/${encodeURIComponent(ACCOUNT)}/${encodeURIComponent(MESSAGE)}`);
    expect(read.status).toBe(200);
    const body = await read.json() as { message: { attachments: unknown[] }; body: { text?: string } };
    expect(body.message.attachments).toHaveLength(6);
    expect(body.body.text).toBe('See the files.');
    expect(await calls()).toEqual([]);
  });

  it('the provider row says it can download, so the console can offer the click', async () => {
    const answer = await fetch(`http://127.0.0.1:${port}/api/plugins/mail/providers`);
    const { providers } = await answer.json() as { providers: Array<{ id: string; capabilities: { attachments: string } }> };
    expect(providers.find((one) => one.id === 'files')?.capabilities.attachments).toBe('download');
    expect(providers.find((one) => one.id === 'names')?.capabilities.attachments).toBe('metadata');
  });
});

describe('the headers', () => {
  it('a PDF: inline, its own type, in a sandbox, never sniffed or cached, bytes unchanged', async () => {
    const response = await fetch(url(ACCOUNT, MESSAGE, '2'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe(`inline; filename="survey.pdf"; filename*=UTF-8''survey.pdf`);
    expect(response.headers.get('content-security-policy')).toBe('sandbox');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await response.arrayBuffer()).toString('latin1')).toBe('%PDF-1.4\n% fixture\n%%EOF\n');
    expect((await calls()).filter((one) => one.method === 'getAttachment').at(-1)).toMatchObject({ attachmentId: '2', maxBytes: 50 * 1024 * 1024 });
  });

  it('a PDF asked for as a download keeps its type and is an attachment', async () => {
    const response = await fetch(url(ACCOUNT, MESSAGE, '2', '?download=1'));
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="survey\.pdf"/);
    await response.arrayBuffer();
  });

  it('a raster image: inline, its own type, nothing allowed to load', async () => {
    const response = await fetch(url(ACCOUNT, MESSAGE, '4'));
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toMatch(/^inline; /);
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    await response.arrayBuffer();
  });

  it('html: a download of octet-stream, never inline, and its hostile name reaches the header clean', async () => {
    const response = await fetch(url(ACCOUNT, MESSAGE, '3'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const disposition = response.headers.get('content-disposition')!;
    expect(disposition.startsWith('attachment; filename="')).toBe(true);
    // No line break survives (it would split the response), and the quoted name holds no quote.
    expect(disposition).not.toMatch(/[\r\n]/);
    const ascii = /filename="([^"]*)"/.exec(disposition)![1]!;
    expect(ascii).toBe('Q3 _final_Set-Cookie: stolen=1 __.html');
    // The real name, CJK included, as RFC 5987 UTF-8.
    const encoded = /filename\*=UTF-8''(\S+)$/.exec(disposition)![1]!;
    expect(decodeURIComponent(encoded)).toBe(`Q3 "final"Set-Cookie: stolen=1 ${CJK}.html`);
    expect(encoded).toContain('%E6%97%A5%E6%9C%AC');
    expect(await response.text()).toBe('<script>alert(1)</script>');
  });
});

describe('the refusals', () => {
  it('an id the envelope never listed is a 404 before the provider is asked', async () => {
    const before = (await calls()).length;
    const response = await fetch(url(ACCOUNT, MESSAGE, '9'));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'unknown_attachment' });
    expect((await calls()).length).toBe(before);
  });

  it('a message the cache does not have is a 404', async () => {
    const response = await fetch(url(ACCOUNT, 'INBOX:700:99', '2'));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'unknown_message' });
  });

  it('a provider that only lists metadata is a 501, and nothing is asked of it', async () => {
    const response = await fetch(url(META_ACCOUNT, MESSAGE, '2'));
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error: 'unsupported' });
  });

  it("the provider's too-large is a 413 in its own words", async () => {
    const response = await fetch(url(ACCOUNT, MESSAGE, '5'));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'too-large', message: 'That attachment is over the cap Walnut opens.' });
  });
});

describe('a browser that goes away', () => {
  it('aborts the provider stream', async () => {
    const controller = new AbortController();
    const response = await fetch(url(ACCOUNT, MESSAGE, '6'), { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await vi.waitFor(async () => {
      }, { timeout: 10_000 });
  });
});

describe("the Mac app's Download, saved into Downloads", () => {
  const HOME = path.join(WALNUT_HOME, 'mac-user');
  const DOWNLOADS = path.join(HOME, 'Downloads');
  const save = (accountId: string, attachmentId: string, headers: Record<string, string> = {}, signal?: AbortSignal) =>
    fetch(`${url(accountId, MESSAGE, attachmentId)}/save`, { method: 'POST', headers, ...(signal ? { signal } : {}) });
  const listing = async () => (await fsp.readdir(DOWNLOADS)).sort();

  beforeAll(async () => {
    await fsp.mkdir(DOWNLOADS, { recursive: true });
    // `~/Downloads` of the user the server runs as: this test's own.
    vi.spyOn(os, 'homedir').mockReturnValue(HOME);
  });
  afterAll(() => { vi.mocked(os.homedir).mockRestore(); });

  it('writes the file under its name, and the next one beside it, never over it', async () => {
    const first = await save(ACCOUNT, '2');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ saved: true, name: 'survey.pdf', path: path.join(DOWNLOADS, 'survey.pdf') });
    expect((await fsp.readFile(path.join(DOWNLOADS, 'survey.pdf'))).toString('latin1')).toBe('%PDF-1.4\n% fixture\n%%EOF\n');

    await fsp.writeFile(path.join(DOWNLOADS, 'survey (1).pdf'), 'mine');
    const again = await save(ACCOUNT, '2');
    expect(await again.json()).toMatchObject({ saved: true, name: 'survey (2).pdf' });
    expect(await fsp.readFile(path.join(DOWNLOADS, 'survey (1).pdf'), 'utf8')).toBe('mine');
    expect(await listing()).toEqual(['survey (1).pdf', 'survey (2).pdf', 'survey.pdf']);
  });

  it("saves under the cleaned name, whatever the sender wrote", async () => {
    const answer = await (await save(ACCOUNT, '3')).json() as { name: string; path: string };
    // No line break, no quote, no colon; the CJK text kept.
    expect(answer.name).toBe(`Q3 _final_Set-Cookie_ stolen=1 ${CJK}.html`);
    expect(path.dirname(answer.path)).toBe(DOWNLOADS);
    expect(await fsp.readFile(answer.path, 'utf8')).toBe('<script>alert(1)</script>');
  });

  it('keeps nothing when the mail server drops the file part way', async () => {
    const before = await listing();
    const answer = await save(ACCOUNT, '7');
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ saved: false, error: 'unreachable', message: 'The mail server closed the connection.' });
    expect(await listing()).toEqual(before);
  });

  it('keeps nothing when the app goes away part way', async () => {
    const before = await listing();
    const controller = new AbortController();
    // The answer comes when the copy ends, so the request is still open while the file fills.
    const pending = save(ACCOUNT, '6', {}, controller.signal).catch((error: unknown) => error);
    // The file is open and filling (1 KB every 40 ms); then the request is gone.
    await vi.waitFor(async () => {
      const size = (await fsp.stat(path.join(DOWNLOADS, 'slow.pdf')).catch(() => null))?.size ?? 0;
      expect(size).toBeGreaterThan(0);
    }, { timeout: 10_000 });
    controller.abort();
    expect(await pending).toMatchObject({ name: 'AbortError' });
    await vi.waitFor(async () => { expect(await listing()).toEqual(before); }, { timeout: 10_000 });
    expect((await calls()).some((one) => one.method === 'aborted' && one.attachmentId === '6')).toBe(true);
  });

  it('answers in plain words when there is no Downloads folder, and never makes one', async () => {
    await fsp.rm(DOWNLOADS, { recursive: true, force: true });
    const callsBefore = (await calls()).length;
    const answer = await save(ACCOUNT, '2');
    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({ error: 'no_downloads_folder', message: expect.stringContaining(DOWNLOADS) });
    expect(await fsp.stat(DOWNLOADS).catch(() => null)).toBeNull();
    expect((await calls()).length).toBe(callsBefore);
    await fsp.mkdir(DOWNLOADS, { recursive: true });
  });

  it('refuses a caller off this Mac, and a test run, before the provider is asked', async () => {
    const before = (await calls()).length;
    // A session on another host, through this server (the host lowers the origin, never raises it).
    const remote = await save(ACCOUNT, '2', { 'x-walnut-origin': 'host:devbox' });
    expect(remote.status).toBe(403);
    expect(await remote.json()).toMatchObject({ error: 'local_only' });
    const testRun = await save(ACCOUNT, '2', { 'x-walnut-test-run': 'attachment-save' });
    expect(testRun.status).toBe(409);
    expect(await testRun.json()).toMatchObject({ error: 'test_run' });
    expect((await calls()).length).toBe(before);
    expect(await listing()).toEqual([]);
  });

  it('refuses what the download refuses: an unknown id, a provider that cannot download, a file too big', async () => {
    expect((await save(ACCOUNT, '9')).status).toBe(404);
    expect((await save(META_ACCOUNT, '2')).status).toBe(501);
    const tooBig = await save(ACCOUNT, '5');
    expect(tooBig.status).toBe(413);
    expect(await listing()).toEqual([]);
  });
});
