/**
 * GUARD: a mail arrival never lands in the Inbox Triage state or in a triage batch again.
 *
 * Decided 2026-11-14 (Evan): "my architecture is mailbox straight to the router... the router
 * itself does the triage, why open a separate triage?" Every mailbox is bound to a mail router,
 * which owns each new mail end to end (src/integrations/mail/router-intake.ts). Until that day the
 * old hourly batch also read mail ("Triage · 20:13 · 4 items" tasks in "Ask Inbox Triage"), so the
 * same mail was handled twice. If this file fails, mail has found its way back into the old batch:
 * remove that path, do not loosen the test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('triage-no-mail'));

import { WALNUT_HOME } from '../../src/constants.js';
import { bus } from '../../src/core/event-bus.js';
import { saveConfig, getConfig } from '../../src/core/config-manager.js';
import { startTriageCollect, type TriageCollectHandle } from '../../src/core/triage/collect.js';
import { readTriageConfig } from '../../src/core/triage/config.js';
import { claimTriageBatch, loadTriageState, triageStatePath } from '../../src/core/triage/state.js';
import { TRIAGE_SOURCES, TRIAGE_WAKE_EVENTS } from '../../src/core/triage/types.js';
import { run } from '../../src/actions/inbox-triage-batch.js';

const MAIL_EVENT = 'plugin:mail:messages-received';
const SUBJECT = 'Canary-mail-subject-4b1e';
const SENDER = 'canary-sender@mail.test';

/** The production config of 2026-11-14 with Slack added back, so triage is on and mail is still listed. */
const OLD_CONFIG = { enabled: true, every: '1h', sources: ['mail', 'slack'], auto_mark_read: true, active_hours: '' };

function mailArrival() {
  return { accountId: 'work', count: 1, headlines: [{ from: SENDER, subject: SUBJECT, messageId: 'INBOX:1' }] };
}

async function writeOldStateFile(): Promise<void> {
  // What an older build left on disk: buffered mail rows, a mail drop count and a claim counting mail.
  await fs.mkdir(path.dirname(triageStatePath()), { recursive: true });
  await fs.writeFile(triageStatePath(), JSON.stringify({
    version: 1,
    runs: 3,
    pending: {
      mail: [{ ...mailArrival(), atMs: 5 }],
      slack: [],
      droppedMail: 2,
      droppedSlack: 0,
    },
  }), 'utf-8');
}

let collector: TriageCollectHandle | null = null;

beforeEach(async () => {
  await fs.rm(triageStatePath(), { force: true });
  await fs.rm(`${triageStatePath()}.lock`, { recursive: true, force: true });
  const config = await getConfig();
  await saveConfig({ ...config, triage: OLD_CONFIG } as never);
});

afterEach(() => {
  collector?.stop();
  collector = null;
});

describe('mail is not an Inbox Triage source (2026-11-14: the mail router owns mail)', () => {
  it('the source list, the wake events and an old config that lists mail all leave it out', () => {
    expect(TRIAGE_SOURCES).not.toContain('mail' as never);
    expect(Object.values(TRIAGE_WAKE_EVENTS)).not.toContain(MAIL_EVENT);
    const resolved = readTriageConfig({ triage: OLD_CONFIG as never });
    expect(resolved.sources).toEqual(['slack']);
    expect(resolved.wakeEvents).not.toContain(MAIL_EVENT);
  });

  it('the collector is never even woken by a mail arrival, and records nothing for it', async () => {
    const record = vi.fn(async () => ({}) as never);
    collector = startTriageCollect({
      allowReplica: true,
      flushMs: 60_000,
      record,
      getConfig: async () => ({ triage: OLD_CONFIG as never }),
    });
    bus.emit(MAIL_EVENT, mailArrival(), ['web-ui']);
    await collector.flush();
    expect(collector.stats().handled).toBe(0);
    expect(record).not.toHaveBeenCalled();

    // Slack still flows, through the same collector.
    bus.emit('plugin:slack:messages-received', {
      count: 1, dropped: 0,
      items: [{ conversation: '#c', isDm: false, isMention: false, alias: 'a', ts: '1', permalink: '', text: 'hello' }],
    }, ['web-ui']);
    await collector.flush();
    expect(collector.stats().handled).toBe(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(record.mock.calls[0])).not.toContain(SUBJECT);
  });

  it('a mail arrival never lands in triage-state.json, through the real collector and file', async () => {
    collector = startTriageCollect({ allowReplica: true, flushMs: 60_000 });
    bus.emit(MAIL_EVENT, mailArrival(), ['web-ui']);
    await collector.flush();
    const raw = await fs.readFile(triageStatePath(), 'utf-8').catch(() => '');
    expect(raw).not.toContain(SUBJECT);
    expect(raw).not.toContain(SENDER);
  });

  it('mail rows an older build buffered are dropped when read and never claimed', async () => {
    await writeOldStateFile();
    const state = await loadTriageState();
    expect(state.pending).toEqual({ slack: [], droppedSlack: 0 });
    const claimed = await claimTriageBatch(Date.now());
    expect(JSON.stringify(claimed)).not.toContain(SUBJECT);
    expect(claimed.claim).not.toHaveProperty('mail');
  });

  it('a triage batch built over that old file carries no mail at all', async () => {
    await writeOldStateFile();
    const result = await run({ WALNUT_HOME, params: {} });
    expect(result.invoke).toBe(true);
    const content = result.content ?? '';
    expect(content.split('\n')[0]).toBe('WALNUT_TRIAGE_COUNT: 0');
    expect(content).not.toContain(SUBJECT);
    expect(content).not.toContain(SENDER);
    expect(content).not.toContain('Mail —');
    expect(content).not.toContain('mail_list');
    // The next write leaves the old rows out of the file too.
    expect(await fs.readFile(triageStatePath(), 'utf-8')).not.toContain(SUBJECT);
  });

  it('the mail-only production config runs no batch: skipped, so no run task is made', async () => {
    const config = await getConfig();
    await saveConfig({ ...config, triage: { ...OLD_CONFIG, sources: ['mail'] } } as never);
    await writeOldStateFile();
    const result = await run({ WALNUT_HOME, params: {} });
    expect(result.invoke).toBe(false);
    expect(result.status).toBe('skipped');
    expect(result.content ?? '').not.toContain(SUBJECT);
  });
});
