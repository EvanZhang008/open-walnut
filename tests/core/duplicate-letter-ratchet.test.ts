/**
 * Every path that writes a letter or a thread reply is decided for the duplicate check
 * (core/human-inbox/duplicate-letter.ts; 2026-11-02 org review: a lead's repeats reached the
 * user's phone five times in a minute). A session's letter goes through sendLetterAsCallerOnce,
 * which refuses a repeat and asks the store to check again under its lock; a session's thread
 * reply passes `refuseDuplicate: true` to agentReply. Every other writer is Walnut's own or a
 * plugin's, listed here with why it is not a session repeating itself.
 *
 * A new file that calls the store's writers fails here until it is added below with its decision.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/** Files that send a session's letter through the guarded entry point. */
const GUARDED_SENDS: Record<string, string> = {
  'src/web/routes/human-inbox-v1.ts': 'POST /human-inbox, the op human_inbox_send',
  'src/core/human-inbox/relay.ts': 'the cloud replica\'s send, the same op through the bridge',
  'src/core/offline-merge/apply-letter.ts': 'a host\'s journal replay (opKey): never refused, by design',
};

/** Files that call the store's letter writers (sendLetter, sendLetterOnce) directly. */
const DIRECT_SENDS: Record<string, string> = {
  'src/core/human-inbox/store.ts': 'the store itself',
  'src/core/human-inbox/letter-ops.ts': 'the guarded entry point (passes refuseDuplicate)',
  'src/core/org/morning-report.ts': 'Walnut\'s scheduled report in a node\'s name, sent by its clock, not the session',
  'src/core/plugins/server-api.ts': 'a plugin\'s letter (pluginId), the plugin owns its asks',
  'src/core/offline-merge/letter.ts': 'Walnut\'s drain conflict letter, external sender, once per drain',
  'src/core/usage/session-budget.ts': 'Walnut\'s budget notice, once by opKey',
  'src/core/hosts/host-exec.ts': 'Walnut\'s host grant ask, external sender',
  'src/core/hosts/host-auth-alert.ts': 'Walnut\'s sign-in alert, once by opKey',
  'src/core/hosts/local-network-alert.ts': 'Walnut\'s local network alert, once by opKey',
  'src/integrations/git-sync-secrets.ts': 'Walnut\'s secret-held notice, once by opKey',
};

/** Files that append an agent turn (agentReply), and whether a session's repeat is refused there. */
const REPLIES: Record<string, 'guarded' | string> = {
  'src/web/routes/human-inbox-v1.ts': 'guarded',
  'src/core/human-inbox/relay.ts': 'guarded',
  'src/core/human-inbox/away-thread.ts': 'a fold of a session\'s send: guarded when the send is (refuseDuplicate from the caller)',
  'src/core/plugins/server-api.ts': 'a plugin\'s reply in its own letter',
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(rel));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(rel);
  }
  return out;
}

const files = sources('src').map((f) => ({ f, text: fs.readFileSync(path.join(ROOT, f), 'utf8') }));
const calling = (re: RegExp) => files.filter(({ text }) => re.test(text)).map(({ f }) => f).sort();
/** Found files not listed. A listed file that stopped calling is fine (another change may remove one). */
const unlisted = (found: string[], listed: Record<string, string>) => found.filter((f) => !(f in listed));
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('duplicate letters: every writer is decided', () => {
  it('every caller of the guarded send is listed', () => {
    const found = calling(/\bsendLetterAsCaller(Once)?\s*\(/).filter((f) => f !== 'src/core/human-inbox/letter-ops.ts');
    expect(unlisted(found, GUARDED_SENDS), 'A new path sends a session\'s letter: add it to GUARDED_SENDS').toEqual([]);
    expect(found).toEqual(expect.arrayContaining(['src/web/routes/human-inbox-v1.ts', 'src/core/human-inbox/relay.ts']));
  });

  it('every direct letter write is listed with why it is not a session\'s repeat', () => {
    const found = calling(/(?<![\w.])sendLetter(Once)?\s*\(|\bstore\.sendLetter(Once)?\s*\(/);
    expect(unlisted(found, DIRECT_SENDS),
      'A new direct letter write: send a session\'s letter through sendLetterAsCallerOnce, or add it to DIRECT_SENDS with why').toEqual([]);
    expect(found).toContain('src/core/plugins/server-api.ts');
  });

  it('every agent reply is listed, and the session paths refuse a repeat', () => {
    const found = calling(/\bagentReply\s*\(/).filter((f) => f !== 'src/core/human-inbox/store.ts');
    expect(unlisted(found, REPLIES), 'A new agent reply path: pass refuseDuplicate for a session\'s reply, or add it to REPLIES with why').toEqual([]);
    expect(found).toEqual(expect.arrayContaining(['src/web/routes/human-inbox-v1.ts', 'src/core/human-inbox/relay.ts']));
    for (const [f, how] of Object.entries(REPLIES)) {
      if (how !== 'guarded') continue;
      const calls = read(f).split('\n').filter((l) => /\bagentReply\s*\(/.test(l) && !/import|\/\//.test(l.trim().slice(0, 8)));
      expect(calls.length, f).toBeGreaterThan(0);
      for (const line of calls) expect(line, `${f}: a session's reply must pass refuseDuplicate`).toMatch(/refuseDuplicate:\s*true/);
    }
  });

  it('the guarded send checks before and under the store lock, and journal replays pass', () => {
    const ops = read('src/core/human-inbox/letter-ops.ts');
    expect(ops).toMatch(/const guarded = !opts\.opKey && !resendReason && senderKey\(sender\) !== null/);
    expect(ops).toMatch(/if \(guarded\) opts = \{ \.\.\.opts, refuseDuplicate: true \}/);
    const store = read('src/core/human-inbox/store.ts');
    expect(store).toMatch(/if \(opts\.refuseDuplicate && !opKey\) \{[\s\S]{0,200}findDuplicateLetter\(record, store\.letters/);
    expect(store).toMatch(/if \(opts\.refuseDuplicate\) \{[\s\S]{0,200}findDuplicateReply\(letter/);
  });
});
