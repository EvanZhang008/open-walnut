/**
 * Every launch holds its own first message for the panel that opens next (web/src/api/sessions.ts
 * quickStartSession, web/src/components/sessions/launch-prompt-seed.ts).
 *
 * The class: a surface that launches a session and then mounts its panel. The server's copy of the
 * launch prompt (src/core/sessions/launch-prompts.ts) reaches a panel one queue read after it mounts
 * and is forgotten at the first turn's result, so a launcher that did not seed showed no bubble of
 * the person's words whenever a fast first answer beat that read. Only three launchers seeded; the
 * ask drawer (the side panel's Ask, the mail and Slack asks) did not, and since a40f8c7193 (the mock
 * daemon writes a start's line down the FIFO, so the mock answers at once)
 * extension-panel-tasks.spec's bubble was never drawn. Seeding inside quickStartSession covers every
 * launcher; the ratchet below fails when a new one reaches the start route without it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// apiGet: the launch's refresh of the working-dirs list, answered empty.
const mocks = vi.hoisted(() => ({ apiPost: vi.fn(), apiGet: vi.fn(async () => []) }));
vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, apiPost: mocks.apiPost, apiGet: mocks.apiGet };
});

import { quickStartSession } from '@/api/sessions';
import { clearLaunchSeeds, launchSeedFor } from '@/components/sessions/launch-prompt-seed';

const SID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => { clearLaunchSeeds(); mocks.apiPost.mockReset(); });

describe('quickStartSession seeds the launch prompt', () => {
  it('holds the first message under the new session, with the server bubble id', async () => {
    mocks.apiPost.mockResolvedValue({ taskId: 't1', task: null, sessionId: SID });
    await quickStartSession({ cwd: '', message: 'What changed in this release?' });
    expect(launchSeedFor(SID)).toMatchObject({ id: `launch-${SID}`, text: 'What changed in this release?' });
  });

  it('holds nothing for a start with no message or no session yet', async () => {
    mocks.apiPost.mockResolvedValue({ taskId: 't1', task: null, sessionId: SID });
    await quickStartSession({ cwd: '/tmp/x', message: '' });
    expect(launchSeedFor(SID)).toBeUndefined();
    mocks.apiPost.mockResolvedValue({ taskId: 't2', task: null, preparing: true });
    await expect(quickStartSession({ cwd: '/tmp/x', message: 'in a workspace' })).resolves.toMatchObject({ preparing: true });
  });

  it('holds nothing when the message continued the task\'s own session', async () => {
    mocks.apiPost.mockResolvedValue({ taskId: 't1', task: null, sessionId: SID, continued: true });
    await expect(quickStartSession({ cwd: '', taskId: 't1', message: 'One more thing' })).resolves.toMatchObject({ continued: true });
    expect(launchSeedFor(SID)).toBeUndefined();
  });
});

describe('every launcher reaches the start route through quickStartSession', () => {
  const root = path.resolve(__dirname, '../../web/src');
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });

  it('only web/src/api/sessions.ts posts to /api/sessions/quick-start', () => {
    const posters = files(root)
      .filter((f) => fs.readFileSync(f, 'utf8').includes('/api/sessions/quick-start'))
      .map((f) => path.relative(root, f));
    expect(posters).toEqual(['api/sessions.ts']);
  });
});
