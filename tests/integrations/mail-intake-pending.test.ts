// The mail the router intake could not enter yet is kept on disk (src/integrations/mail/intake-pending.ts),
// the old Inbox Triage mail buffer joins it at start, and the "no router reads this mailbox" letter
// settles once a router reads the mailbox again. 2026-11-14 review: each of these paths used to lose mail.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { updateRouterAreas, type RouterAreasFile } from '../../src/core/router/areas.js';
import { noRouterLetterOpKey, noRouterLetterSettleReason } from '../../src/core/router/account-intake.js';
import { kindOfLetter } from '../../src/core/human-inbox/walnut-letters/registry.js';
import { MAIL_NO_ROUTER } from '../../src/core/human-inbox/walnut-letters/mail-no-router.js';
import type { LetterRecord } from '../../src/core/human-inbox/types.js';
import type { StillNeededContext } from '../../src/core/human-inbox/walnut-letters/kind.js';
import type { Task } from '../../src/core/types.js';
import { loadTriageState, recordTriageArrivals, triageStatePath } from '../../src/core/triage/state.js';
import {
  MAIL_INTAKE_PENDING_CAP, MAIL_INTAKE_PENDING_MAX_AGE_MS, mailIntakePendingPath, mailIntakeQueue, type MailIntakeQueue,
} from '../../src/integrations/mail/intake-pending.js';
import { adoptTriageMail } from '../../src/integrations/mail/triage-mail-adoption.js';
import { seedTaskStore } from '../helpers/router-task-store.js';

const NOW = Date.UTC(2026, 10, 14, 9, 0, 0);
const DAY = 24 * 60 * 60_000;
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function home(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-intake-pending-'));
  roots.push(dir);
  return dir;
}

describe('the pending queue', () => {
  it('keeps one entry per mail at its first sighting, drops entries older than 7 days and the oldest over the cap, each with a warning', async () => {
    const at = await home();
    const warnings: string[] = [];
    const queue = mailIntakeQueue(at, { now: () => NOW, log: { warn: (message) => { warnings.push(message); } } });
    await queue.add([
      { account: 'a', message: 'm-1', at: NOW - DAY },
      { account: 'a', message: 'm-1', at: NOW - 2 * DAY },
      { account: 'b', message: 'm-1', at: NOW },
      { account: 'a', message: 'old', at: NOW - MAIL_INTAKE_PENDING_MAX_AGE_MS - 1 },
    ]);
    expect((await queue.read()).entries).toEqual([
      { account: 'a', message: 'm-1', at: NOW - 2 * DAY },
      { account: 'b', message: 'm-1', at: NOW },
    ]);
    expect(warnings).toEqual(['mail intake dropped arrivals no router took within 7 days']);

    await queue.add(Array.from({ length: MAIL_INTAKE_PENDING_CAP + 5 }, (_, i) => ({ account: 'c', message: `n-${i}`, at: NOW - DAY + i })));
    const entries = (await queue.read()).entries;
    expect(entries).toHaveLength(MAIL_INTAKE_PENDING_CAP);
    // The seven oldest went: the older entry above and the first six of the batch; the newest stays.
    expect(entries.some((one) => one.message === 'm-1' && one.account === 'a')).toBe(false);
    expect(entries.some((one) => one.message === 'n-5')).toBe(false);
    expect(entries.some((one) => one.message === 'n-6')).toBe(true);
    expect(entries.at(-1)).toEqual({ account: 'b', message: 'm-1', at: NOW });
    expect(warnings.at(-1)).toBe('mail intake pending queue is full; the oldest arrivals were dropped');

    await queue.remove('c', ['n-6', 'n-7']);
    expect((await queue.read()).entries).toHaveLength(MAIL_INTAKE_PENDING_CAP - 2);
  });

  it('lives under the home\'s router folder, which is never synced, and a missing file reads empty', async () => {
    const at = await home();
    expect(mailIntakePendingPath(at)).toBe(path.join(at, 'router', 'mail-intake-pending.json'));
    expect(await mailIntakeQueue(at).read()).toEqual({ version: 1, entries: [], notices: {} });
  });
});

