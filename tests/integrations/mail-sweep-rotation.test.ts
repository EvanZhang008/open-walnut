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
  /** Every "one container failed, sweep continues" line, with its fields. */
  failures: Array<Record<string, unknown>>;
  /** Health states written to the account row, which is how a parked account is observed. */
  healthWrites: string[];
  /** Any container whose poll began while another was still inside its own poll. */
  overlaps: string[];
  /** One entry per `messages-received` event, which is what a human sees as "new mail". */
  announced: Array<{ received: number }>;
  setPollMs(ms: number): void;
  /** Make this container's poll throw. `code` rides on the error the way a provider's would. */
  failOn(mailboxId: string, code?: string): void;
  tick(options?: { force?: boolean }): Promise<string[]>;
  fetchOne(mailboxId: string): Promise<{ fetched: boolean; added: number; reason?: string }>;
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
function harness(
  rest: string[] = REST,
  options: { replica?: boolean; yieldInPoll?: boolean; unreadCheck?: () => Promise<unknown> } = {},
): Harness {
  let clock = Date.UTC(2026, 0, 1, 9, 0, 0);
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  let pollMs = SLOW_POLL_MS;
  const visited: string[] = [];
  const warnings: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, unknown>> = [];
  const healthWrites: string[] = [];
  const overlaps: string[] = [];
  const announced: Array<{ received: number }> = [];
  const failing = new Map<string, string>();
  /** Containers currently inside their own poll. More than one at a time is the race. */
  const inPoll = new Set<string>();
  const mailboxes = [
    mailboxRow('INBOX', 'inbox'),
    ...rest.map((mailboxId) => mailboxRow(mailboxId, 'other')),
  ];

  const host = {
    replica: options.replica === true,
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string, meta?: Record<string, unknown>) => {
        if (message === 'mail sync ran out of tick budget') warnings.push({ ...meta });
        if (message === 'mail container poll failed, sweep continues') failures.push({ ...meta });
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
      if (inPoll.size > 0) overlaps.push(request.mailbox);
      inPoll.add(request.mailbox);
      try {
        clock += pollMs;
        // Only when asked: every other test here counts on a poll that never suspends, so the
        // container order it observes is the order the loop chose and not a scheduling accident.
        if (options.yieldInPoll) await new Promise((resolve) => { setImmediate(resolve) });
        const code = failing.get(request.mailbox);
        if (code) {
          // Shaped like a provider's own refusal: the code is what the sync loop reads to decide
          // whether this is one folder's problem or the whole account's.
          const error = new Error(`the server refused ${request.mailbox}`) as Error & { code: string };
          error.code = code;
          throw error;
        }
        return { messages: [], cursor: '1:0', more: false };
      } finally {
        inPoll.delete(request.mailbox);
      }
    },
  };

  const sync = new MailSync({
    walnut: host,
    store: {
      listAccounts: async () => [accountRow()],
      getAccount: async () => accountRow(),
      listMailboxes: async () => mailboxes,
      upsertMailbox: async () => undefined,
      deleteMailbox: async () => undefined,
      setMailboxCursor: async () => undefined,
      setAccountHealth: async (_id: string, state: string) => { healthWrites.push(state) },
      accountExists: async () => true,
    } as never,
    service: {
      provider: () => spec,
      ingestPage: async () => ({ added: 0, updated: 0, headlines: [] }),
      prefetchBodies: async () => 0,
      // Nothing to correct: this file grades the container order, not read state.
      checkUnreadInBackground: options.unreadCheck ?? (async () => null),
    } as never,
    retention: {
      retain: async () => ({ messagesDeleted: 0, bodiesDropped: 0, incomplete: false }),
      resetContainer: async () => undefined,
    } as never,
    events: {
      syncCompleted: () => undefined,
      messagesReceived: (_accountId: string, received: number) => { announced.push({ received }) },
      accountHealth: () => undefined,
    } as never,
  });

  return {
    visited,
    warnings,
    failures,
    healthWrites,
    overlaps,
    announced,
    setPollMs: (ms: number) => { pollMs = ms },
    failOn: (mailboxId: string, code = 'not-found') => { failing.set(mailboxId, code) },
    async tick(options: { force?: boolean } = { force: true }): Promise<string[]> {
      visited.length = 0;
      await sync.runTick(options);
      return [...visited];
    },
    async fetchOne(mailboxId: string) {
      visited.length = 0;
      const report = await sync.refreshMailbox(ACCOUNT_ID, mailboxId);
      return report;
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

  it('moves past a container that always fails, instead of pinning itself to it', async () => {
    // The shipped bug, in the shape it was found in. A real Gmail account listed 67 folders and the
    // twelfth in sweep order was a label the server would not SELECT. That refusal ended the whole
    // sweep, and because the cursor only advanced on the deadline path, every wide sweep for the
    // rest of the day repeated the same eleven folders and died on the same twelfth. The other 55,
    // Sent Mail among them, were never polled once: the folder list knew Sent Mail held 1,962
    // messages and the message list said the folder was empty.
    const mail = harness();
    try {
      mail.setPollMs(0);
      // `unreachable` is what the real refusal arrived as, and it is the code that ESCAPED: a
      // `not-found` was already contained inside the container's own loop, which is why the bug
      // needed a folder whose refusal did not map to it.
      mail.failOn('C', 'unreachable');
      // The sweep reaches every container, C included (it is reached, it just fails).
      expect(await mail.tick()).toEqual(['INBOX', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
      // And it keeps doing so, rather than stopping at C forever.
      expect(await mail.tick()).toEqual(['INBOX', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
      expect(mail.failures).toEqual([
        { accountId: ACCOUNT_ID, mailboxId: 'C', code: 'unreachable', error: 'the server refused C' },
        { accountId: ACCOUNT_ID, mailboxId: 'C', code: 'unreachable', error: 'the server refused C' },
      ]);
      // One folder refusing is NOT the account being down: nothing parked it.
      expect(mail.healthWrites).toEqual([]);
    } finally {
      await mail.stop();
    }
  });

  it('still rotates when a container fails inside a sweep that also runs out of budget', async () => {
    // Both early exits at once, which is the case that made the cursor stand still: a failure meant
    // the sweep did not "drain", so the reset branch was skipped, and the loop had not hit the
    // deadline either, so the advance branch was skipped too.
    const mail = harness();
    try {
      mail.failOn('A', 'unreachable');
      expect(await mail.tick()).toEqual(['INBOX', 'A', 'B', 'C']);
      // A failed A is a visited A: the next sweep starts after it rather than at it.
      expect(await mail.tick()).toEqual(['INBOX', 'D', 'E', 'F']);
    } finally {
      await mail.stop();
    }
  });

  it('goes back to the start after a sweep that reached everything, failures included', async () => {
    // The cursor's rule is about whether the sweep was CUT SHORT, and it used to be about whether
    // every container drained. Those were the same question until a container could fail without
    // ending the sweep: a folder the server refuses never drains, so a sweep that had in fact
    // visited all eight left the cursor parked wherever the last truncated sweep had put it.
    const mail = harness();
    try {
      expect(await mail.tick()).toEqual(['INBOX', 'A', 'B', 'C']);

      // Room for everything this time, and one container refuses. The sweep still reached all of
      // them, so the account is no longer behind and the next slow sweep starts from the top.
      mail.setPollMs(0);
      mail.failOn('E', 'unreachable');
      expect(await mail.tick()).toEqual(['INBOX', 'D', 'E', 'F', 'G', 'H', 'A', 'B', 'C']);

      mail.setPollMs(SLOW_POLL_MS);
      expect(await mail.tick()).toEqual(['INBOX', 'A', 'B', 'C']);
    } finally {
      await mail.stop();
    }
  });

  it('parks the account only when every container it reached failed', async () => {
    const mail = harness(['A']);
    try {
      mail.setPollMs(0);
      mail.failOn('INBOX', 'unreachable');
      mail.failOn('A', 'unreachable');
      await mail.tick();
      // Nothing worked, so whatever is wrong belongs to the account and it gets the backoff. The
      // health row is only written on `auth`, so what is observable here is the two failure lines.
      expect(mail.failures.map((one) => one.mailboxId)).toEqual(['INBOX', 'A']);
    } finally {
      await mail.stop();
    }
  });

  it('still announces new mail on an account with a permanently unopenable folder', async () => {
    // The first backfill is announced to nobody ("you have 4812 new messages" is the account being
    // added, not news), and the flag that ends that suppression used to be cleared by ANY container
    // that did not drain. A folder the server refuses never drains, so an account with one of them
    // would go quiet about new mail forever — a second bug hiding behind the first, and one that
    // only appears once sweeps stop dying.
    const mail = harness(['A', 'B']);
    try {
      mail.setPollMs(0);
      mail.failOn('B', 'unreachable');
      await mail.tick();
      expect(mail.announced, 'the first backfill announces nothing').toEqual([]);

      await mail.tick();
      expect(mail.announced, 'and the sweep after it is news again').toEqual([{ received: 0 }]);
    } finally {
      await mail.stop();
    }
  });

  it('announces new mail before the unread check, and a check that throws is not an account failure', async () => {
    // The check after the inbox poll asks the provider a second question, which can take seconds or
    // fail outright. Neither may hold back "new mail" or put a healthy account into the backoff.
    const order: string[] = [];
    const mail = harness(['A'], {
      unreadCheck: async () => { order.push(`check after ${mail.announced.length} announcements`); throw new Error('the helper stopped') },
    });
    try {
      mail.setPollMs(0);
      await mail.tick();
      await mail.tick();
      expect(mail.announced).toEqual([{ received: 0 }]);
      expect(order.at(-1), 'the announcement went out first').toBe('check after 1 announcements');
      expect(mail.failures).toEqual([]);
      expect(mail.healthWrites).toEqual([]);
    } finally {
      await mail.stop();
    }
  });

  it('stays quiet while the INBOX itself is the container that failed', async () => {
    // The number in that announcement counts inbox mail, so an inbox that has never been read
    // successfully leaves the question genuinely open: clearing the flag there would announce the
    // whole first backfill the moment the inbox came back.
    const mail = harness(['A']);
    try {
      mail.setPollMs(0);
      mail.failOn('INBOX', 'unreachable');
      await mail.tick();
      await mail.tick();
      expect(mail.announced).toEqual([]);
    } finally {
      await mail.stop();
    }
  });

  it('stops the sweep on an auth failure, which belongs to the whole account', async () => {
    // The one code that must NOT be carried past: the credential is the account's, so trying the
    // next sixty folders is sixty more wrong sign-ins on the way to a lockout.
    const mail = harness();
    try {
      mail.setPollMs(0);
      mail.failOn('B', 'auth');
      expect(await mail.tick()).toEqual(['INBOX', 'A', 'B']);
      expect(mail.failures).toEqual([]);
      expect(mail.healthWrites).toEqual(['auth-required']);
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

/**
 * The queue jump: one folder, now, because somebody opened it.
 *
 * The rotation reaching every folder "within a few ticks" is the right answer for a background loop
 * and the wrong one for a click. On the account this was found on, a few ticks was the better part
 * of an hour, and the folder on screen showed its true size next to an empty list for all of it.
 */
describe('an on-demand fetch of one folder', () => {
  it('polls that container and nothing else', async () => {
    const mail = harness();
    try {
      mail.setPollMs(0);
      const report = await mail.fetchOne('G');
      expect(report).toEqual({ fetched: true, added: 0, updated: 0 });
      // Not the inbox, which is what a `markDirty` plus a kick would have polled first: an inbox
      // still walking its history backwards takes twenty pages a tick, and the folder somebody is
      // waiting for would sit behind it.
      expect(mail.visited).toEqual(['G']);
    } finally {
      await mail.stop();
    }
  });

  it('reports a folder the SERVER says is gone as gone, not as a folder with no mail', async () => {
    // `not-found` is handled inside the container's own loop, which marks it done and moves on. For
    // a sweep that is right; for somebody watching a folder it is not, because a fetch reported as
    // successful-with-nothing sends the console on to explain the empty list as a cache window.
    const mail = harness();
    try {
      mail.setPollMs(0);
      mail.failOn('E', 'not-found');
      expect(await mail.fetchOne('E')).toEqual({
        fetched: false, reason: 'unknown-mailbox', added: 0, updated: 0,
      });
    } finally {
      await mail.stop();
    }
  });

  it('reports a folder the provider does not list, without touching the account', async () => {
    const mail = harness();
    try {
      expect(await mail.fetchOne('Nope')).toEqual({
        fetched: false, reason: 'unknown-mailbox', added: 0, updated: 0,
      });
      expect(mail.visited).toEqual([]);
      expect(mail.healthWrites).toEqual([]);
    } finally {
      await mail.stop();
    }
  });

  it('reports a refusal as this folder failing, not as the account failing', async () => {
    const mail = harness();
    try {
      mail.setPollMs(0);
      mail.failOn('D', 'unreachable');
      expect(await mail.fetchOne('D')).toEqual({
        fetched: false, reason: 'failed', added: 0, updated: 0,
        detail: 'the server refused D',
      });
      expect(mail.healthWrites).toEqual([]);
    } finally {
      await mail.stop();
    }
  });

  it('parks the account when the fetch is refused for the credential', async () => {
    const mail = harness();
    try {
      mail.setPollMs(0);
      mail.failOn('D', 'auth');
      expect((await mail.fetchOne('D')).fetched).toBe(false);
      expect(mail.healthWrites).toEqual(['auth-required']);
    } finally {
      await mail.stop();
    }
  });

  it('does nothing at all on a replica, which does not own the outside account', async () => {
    const mail = harness(REST, { replica: true });
    try {
      expect(await mail.fetchOne('A')).toEqual({
        fetched: false, reason: 'replica', added: 0, updated: 0,
      });
      expect(mail.visited).toEqual([]);
    } finally {
      await mail.stop();
    }
  });

  it('waits for a tick that is already running rather than racing its cursor writes', async () => {
    // Two polls of one container race each other's cursor writes, which is why every tick is queued
    // behind the last one. A fetch that jumped that queue would reintroduce exactly that race.
    //
    // The fake poll YIELDS to the event loop here, so an unserialized fetch really would interleave:
    // without the await, nothing in this harness ever suspends and the assertion below would pass on
    // an implementation that has no queue at all.
    const mail = harness(REST, { yieldInPoll: true });
    try {
      mail.setPollMs(0);
      const sweep = mail.tick();
      const fetch = mail.fetchOne('G');
      await Promise.all([sweep, fetch]);
      expect(mail.overlaps).toEqual([]);
      expect((await fetch).fetched).toBe(true);
    } finally {
      await mail.stop();
    }
  });
});
