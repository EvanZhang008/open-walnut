import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('private-data-hold-api', { IS_EPHEMERAL: true }));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { getLetter, sendLetter } from '../../src/core/human-inbox/store.js';
import { settleUnneededWalnutLetters } from '../../src/core/human-inbox/walnut-letters/sweep.js';
import { notifySecretHoldWriter, secretHoldWriterText } from '../../src/integrations/git-sync-secret-notices.js';
import type { SecretHold } from '../../src/integrations/git-sync-secrets.js';

let server: Server;
let root: string;
beforeAll(async () => {
  server = await startServer({ port: 0, dev: true });
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await stopServer(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

describe('private-data hold HTTP contract', () => {
  it('Health reads quiet metadata and old letters settle without a replacement letter', async () => {
    const held: SecretHold = { kinds: ['google-oauth-secret'], lines: [3], since: '2026-11-12T00:00:00Z', tracked: false };
    await fs.mkdir(path.join(WALNUT_HOME, '.git'), { recursive: true });
    await fs.writeFile(path.join(WALNUT_HOME, '.git/walnut-secret-holds.json'), JSON.stringify({ version: 2, holds: { 'notes/held.md': held } }));
    const old = await sendLetter({ subject: 'A file was kept out of sync: it holds a secret', type: 'review', markdown: 'Old notice', sender: { sessionId: 'external' } }, { opKey: 'git-sync-secret-hold:old-http' });
    await notifySecretHoldWriter({ event: 'held', files: [{ file: 'notes/held.md', hold: held }], root: WALNUT_HOME, op: 'hold-http' });
    const status = await fetch(`${root}/api/git-sync/status`).then((r) => r.json());
    expect(status).toMatchObject({ consecutiveFailures: 0, heldFiles: [{ file: path.join(WALNUT_HOME, 'notes/held.md'), kinds: held.kinds, lines: [3] }] });
    const settled = await settleUnneededWalnutLetters();
    expect(settled.some((s) => s.id === old.id)).toBe(true);
    expect((await getLetter(old.id))?.archived).toBe(true);
  });

  it('the writer can use the existing server redact operation without reading a credential or leaving stale body sizes', async () => {
    const l = await sendLetter({ subject: 'Connect storage', type: 'review', markdown: 'Step 1\nStep 2\nStep 3', sender: { sessionId: 'writer-http' } });
    const file = `human-inbox/bodies/${l.id}.md`;
    const fake = ['GOC', 'SPX-', 'aB3_dE5-fG7_hI9-jK1_lM2-nO4Q'].join('');
    await fs.writeFile(path.join(WALNUT_HOME, file), `Step 1\nClient secret: ${fake}\nStep 3`);
    const text = secretHoldWriterText({ event: 'held', files: [], op: 'hold', root: WALNUT_HOME }, file, { kinds: ['google-oauth-secret'], lines: [2], since: 'now', tracked: false });
    expect(text).toContain(`/api/v1/human-inbox/${l.id}/redact-credentials`);
    const response = await fetch(`${root}/api/v1/human-inbox/${l.id}/redact-credentials`, { method: 'POST', headers: { 'x-walnut-caller-sid': 'writer-http' } });
    expect(response.status).toBe(200);
    const body = await fs.readFile(path.join(WALNUT_HOME, file), 'utf8');
    expect(body).not.toContain(fake);
    expect(body).toContain('Step 1');
    expect(body).toContain('Step 3');
    expect((await getLetter(l.id))?.bodyBytes).toBe(Buffer.byteLength(body));
  });
});
