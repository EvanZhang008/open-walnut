/**
 * What a wide sweep drops when it runs out of tick budget, and that it drops something DIFFERENT
 * every time.
 *
 * Driven against `MailSync` directly with fake dependencies and a fake clock, the way the replica
 * and poll-interval cases in mail-sync.test.ts are: what is graded is the container ORDER and one
 * integer of per-account state, and a real server plus a worker-thread database would only make the
 * budget (20 seconds of wall clock) impossible to reach inside a test.
 *
 * The bug being pinned: breaking out of the container loop on the deadline is correct, but every
 * wide sweep used to restart at index 0 of the same list, so an account with more folders than fit
 * in one tick abandoned the SAME trailing folders on every wide tick, permanently, with no log line.
 * A real mailbox measured 63 folders at up to a second each.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { MailSync, type MailSyncHost } from '../../src/integrations/mail/sync.js';

const ACCOUNT_ID = 'fake:one';
/** Eight non-inbox containers: more than the four a tick has room for below. */
const REST = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/** Long enough that four containers fill the 20s tick budget and the fifth is never reached. */
const SLOW_POLL_MS = 5_000;

interface Harness {
  /** Mailbox ids polled during the last tick, in order. */
  visited: string[];
  /** Only the "ran out of tick budget" lines, with their fields. */
  warnings: Array<Record<string, unknown>>;
  setPollMs(ms: number): void;
  tick(options?: { force?: boolean }): Promise<string[]>;
  stop(): Promise<void>;
}

function accountRow(): Record<string, unknown> {
  return {
    account_id: ACCOUNT_ID,
    provider_id: 'fake',
    display_name: 'Fixture mailbox',
    address: 'alice@example.invalid',
    state: 'active',
    health_json: null,
    payload: null,
  };
}

function mailboxRow(mailboxId: string, role: string): Record<string, unknown> {
  return {
    account_id: ACCOUNT_ID,
    mailbox_id: mailboxId,
    name: mailboxId,
    role,
    unread: 0,
    total: 0,
    cursor: null,
    last_sync_at: null,
    payload: null,
  };
}

/**
 * One poll loop over one account with `INBOX` plus `rest`, on a clock only its own polls move.
 *
 * Every poll answers `more: false`, so a container takes exactly one poll and the only thing that
 * decides how many containers fit in a tick is how far the clock jumps per poll.
 */
