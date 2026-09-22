/**
 * The `inbox-triage-batch` action: what it costs, when it refuses, and the exact
 * shape of the one line it hands the executor.
 *
 * The load-bearing assertion is the first one: ZERO model calls. This action runs
 * on the server's event loop before EVERY triage fire, including the ones that
 * turn out to be empty, and a model call here would be a second opinion in front
 * of the session that is supposed to be the opinion. A spy on sendMessage is the
 * only way to keep that true as the file grows.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

const sendMessage = vi.fn(async () => { throw new Error('the batch action must never call a model'); });
const sendMessageStream = vi.fn(async () => { throw new Error('the batch action must never call a model'); });

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/model/model.js', () => ({ sendMessage, sendMessageStream }));

import { WALNUT_HOME } from '../../src/constants.js';
import { saveConfig, getConfig } from '../../src/core/config-manager.js';
import { describe as describeAction, run } from '../../src/actions/inbox-triage-batch.js';
import { TRIAGE_ACTION_ID } from '../../src/core/triage/types.js';
import { TRIAGE_STATE_NOTE } from '../../src/core/triage/batch.js';
import {
  ackTriageClaim,
  loadTriageState,
  recordTriageArrivals,
  triageStatePath,
  type TriagePendingSlack,
} from '../../src/core/triage/state.js';

const ctx = { WALNUT_HOME, params: {} };

function slackRows(n: number): TriagePendingSlack[] {
  return Array.from({ length: n }, (_, i) => ({
    conversation: `#room-${i % 3}`,
    isDm: false,
    isMention: i === 0,
    alias: `person${i}`,
    ts: String(1_700_000_000 + i),
    permalink: `https://example.test/archives/C1/p${i}`,
    text: `line ${i}`,
    atMs: Date.now() - 1_000 + i,
  }));
}

/** Enable triage with an always-open window unless a test asks otherwise. */
async function configureTriage(overrides: Record<string, unknown> = {}): Promise<void> {
  const config = await getConfig();
  await saveConfig({
    ...config,
    triage: { enabled: true, every: '30m', every_messages: 20, sources: ['mail', 'slack'], active_hours: '', ...overrides },
  } as never);
}

beforeEach(async () => {
  sendMessage.mockClear();
  sendMessageStream.mockClear();
  await fs.rm(triageStatePath(), { force: true });
  await fs.rm(`${triageStatePath()}.lock`, { recursive: true, force: true });
  await fs.rm(path.join(WALNUT_HOME, 'notes', 'Walnut'), { recursive: true, force: true });
  await configureTriage();
});

describe('the action itself', () => {
  it('declares the id S12 already wrote into the routine', () => {
    const d = describeAction();
    expect(d.id).toBe(TRIAGE_ACTION_ID);
    expect(d.id).toBe('inbox-triage-batch');
    expect(d.name).toBeTruthy();
    expect(d.description.toLowerCase()).toContain('no model call');
  });

  it('makes ZERO model calls, even with a full buffer and a State.md to read', async () => {
    await recordTriageArrivals({
      mail: [{ accountId: 'work', count: 9, headlines: [{ from: 'a@b.test', subject: 'hi' }], atMs: Date.now() }],
      slack: slackRows(12),
    });
    const note = path.join(WALNUT_HOME, 'notes', TRIAGE_STATE_NOTE);
    await fs.mkdir(path.dirname(note), { recursive: true });
    await fs.writeFile(note, '---\nupdated: 2026-09-21T13:40Z\n---\n## Awaiting\n- rq-7\n', 'utf-8');

    const result = await run(ctx);
    expect(result.invoke).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendMessageStream).not.toHaveBeenCalled();
    expect(result.content).toContain('- rq-7');
  });

  it('hands back the count hint as the FIRST line, then one envelope', async () => {
    await recordTriageArrivals({
      mail: [{ accountId: 'work', count: 4, headlines: [], atMs: Date.now() }],
      slack: slackRows(3),
    });
    const result = await run(ctx);
    const lines = (result.content ?? '').split('\n');
    // The executor only scans the first few lines for this and then strips it.
    expect(lines[0]).toBe('WALNUT_TRIAGE_COUNT: 7');
    expect(lines[1]).toMatch(/^<walnut-message kind="trigger" from="Inbox Triage" note="batch · /);
    expect(result.content?.match(/<walnut-message /g)).toHaveLength(1);
  });

  it('the hint the action writes is the one the executor reads and removes', async () => {
    await recordTriageArrivals({ slack: slackRows(5) });
    const { content } = await run(ctx);
    const { readTriageCountHint, stripTriageCountHint } =
      await import('../../src/core/routines/executors/claude-code.js');
    expect(readTriageCountHint(content!)).toBe(5);
    const stripped = stripTriageCountHint(content!);
    expect(stripped).not.toContain('WALNUT_TRIAGE_COUNT');
    expect(stripped.startsWith('<walnut-message ')).toBe(true);
  });

  it('an empty buffer still produces a readable envelope, not an action stub', async () => {
    const result = await run(ctx);
    expect(result.invoke).toBe(true);
    expect(result.content).toContain('nothing new was reported');
    expect(result.content).not.toContain('completed with no output');
  });

  it('a missing State.md is a sentence, not a failure', async () => {
    const result = await run(ctx);
    expect(result.invoke).toBe(true);
    expect(result.content).toContain(`${TRIAGE_STATE_NOTE} does not exist yet`);
  });
});

