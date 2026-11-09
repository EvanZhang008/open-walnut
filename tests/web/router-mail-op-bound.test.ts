// A mail op's slow lookups run together under one deadline (router-area-reader.ts), with no server:
// fake timers here cannot drop a running server's own timers.
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-mail-op-bound'));

import { WALNUT_HOME } from '../../src/constants.js';
import { readRouterAreas, routerAreasPath } from '../../src/core/router/areas.js';
import { registerRouterSource } from '../../src/core/router/source-registry.js';
import { mailRouterKey } from '../../src/integrations/mail/router-source.js';
import { judgeAreaRead } from '../../src/web/middleware/router-area-reader.js';

const account = 'desk@marina.example.invalid';
const classified = { kind: 'mail' as const, account, message: 'INBOX:1:10' };
// An automated caller has no session, so no session lookup runs beside the mail lookups.
const AUTOMATION = { automation: true } as const;

const resolve = vi.fn(async (source: { kind: 'mail'; account: string; message: string }) => ({
  source, sender: 'pat@marina.example.invalid', subject: 'META_ONLY', key: mailRouterKey(source.account, source.message),
}));
const read = vi.fn(async () => { throw new Error('the guard must not read a body'); });
let stopSource = () => {};

beforeAll(async () => {
  // The registry is written and read once with real timers, so nothing below waits on a first-use init.
  const file = routerAreasPath(WALNUT_HOME);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    areas: [{ id: 'personal', name: 'Personal', host: '__local__', taskIds: ['task-personal'], sources: [{ kind: 'mail', account }] }],
    routers: [{ taskId: 'task-personal', areaId: 'personal', paused: false }],
    // A keyed item makes every other message of the account need its key, so each id is looked up.
    items: [{ source: classified, areaId: 'personal', canonicalKey: mailRouterKey(account, classified.message, '<rota-1@marina.example.invalid>') }],
  }));
  expect((await readRouterAreas(WALNUT_HOME)).items).toHaveLength(1);
  stopSource = registerRouterSource('mail', { resolve, read });
});

afterAll(async () => {
  stopSource();
  vi.useRealTimers();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('a mail op of 25 slow lookups', () => {
  it('starts every lookup at once, so the batch waits one lookup deadline, not 25', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `INBOX:8:${i}`);
    for (let i = 0; i < ids.length; i += 1) resolve.mockImplementationOnce(() => new Promise(() => {}));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let verdict: Promise<string> | undefined;
    try {
      verdict = judgeAreaRead(AUTOMATION, { kind: 'mail-op' }, { account, messages: ids });
      // Every lookup has started before any time passes; a serial loop would have started one.
      await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(25));
    } finally {
      // One deadline settles every lookup, so no deadline is left pending once real timers are back.
      await vi.advanceTimersByTimeAsync(3000);
      vi.useRealTimers();
    }
    expect(await verdict).toBe('unverifiable');
    expect(read).not.toHaveBeenCalled();
  });
});