function harness(rest: string[] = REST): Harness {
  let clock = Date.UTC(2026, 0, 1, 9, 0, 0);
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  let pollMs = SLOW_POLL_MS;
  const visited: string[] = [];
  const warnings: Array<Record<string, unknown>> = [];
  const mailboxes = [
    mailboxRow('INBOX', 'inbox'),
    ...rest.map((mailboxId) => mailboxRow(mailboxId, 'other')),
  ];

  const host = {
    replica: false,
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string, meta?: Record<string, unknown>) => {
        if (message === 'mail sync ran out of tick budget') warnings.push({ ...meta });
      },
    },
    config: { get: async () => ({}), onChange: () => ({ dispose: () => undefined }) },
    timers: {
      interval: () => ({ dispose: () => undefined }),
      timeout: () => ({ dispose: () => undefined }),
    },
    notifications: { error: async () => undefined, recover: async () => undefined },
  } satisfies MailSyncHost;

  const spec = {
    id: 'fake',
    label: 'Fake',
    capabilities: { watch: false, search: false, send: false },
    listMailboxes: async () => mailboxes.map((row) => ({
      mailboxId: row.mailbox_id as string,
      name: row.name as string,
      role: row.role as string,
      unread: 0,
      total: 0,
    })),
    poll: async (_accountId: string, request: { mailbox: string }) => {
      visited.push(request.mailbox);
      clock += pollMs;
      return { messages: [], cursor: '1:0', more: false };
    },
  };

  const sync = new MailSync({
    walnut: host,
    store: {
      listAccounts: async () => [accountRow()],
      getAccount: async () => accountRow(),
      listMailboxes: async () => mailboxes,
      upsertMailbox: async () => undefined,
      setMailboxCursor: async () => undefined,
    } as never,
    service: {
      provider: () => spec,
      ingestPage: async () => ({ added: 0, updated: 0, headlines: [] }),
      prefetchBodies: async () => 0,
    } as never,
    retention: {
      retain: async () => ({ messagesDeleted: 0, bodiesDropped: 0, incomplete: false }),
      resetContainer: async () => undefined,
    } as never,
    events: {
      syncCompleted: () => undefined,
      messagesReceived: () => undefined,
      accountHealth: () => undefined,
    } as never,
  });

  return {
    visited,
    warnings,
    setPollMs: (ms: number) => { pollMs = ms },
    async tick(options: { force?: boolean } = { force: true }): Promise<string[]> {
      visited.length = 0;
      await sync.runTick(options);
      return [...visited];
    },
    stop: () => sync.stop(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a wide sweep that runs out of tick budget', () => {
  it('rotates what it drops, so every container is reached within three ticks', async () => {
    const mail = harness();
    try {
      // Four containers fit: the inbox, which is never rotated away, and three of the rest.
      expect(await mail.tick()).toEqual(['INBOX', 'A', 'B', 'C']);
      // The next wide tick picks up where that one stopped rather than starving D..H forever.
      expect(await mail.tick()).toEqual(['INBOX', 'D', 'E', 'F']);
      // And it WRAPS, which is what makes this a rotation and not a one-shot resume.
      expect(await mail.tick()).toEqual(['INBOX', 'G', 'H', 'A']);

      // One line per exhausted tick, naming how much was left. Silence is what made the original
      // bug invisible: an account whose tail folders never synced looked like empty folders.
      expect(mail.warnings).toEqual([
        { accountId: ACCOUNT_ID, containers: 9, visited: 4, left: 5 },
        { accountId: ACCOUNT_ID, containers: 9, visited: 4, left: 5 },
        { accountId: ACCOUNT_ID, containers: 9, visited: 4, left: 5 },
      ]);
    } finally {
      await mail.stop();
    }
  });

  it('reaches every container across three ticks, counted', async () => {
    const mail = harness();
    try {
      const seen = new Set<string>();
      for (let round = 0; round < 3; round += 1) {
        for (const mailboxId of await mail.tick()) seen.add(mailboxId);
      }
      // Every one of the nine, in three ticks that each had room for four. Before the rotation,
      // ticks 2 and 3 re-synced INBOX + A..C and the other five were never seen at all.
      expect([...seen].sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'INBOX']);
    } finally {
      await mail.stop();
    }
  });
});

describe('the rotation cursor', () => {
  it('goes back to the first container once a whole sweep fits in one tick', async () => {
    const mail = harness();
    try {
      expect(await mail.tick()).toEqual(['INBOX', 'A', 'B', 'C']);

      // A tick with room for everything: the sweep completes, so the account is no longer behind.
      mail.setPollMs(0);
      expect(await mail.tick()).toEqual(['INBOX', 'D', 'E', 'F', 'G', 'H', 'A', 'B', 'C']);

      // ...and the next slow wide tick starts at A again rather than carrying a cursor nothing is
      // waiting behind.
      mail.setPollMs(SLOW_POLL_MS);
      expect(await mail.tick()).toEqual(['INBOX', 'A', 'B', 'C']);
      expect(mail.warnings).toHaveLength(2);
    } finally {
      await mail.stop();
    }
  });

  it('is not reset by a narrow tick, which drains the inbox on almost every pass', async () => {
    const mail = harness();
    try {
      expect(await mail.tick()).toEqual(['INBOX', 'A', 'B', 'C']);

      // A NARROW tick: no force, and the every-Nth rule is not up, so it visits the inbox alone
      // and reports the sweep exhausted. Resetting the cursor on that would put every wide sweep
      // back at index 0 and undo the rotation entirely, which is four ticks out of five.
      expect(await mail.tick({})).toEqual(['INBOX']);

      expect(await mail.tick()).toEqual(['INBOX', 'D', 'E', 'F']);
    } finally {
      await mail.stop();
    }
  });

  it('survives an account whose only container is the inbox', async () => {
    // The rotation is over the NON-inbox containers, so this account has nothing to rotate. The
    // modulo that advances the cursor must not divide by that zero.
    const mail = harness([]);
    try {
      mail.setPollMs(25_000);
      expect(await mail.tick()).toEqual(['INBOX']);
      expect(await mail.tick()).toEqual(['INBOX']);
      expect(mail.warnings).toEqual([]);
    } finally {
      await mail.stop();
    }
  });
});