describe('declining outside the active hours', () => {
  /** A window that cannot contain `now`, whatever the machine's clock says. */
  function closedWindow(nowMs = Date.now()): string {
    const hour = new Date(nowMs).getHours();
    const start = (hour + 2) % 24;
    const end = (hour + 3) % 24;
    const hh = (h: number) => String(h).padStart(2, '0');
    return `${hh(start)}:00-${hh(end)}:00`;
  }

  it('refuses the fire with status "skipped" and calls no model', async () => {
    await configureTriage({ active_hours: closedWindow() });
    await recordTriageArrivals({ slack: slackRows(4) });

    const result = await run(ctx);
    // 'skipped' is what stops the run BEFORE a session is minted — the whole
    // reason active hours are enforced in the init processor and nowhere else.
    expect(result.status).toBe('skipped');
    expect(result.invoke).toBe(false);
    expect(result.content).toContain('Outside the Inbox Triage active hours');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('claims nothing when it declines, so the items wait for the next window', async () => {
    await configureTriage({ active_hours: closedWindow() });
    await recordTriageArrivals({ slack: slackRows(4) });
    await run(ctx);

    const state = await loadTriageState();
    expect(state.claim).toBeUndefined();
    expect(state.pending.slack).toHaveLength(4);
    expect(state.sinceMs).toBeUndefined();
  });

  it('an empty active_hours window means 24/7 and always runs', async () => {
    await configureTriage({ active_hours: '' });
    expect((await run(ctx)).invoke).toBe(true);
  });
});

describe('the buffer across two runs', () => {
  it('a second run redelivers until the first is acknowledged', async () => {
    await recordTriageArrivals({ slack: slackRows(3) });
    const first = await run(ctx);
    expect(first.content).toContain('line 0');
    expect(first.content).not.toContain('already handed to a run that never started');

    const again = await run(ctx);
    expect(again.content).toContain('line 0');
    expect(again.content).toContain('already handed to a run that never started');
  });

  it('after an acknowledgement the next run only sees what arrived since', async () => {
    await recordTriageArrivals({ slack: slackRows(3) });
    await run(ctx);
    const claimAtMs = (await loadTriageState()).claim!.atMs;
    await ackTriageClaim(claimAtMs);

    await recordTriageArrivals({
      mail: [{ accountId: 'work', count: 2, headlines: [], atMs: Date.now() }],
    });
    const next = await run(ctx);
    expect(next.content).not.toContain('line 0');
    expect(next.content).toContain('WALNUT_TRIAGE_COUNT: 2');
    expect(next.content).toContain(`Everything newer than ${new Date(claimAtMs).toISOString()}`);
  });

  it('honours sources: a mail-only config never shows the Slack block', async () => {
    await configureTriage({ sources: ['mail'] });
    await recordTriageArrivals({ slack: slackRows(2) });
    const result = await run(ctx);
    expect(result.content).not.toContain('Slack —');
    expect(result.content).toContain('Mail —');
  });
});
