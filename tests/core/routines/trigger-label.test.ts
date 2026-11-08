/**
 * A trigger's name is a short label, never its prompt's opening words.
 *
 * 2026-11-06: trigger mw4cbqgj-bcdc was named "The session-cookie-watch check
 * fired. Never print cookie..." because the name was cut from its prompt; a
 * task's waiting line copied it and its lead read it as "the cookie was deleted
 * again", which was false. Every surface (waiting line, trigger card,
 * trigger_list, Routines, notices) reads `job.name`, so the class is closed
 * where a name is made and where it is stored: these tests cover every maker
 * (trigger_create, a routine created with a check, a host creating one while
 * the server is away, the store's one write point, old stored names), and a
 * source scan fails when a new file cuts a name out of a prompt again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../../src/constants.js';
import { createTriggerLabel } from '../../../src/core/routines/trigger-label.js';
import { ensureLoaded, persist, relabelTrigger } from '../../../src/core/cron/store.js';
import { normalizeCronJobCreate } from '../../../src/core/cron/normalize.js';
import type { CronJob, CronServiceState, CronStoreFile } from '../../../src/core/cron/types.js';

const L = createTriggerLabel();

/** Display columns: a CJK character takes two (the labeller's own measure). */
function cols(s: string): number {
  let n = 0;
  for (const ch of s) n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return n;
}

// The real trigger's words (CJK test data as escapes).
const COOKIE = {
  name: 'The session-cookie-watch check fired. Never print cookie...',
  prompt: 'The session-cookie-watch check fired. Never print cookie values or any session token. Read the items: each says what happened.',
  description: '\u6BCF 5 \u5206\u949F\u68C0\u67E5 devbox \u4E0A ~/.app/cookie \u91CC\u7684 app session\uFF1A'
    + '\u5728\u5C31\u5907\u4EFD\u90A3\u51E0\u884C\uFF080600\uFF09\uFF1B\u88AB\u51B2\u6389\u4E14\u5907\u4EFD\u6CA1\u8FC7\u671F',
  run: 'python3 -I ~/.open-walnut/triggers/session-cookie-watch/check.py',
};