describe('the mail an older build buffered for Inbox Triage', () => {
  const SUBJECT = 'Canary-legacy-subject-77';
  const slackRow = { conversation: '#c', isDm: false, isMention: true, alias: 'a', ts: '1.0', permalink: '', text: 'hello', atMs: 3 };

  /** triage-state.json as prod held it on 2026-11-14. */
  async function prodFile(at: string) {
    await fsp.writeFile(triageStatePath(at), JSON.stringify({
      version: 1,
      runs: 7,
      lastRunAtMs: 11,
      pending: {
        mail: [
          { accountId: 'gmail:pat', count: 2, atMs: NOW - DAY, headlines: [
            { from: 'a@example.invalid', subject: SUBJECT, messageId: 'INBOX:1', canonicalKey: 'k1', version: 'v1' },
            { from: 'b@example.invalid', subject: SUBJECT, messageId: 'INBOX:2', canonicalKey: 'k2', version: 'v2' },
          ] },
          { accountId: 'imap:work', count: 1, atMs: NOW - 2 * DAY, headlines: [{ from: 'c@example.invalid', subject: SUBJECT, messageId: 'INBOX:9' }] },
        ],
        slack: [slackRow],
        droppedMail: 3,
        droppedSlack: 1,
      },
    }), 'utf-8');
  }

  it('survives a Slack write before the start, as ids only, and then moves to the pending queue; Slack rows stay', async () => {
    const at = await home();
    await prodFile(at);
    // The Slack collector flushes before the mail plugin starts: the mail ids are kept, the words are not.
    await recordTriageArrivals({ slack: [{ ...slackRow, ts: '2.0' }] }, at);
    const between = await fsp.readFile(triageStatePath(at), 'utf-8');
    expect(between).not.toContain(SUBJECT);
    expect((await loadTriageState(at)).legacyMail).toEqual([
      { accountId: 'gmail:pat', messageIds: ['INBOX:1', 'INBOX:2'], atMs: NOW - DAY },
      { accountId: 'imap:work', messageIds: ['INBOX:9'], atMs: NOW - 2 * DAY },
    ]);

    const queue = mailIntakeQueue(at, { now: () => NOW });
    expect(await adoptTriageMail(at, queue)).toBe(3);
    expect((await queue.read()).entries).toEqual([
      { account: 'imap:work', message: 'INBOX:9', at: NOW - 2 * DAY },
      { account: 'gmail:pat', message: 'INBOX:1', at: NOW - DAY },
      { account: 'gmail:pat', message: 'INBOX:2', at: NOW - DAY },
    ]);
    const raw = JSON.parse(await fsp.readFile(triageStatePath(at), 'utf-8'));
    expect(raw.legacyMail).toBeUndefined();
    expect(raw.pending).toEqual({ slack: [slackRow, { ...slackRow, ts: '2.0' }], droppedSlack: 1 });
    expect(raw.runs).toBe(7);
    expect(raw.lastRunAtMs).toBe(11);

    // Again at the next start: nothing to move, nothing written, the queue unchanged.
    const before = await fsp.stat(triageStatePath(at));
    expect(await adoptTriageMail(at, queue)).toBe(0);
    expect((await fsp.stat(triageStatePath(at))).mtimeMs).toBe(before.mtimeMs);
    expect((await queue.read()).entries).toHaveLength(3);
  });

  it('a move that fails keeps the rows for the next start, and the queue keeps one entry per mail when it runs twice', async () => {
    const at = await home();
    await prodFile(at);
    const warnings: string[] = [];
    const broken: MailIntakeQueue = { ...mailIntakeQueue(at), add: async () => { throw new Error('disk full'); } };
    expect(await adoptTriageMail(at, broken, { warn: (message) => { warnings.push(message); } })).toBe(0);
    expect(warnings).toEqual(['mail router intake could not take the old triage mail; it tries again at the next start']);
    expect((await loadTriageState(at)).legacyMail).toHaveLength(2);

    // A crash after the queue write and before the triage write hands the same rows over again.
    const queue = mailIntakeQueue(at, { now: () => NOW });
    await queue.add([{ account: 'gmail:pat', message: 'INBOX:1', at: NOW - DAY }]);
    expect(await adoptTriageMail(at, queue)).toBe(3);
    expect((await queue.read()).entries).toHaveLength(3);
  });

  it('a file with no mail rows is left as it is', async () => {
    const at = await home();
    expect(await adoptTriageMail(at, mailIntakeQueue(at))).toBe(0);
    await expect(fsp.stat(triageStatePath(at))).rejects.toThrow();
  });
});

describe('the "no router reads this mailbox" letter', () => {
  const ACCOUNT = 'gmail:pat';
  const letter = (opKey: string) => ({ id: 'l-1', createdByOp: opKey }) as LetterRecord;
  const ctx = (tasks: Record<string, Partial<Task>>): StillNeededContext => ({
    lang: 'en', now: NOW, task: async (id) => (tasks[id] ? { id, org_role: 'router', ...tasks[id] } as Task : undefined),
  });

  async function areas(at: string, file: Partial<RouterAreasFile>) {
    seedTaskStore(at);
    await updateRouterAreas(at, () => ({ version: 1, areas: [], routers: [], items: [], ...file }) as RouterAreasFile);
  }

  it('is a declared kind its op key finds, and settles only once the mailbox has an open router (a paused one counts)', async () => {
    const at = await home();
    const opKey = noRouterLetterOpKey(ACCOUNT, NOW);
    expect(kindOfLetter(letter(opKey))).toBe(MAIL_NO_ROUTER);

    // Unbound: kept.
    await areas(at, { areas: [{ id: 'mail', name: 'Mail', host: '__local__', taskIds: ['r-1'], sources: [] }], routers: [{ taskId: 'r-1', areaId: 'mail', paused: false }] });
    expect(await noRouterLetterSettleReason(letter(opKey), ctx({ 'r-1': { phase: 'IN_PROGRESS' } }), at)).toBeNull();

    // Bound to an area whose router is complete, or gone: kept.
    await areas(at, {
      areas: [{ id: 'mail', name: 'Mail', host: '__local__', taskIds: ['r-1'], sources: [{ kind: 'mail', account: ACCOUNT }] }],
      routers: [{ taskId: 'r-1', areaId: 'mail', paused: true }],
      accountBindings: [{ kind: 'mail', account: ACCOUNT, areaId: 'mail', boundAt: 1 }],
    });
    expect(await noRouterLetterSettleReason(letter(opKey), ctx({ 'r-1': { phase: 'COMPLETE' } }), at)).toBeNull();
    expect(await noRouterLetterSettleReason(letter(opKey), ctx({}), at)).toBeNull();

    // Reopened (still paused, as the person left it): settled, in the letter's language.
    expect(await noRouterLetterSettleReason(letter(opKey), ctx({ 'r-1': { phase: 'IN_PROGRESS', router_paused: true } }), at))
      .toBe('Not needed any more: a router reads this mailbox\'s new mail again.');
    // Another kind's letter is never read as this one.
    expect(await noRouterLetterSettleReason(letter('budget-paused:x'), ctx({ 'r-1': { phase: 'IN_PROGRESS' } }), at)).toBeNull();
  });
});
