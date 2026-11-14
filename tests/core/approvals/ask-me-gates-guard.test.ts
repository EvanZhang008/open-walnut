/**
 * Every place an agent's step waits for the person reads the one Approvals switch
 * (src/core/approvals/ask-me.ts; 2026-11-12, the user: "can we make this optional, and I want it
 * to be off by default don't need my approval for anything").
 *
 * The asks are found from the source: an approval card (`createApproval(`), a plugin's or Walnut's
 * letter (`letters.send(`, `sendLetter(`) and a refusal that wants the person's yes on screen
 * (`'human-approval-required'`). Each file holding one is listed below with how many it holds and
 * either reads the switch itself, has the file that calls it read it first, or is kept with why.
 * A new ask fails this test until it reads the switch or says why it stays.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { askMeOf } from '../../../src/core/approvals/ask-me';

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.join(ROOT, 'src');

/** Where an ask is made, in code (comments left out). */
const ASK = /\.createApproval\(|[^.\w]createApproval\(|letters\.send\(|sendLetter\(|'human-approval-required'/g;

/** Where the asks live and the files that define them, not asks of their own. */
const NOT_ASKS = new Set(['src/core/approvals/store.ts']);
const NOT_ASK_DIRS = ['src/core/human-inbox/'];

type Gate =
  | { asks: number; reads: 'self' }
  | { asks: number; readBy: string; why: string }
  | { asks: number; kept: string };

const GATES: Record<string, Gate> = {
  'src/web/routes/approvals-v1.ts': { asks: 1, kept: 'an explicit walnut approve or approval_request: the person put it there to be asked, so it always asks (2026-11-12)' },
  // Two: the built-in ask (it reads the switch) and a signed Git push (single-use, always asked, as the Git gate's is).
  'src/web/routes/test-host-fixture.ts': { asks: 2, reads: 'self' },
  'src/web/routes/browser-v1.ts': { asks: 1, kept: 'the site gate: only when the person set Browser extension to approved sites only, their own list of where agents may go (the outward steps and the fresh sign-in in this file read the switch)' },
  'src/core/browser-control/outward-asks.ts': { asks: 1, readBy: 'src/web/routes/browser-v1.ts', why: 'askIfHeld reads the switch before it calls askOutward' },
  'src/core/browser-control/fresh-sign-in.ts': { asks: 1, readBy: 'src/web/routes/browser-v1.ts', why: 'the fill_login route asks with unasked:true when the switch is off' },
  'src/core/router/handoff-approval.ts': { asks: 2, reads: 'self' },
  'src/core/vault/agent.ts': { asks: 1, reads: 'self' },
  'src/core/hosts/host-exec-grant.ts': { asks: 1, reads: 'self' },
  'src/integrations/mail/approvals.ts': { asks: 1, reads: 'self' },
  'src/integrations/mail/unsubscribe.ts': { asks: 1, reads: 'self' },
  'src/core/approvals/ask-me.ts': { asks: 2, kept: 'the off path itself (records an approved approval nobody was asked), and turning approvals off, which a device signs' },
  'src/core/approvals/keys.ts': { asks: 1, kept: 'a new signing device without its app\'s proof: the trust root of every signed approval' },
  'src/core/plugins/server-api.ts': { asks: 1, kept: 'a plugin\'s letters.send; the plugin reads letters.asksPerson() itself' },
  'src/integrations/mail/digest.ts': { asks: 1, kept: 'the mail digest the person set up: a report, not an ask' },
  'src/core/offline-merge/letter.ts': { asks: 1, kept: 'a review of what two Walnuts wrote while apart: a report, not an ask' },
  'src/web/routes/human-inbox-v1.ts': { asks: 1, kept: 'answering a plugin\'s letter is the person\'s own act' },
  'src/integrations/calendar/routes.ts': { asks: 3, kept: 'changing a meeting other people are in: the native helper shows its own confirmation on the Mac, and an agent is refused at once (it hides the event instead), so nothing waits' },
  'src/integrations/calendar/service.ts': { asks: 3, kept: 'the same protected calendar write, refused at once' },
  'src/core/calendar/sources/eventkit.ts': { asks: 2, kept: 'the same protected calendar write: the helper\'s confirmation dialog' },
};

function code(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line)).join('\n');
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path.relative(ROOT, full).split(path.sep).join('/'));
  }
  return out;
}

const recordsStep = (file: string) => /\brecordUnasked\??\.?\(|\bgoAheadUnasked\(|\bunasked\s*:\s*'/.test(code(file));
const readsSwitch = (file: string) => /\basksPerson\(|\.unasked\b|\bunasked\s*:/.test(code(file));

describe('every approval wait reads the Approvals switch', () => {
  const found: Record<string, number> = {};
  for (const file of sourceFiles(SRC)) {
    if (NOT_ASKS.has(file) || NOT_ASK_DIRS.some((d) => file.startsWith(d))) continue;
    const n = (code(file).match(ASK) ?? []).length;
    if (n) found[file] = n;
  }

  it('lists every file that asks the person, with its count', () => {
    const listed = Object.fromEntries(Object.entries(GATES).map(([f, g]) => [f, g.asks]));
    expect(found).toEqual(listed);
  });

  for (const [file, gate] of Object.entries(GATES)) {
    if ('reads' in gate) it(`${file} reads the switch`, () => expect(readsSwitch(file)).toBe(true));
    // What went ahead is listed where the person reads it afterwards (Settings, General).
    if ('reads' in gate) it(`${file} lists what goes ahead unasked`, () => expect(recordsStep(file)).toBe(true));
    if ('readBy' in gate) it(`${file} is read first by ${gate.readBy}`, () => expect(code(gate.readBy)).toMatch(/\basksPerson\(/));
  }

  it('the switch is off unless the person turned it on', () => {
    const none = {};
    expect(askMeOf(undefined, none)).toBe(false);
    expect(askMeOf({}, none)).toBe(false);
    expect(askMeOf({ approvals: {} }, none)).toBe(false);
    expect(askMeOf({ approvals: { ask_me: false } }, none)).toBe(false);
    expect(askMeOf({ approvals: { ask_me: true } }, none)).toBe(true);
    // The test setup's default asks; a stored value wins over it.
    expect(askMeOf({}, { WALNUT_APPROVALS_ASK: '1' })).toBe(true);
    expect(askMeOf({ approvals: { ask_me: false } }, { WALNUT_APPROVALS_ASK: '1' })).toBe(false);
  });
});