describe('the label', () => {
  it('the cookie trigger: a name cut from its prompt becomes a label from its description', () => {
    expect(L.isFromPrompt(COOKIE.name, COOKIE.prompt)).toBe(true);
    const label = L.label(COOKIE);
    expect(label).not.toMatch(/fired|Never print/);
    expect(label).toContain('~/.app/cookie');
    // The cadence is the card's own line, not the label's.
    expect(label).not.toContain('5 \u5206\u949F');
    expect(cols(label)).toBeLessThanOrEqual(L.max);
  });

  it('keeps the author\'s own label, and cuts one past 60 columns at a word', () => {
    expect(L.label({ name: 'PR 123 review comments', prompt: 'Read each new comment.', description: 'Checks PR 123.' })).toBe('PR 123 review comments');
    // As written: no trailing word or mark is taken off a label that fits.
    expect(L.label({ name: 'Is CI green?', prompt: 'Read the run.', description: 'd' })).toBe('Is CI green?');
    // A template's label opens no prompt: it stays.
    expect(L.label({ name: 'Slack #eng-oncall', prompt: 'Slack #eng-oncall has new messages', description: 'x' })).toBe('Slack #eng-oncall');
    const long = L.label({ name: 'A very long label that someone wrote for this trigger to describe everything it does', description: 'd' });
    expect(cols(long)).toBeLessThanOrEqual(60);
    expect('A very long label that someone wrote for this trigger to describe everything it does'.startsWith(long)).toBe(true);
    expect(long).not.toMatch(/\s(?:to|for|the)$/);
  });

  it('tells every way Walnut used to cut a name from a prompt', () => {
    const prompt = 'done.txt has appeared in the watched demo folder, read it and report its first line to the user';
    // trigger_create: 60 at a word, "..."; cron normalize: 40 flat, "..."; older: a "Trigger: " prefix.
    expect(L.isFromPrompt('done.txt has appeared in the watched demo folder, read it...', prompt)).toBe(true);
    expect(L.isFromPrompt(`${prompt.slice(0, 40)}...`, prompt)).toBe(true);
    expect(L.isFromPrompt('Trigger: done.txt has appeared in the watched...', prompt)).toBe(true);
    expect(L.isFromPrompt('Read each new comment.', 'Read each new comment.')).toBe(true);
    // A short own label that happens to open the prompt is the author's.
    expect(L.isFromPrompt('PR-4821 watch', 'PR-4821 watch fired: read the item.')).toBe(false);
    expect(L.isFromPrompt('PR watch', prompt)).toBe(false);
    // However long, a label with no "..." that is not the whole prompt is the author's (review, 2026-11-07).
    expect(L.isFromPrompt('PR 123 review comments watcher', 'PR 123 review comments watcher fired: read each one.')).toBe(false);
  });

  it('names what is watched from the description\'s first clause, without the cadence or brackets', () => {
    expect(L.fromDescription('Checks PR 123 for new review comments every 5 minutes. When one arrives, the session replies on the PR.'))
      .toBe('Checks PR 123 for new review comments');
    expect(L.fromDescription('Checks PR 4821 (the cache refactor) every 30 minutes for new review comments, failed analyzers, approval.'))
      .toBe('Checks PR 4821 for new review comments');
    // A clause too short to name anything takes the next one with it.
    expect(L.fromDescription('Fires hourly; the session posts the community round.')).toBe('Fires; the session posts the community round');
    // A clause or sentence joined back keeps its own separator.
    expect(L.fromDescription('Waits until PR-4930 is merged.')).toBe('Waits until PR-4930 is merged');
    expect(L.fromDescription('Asks Mr. Gray for the signed contract, then files it.')).toBe('Asks Mr. Gray for the signed contract');
    // "check once" left by the cadence keeps only the verb.
    expect(L.fromDescription('\u6BCF 10 \u5206\u949F\u67E5\u4E00\u6B21 PR-4930\u3002')).toBe('\u67E5 PR-4930');
  });

  it('never ends inside an id or a word, and never on a dangling word', () => {
    const id = 'ce39140c-9661-5e83-ad47-27c8912bd8bf';
    const label = L.fromDescription(`\u6BCF 5 \u5206\u949F\u67E5 devbox \u4E0A Mac \u961F\u5217\u91CC\u4EFB\u52A1 ${id} \u7684\u8BF7\u6C42`);
    expect(cols(label)).toBeLessThanOrEqual(L.max);
    expect(label.includes(id) || !/[0-9a-f]-?$/.test(label)).toBe(true);
    // A long path with no space is cut at a "/", never down to the bare verb.
    const path_ = L.fromDescription('\u6BCF 30 \u5206\u949F\u68C0\u67E5 /Users/someone/launch-kit/list-prs/watch.txt \u91CC\u6240\u6709\u63D0\u4EA4\u3002');
    expect(path_).toBe('\u68C0\u67E5 /Users/someone/launch-kit/list-prs');
    const english = L.fromDescription('Checks whether the new pricing page has reached every store region and the signup form still works.');
    expect(cols(english)).toBeLessThanOrEqual(L.max);
    expect(english).not.toMatch(/\s(?:the|of|has|and)$/);
  });

  it('with no description, the check script\'s name; with nothing, never empty', () => {
    expect(L.label({ name: COOKIE.name, prompt: COOKIE.prompt, run: COOKIE.run })).toBe('session-cookie-watch');
    expect(L.label({ run: 'bash ~/.open-walnut/triggers/pr-comments/poll-pr.sh' })).toBe('poll-pr');
    expect(L.label({})).toBe('Unnamed trigger');
  });

  it('rebuilds from its own source, as the host daemon\'s inlined twin does', () => {
    const rebuilt = new Function(`return (${createTriggerLabel.toString()})`)()() as typeof L;
    expect(rebuilt.label(COOKIE)).toBe(L.label(COOKIE));
    expect(rebuilt.isFromPrompt(COOKIE.name, COOKIE.prompt)).toBe(true);
  });
});

