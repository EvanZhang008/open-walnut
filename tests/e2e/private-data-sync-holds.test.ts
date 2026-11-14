/** Real HTTP status remains compatible, with no credential holds or user notices. */
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
let server: Server;
let root: string;
beforeAll(async () => { server = await startServer({ port: 0, dev: true }); root = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
afterAll(async () => { await stopServer(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

describe('private-data sync status', () => {
  it('Health never reports credential holds and old system letters still settle without replacement', async () => {
    await fs.mkdir(path.join(WALNUT_HOME, '.git'), { recursive: true });
    await fs.writeFile(path.join(WALNUT_HOME, '.git/walnut-secret-holds.json'), JSON.stringify({ version: 2, holds: { 'notes/held.md': { kinds: ['private-key'], lines: [3] } } }));
    const old = await sendLetter({ subject: 'A file was kept out of sync: it holds a secret', type: 'review', markdown: 'Old notice', sender: { sessionId: 'external' } }, { opKey: 'git-sync-secret-hold:old-http' });
    const status = await fetch(`${root}/api/git-sync/status`).then((r) => r.json());
    expect(status).toMatchObject({ consecutiveFailures: 0, heldFiles: [] });
    await settleUnneededWalnutLetters();
    expect((await getLetter(old.id))?.archived).toBe(true);
  });

  it('letter send-time credential refusal still applies outside private-data sync', async () => {
    const fake = ['GOC', 'SPX-', 'aB3_dE5-fG7_hI9-jK1_lM2-nO4Q'].join('');
    await expect(sendLetter({ subject: 'Connect storage', type: 'review', markdown: fake, sender: { sessionId: 'writer-http' } })).rejects.toMatchObject({ code: 'credential' });
  });
});