// \u2500\u2500 Where names are made and stored \u2500\u2500

function trigger(over: Partial<CronJob> & Record<string, unknown> = {}): CronJob {
  return {
    id: 'mtrig-0001', name: COOKIE.name, description: COOKIE.description, enabled: true,
    createdAtMs: 0, updatedAtMs: 0,
    schedule: { kind: 'every', everyMs: 300_000, anchorMs: 0 },
    sessionTarget: 'isolated', wakeMode: 'now',
    payload: { kind: 'agentTurn', message: COOKIE.prompt },
    executor: { type: 'session', config: { target: 'mtask-1', prompt: COOKIE.prompt } },
    check: { run: COOKIE.run, host: 'local' },
    state: {},
    ...over,
  } as unknown as CronJob;
}

function makeState(storePath: string): CronServiceState {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() };
  return {
    deps: { nowMs: () => 0, log, storePath, cronEnabled: false, broadcastCronNotification: vi.fn(), runMainAgentWithPrompt: vi.fn(), runIsolatedAgentJob: vi.fn(), onEvent: vi.fn() },
    store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
  } as unknown as CronServiceState;
}

describe('stored trigger names', () => {
  let storePath: string;
  beforeEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
    storePath = path.join(WALNUT_HOME, 'cron', 'cron-jobs.json');
    await fs.mkdir(path.dirname(storePath), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  it('an old trigger named from its prompt gets its label on load, written once, and keeps it', async () => {
    const own = trigger({ id: 'mtrig-0002', name: 'Inbox watch: new replies' });
    // A routine with no check is no trigger: its name is the user's.
    const routine = trigger({ id: 'mtrig-0003', check: undefined });
    const { state: _a, ...a } = trigger();
    const { state: _b, ...b } = own;
    const { state: _c, ...c } = routine;
    await fs.writeFile(storePath, JSON.stringify({ version: 2, jobs: [a, b, c] }));

    const state = makeState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    const names = state.store!.jobs.map((j) => j.name);
    expect(names[0]).toBe(L.label(COOKIE));
    expect(names.slice(1)).toEqual(['Inbox watch: new replies', COOKIE.name]);
    const onDisk = JSON.parse(await fs.readFile(storePath, 'utf-8')) as CronStoreFile;
    expect(onDisk.jobs.map((j) => j.name)).toEqual(names);

    // A second load finds nothing to change.
    const again = makeState(storePath);
    await ensureLoaded(again, { skipRecompute: true });
    expect(again.store!.jobs.map((j) => j.name)).toEqual(names);
    expect(relabelTrigger(again.store!.jobs[0])).toBe(false);
  });

  it('the one write point stores no prompt opening as a name, whichever path put it there', async () => {
    const state = makeState(storePath);
    state.store = { version: 2, jobs: [trigger()] };
    await persist(state);
    const onDisk = JSON.parse(await fs.readFile(storePath, 'utf-8')) as CronStoreFile;
    expect(onDisk.jobs[0].name).toBe(L.label(COOKIE));
  });

  it('a routine created with a check and no name is named from its description, not its prompt', () => {
    const created = normalizeCronJobCreate({
      description: 'Checks PR 123 for new review comments every 5 minutes.',
      schedule: { kind: 'every', everyMs: 300_000 },
      check: { run: 'bash ~/.open-walnut/triggers/pr/check.sh' },
      executor: { type: 'session', config: { target: 'mtask-1', prompt: 'A new comment arrived. Read it and reply.' } },
    }) as { name?: string } | null;
    expect(created?.name).toBe('Checks PR 123 for new review comments');
  });
});

// \u2500\u2500 The class: no source cuts a trigger's name out of its prompt again \u2500\u2500

describe('no surface names a trigger from its prompt', () => {
  const ROOT = path.resolve(import.meta.dirname, '../../..');

  async function sources(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') out.push(...await sources(full)); }
      else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  // A name (or title/label) built from a prompt-like text: `name = prompt...slice(`, `title: flat.slice(0, 60)`.
  const NAME_FROM_PROMPT = /\b(?:name|title|label)\b\s*[:=][^\n;]*\b(?:prompt\w*|instructions|flat)\b[^\n;]*\.(?:slice|substring|substr)\(/i;
  // Text cut and marked with an ellipsis: how both old namers ended (`${cut}...`, `x.slice(0, 40) + '...'`).
  const ELLIPSIS_CUT = /\.slice\(0,\s*\w+\)[^\n]*(?:'\.\.\.'|"\.\.\."|\.\.\.`|\\u2026|\u2026)|\}\.\.\.`/;
  // Where triggers are made, listed and told about: no ellipsis cut there names one.
  const TRIGGER_SCOPE = ['src/core/routines', 'src/core/cron', 'src/ops/triggers.ts', 'src/providers/offline-host-core.ts', 'src/web/routes/routines-v1.ts', 'web/src/components/routines'];
  const ALLOWED = new Map([
    // A scheduled routine with no check (not a trigger) is still named from its payload text.
    ['src/core/cron/normalize.ts', 'content.slice(0, 40)'],
    // An error text and a task title in a trouble notice, never a trigger's name.
    ['src/core/routines/trigger-health.ts', 'text.slice(0, max)'],
  ]);

  function scan(file: string, text: string, inScope: boolean): string[] {
    const hits: string[] = [];
    text.split('\n').forEach((line, i) => {
      const allowed = ALLOWED.get(file);
      if (allowed && line.includes(allowed)) return;
      if (/\bdefaultTriggerName\b/.test(line) || NAME_FROM_PROMPT.test(line) || (inScope && ELLIPSIS_CUT.test(line))) {
        hits.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    });
    return hits;
  }

  it('the scan flags both ways Walnut used to name a trigger from its prompt', () => {
    // trigger-api.ts and offline-host-core.ts before labels (2026-11-07).
    expect(scan('src/core/routines/trigger-api.ts', 'return `${atWord > max / 2 ? cut.slice(0, atWord) : cut}...`;', true)).toHaveLength(1);
    expect(scan('src/providers/offline-host-core.ts', '        name = `${atWord > 30 ? cut.slice(0, atWord) : cut}...`', true)).toHaveLength(1);
    expect(scan('web/src/x.tsx', 'const title = promptOf(job).slice(0, 60)', false)).toHaveLength(1);
  });

  it('no code under src/ or web/src/ makes a trigger or routine name by cutting a prompt', async () => {
    const files = [...await sources(path.join(ROOT, 'src')), ...await sources(path.join(ROOT, 'web/src'))];
    const hits: string[] = [];
    for (const full of files) {
      const file = path.relative(ROOT, full);
      hits.push(...scan(file, await fs.readFile(full, 'utf-8'), TRIGGER_SCOPE.some((p) => file === p || file.startsWith(`${p}/`))));
    }
    expect(hits, 'a trigger is named by trigger-label.ts (createTriggerLabel), never from its prompt').toEqual([]);
  });

  it('every place that names a new trigger goes through the labeller', async () => {
    const makers = [
      'src/core/routines/trigger-api.ts',
      'src/core/cron/normalize.ts',
      'src/core/cron/store.ts',
      'src/providers/offline-host-core.ts',
      'src/providers/daemon-standalone.ts',
      'src/providers/daemon-source.ts',
    ];
    for (const file of makers) {
      expect(await fs.readFile(path.join(ROOT, file), 'utf-8'), file).toMatch(/createTriggerLabel|deps\.labels/);
    }
  });
});
