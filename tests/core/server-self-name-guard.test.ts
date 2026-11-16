/**
 * Words a person reads never call a Demo, or a normal install, a "test server" (2026-11-10
 * review: a new user trying the Demo read "inherited_session: this test server did not start
 * session ..."). A developer's throwaway server (`bun run dev:ephemeral`) and the Demo run on
 * the same isolation, so a sentence written for one reaches the other.
 *
 * Every line of code in src/ and web/src/ that says "test server" (comments and log lines
 * aside) is counted per file and must be listed in KNOWN with why a Demo user never reads it,
 * or say it through server-self-name.ts / an IS_DEMO branch. A new one fails until it does.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { thisServer, ThisServer } from '../../src/core/server-self-name.js';
import { InheritedSessionRefusedError, inheritedSessionText } from '../../src/providers/ephemeral-session-gate.js';
import { classifyDeliveryFailure } from '../../src/providers/delivery-failure.js';

const ROOT = path.resolve(__dirname, '../..');

const KNOWN: Record<string, { count: number; why: string }> = {
  'src/core/server-self-name.ts': { count: 1, why: 'the helper itself: "this test server" only when not the Demo' },
  'src/core/net/net-mac.ts': { count: 1, why: 'an IS_DEMO branch: the Demo reads "not in the Demo"' },
  'src/core/plugin-jobs/index.ts': { count: 1, why: 'an IS_DEMO branch: the Demo reads "plugin jobs do not run in the Demo"' },
  'src/core/sessions/host-connect-hint.ts': { count: 1, why: 'an IS_DEMO branch: the Demo reads its own sentence' },
  'src/core/hosts/host-problem.ts': {
    count: 3,
    why: 'the "off" host labels: a Demo host is never off (demo-remote-host.ts lifts it) except while the Demo stops',
  },
  'src/providers/remote-isolation.ts': {
    count: 3,
    why: 'the isolated root guard and the `ephemeral server:` connect errors, classified to the `ephemeral` kind before a person reads them (host-connect-hint.ts)',
  },
  'src/providers/daemon-connection.ts': {
    count: 4,
    why: 'refusals of a read-only test server (relays, an off host): the Demo has its own isolated daemons, never attached read only',
  },
  'src/providers/daemon-net-update.ts': { count: 1, why: 'a skip reason for logs; a Demo host is not a host-network member' },
  'src/providers/acp-session.ts': { count: 1, why: 'readOnlyRemote only: the Demo\'s hosts run its own isolated daemon' },
  'src/providers/daemon-source.ts': {
    count: 2,
    why: 'daemon twins: session_other_walnut is mapped to delivery-failure.ts words (thisServer) before a person reads it; the other refuses a developer\'s misconfigured start',
  },
  'src/providers/daemon-standalone.ts': { count: 2, why: 'the twin of daemon-source.ts, same two lines' },
  'src/providers/ephemeral-session-gate.ts': {
    count: 2,
    why: 'the developer-only wording of the inherited-session refusal (the Demo has its own) and a Playwright fixture guard',
  },
  'src/providers/pattern-kill-guard-hook.ts': { count: 1, why: 'a hook message to an agent about other sessions\' test servers' },
  'src/providers/daemon-update-behind.ts': { count: 1, why: 'a `why` in DAEMON_UPDATE_STOPS, read only by its ratchet test' },
  'src/commands/web-ephemeral.ts': { count: 1, why: 'the developer launcher (`bun run dev:ephemeral`) child\'s idle exit reason on its stderr; the Demo runs demo-server.ts, never this launcher' },
  'src/commands/ephemeral-slots.ts': { count: 1, why: 'the developer launcher\'s slot wait lines (WALNUT_EPHEMERAL_MAX); the Demo takes no ephemeral slot' },
  'web/src/components/first-run/first-run-model.ts': {
    count: 1,
    why: 'the "off" host words of the first-run list: as host-problem.ts, a Demo host is never off (demo-remote-host.ts lifts it) except while the Demo stops',
  },
  'web/src/components/settings/sections/useLinkedHostRow.tsx': { count: 1, why: 'an isDemoOrigin branch: the Demo reads its own tooltip' },
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...sources(full)); }
    else if (/\.(ts|tsx|mjs|cjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** "test server" lines per file, outside comments and log calls. */
function countLines(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of [...sources(path.join(ROOT, 'src')), ...sources(path.join(ROOT, 'web/src'))]) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/test server/i.test(text)) continue;
    let inBlock = false;
    for (const raw of text.split('\n')) {
      let line = raw;
      if (inBlock) {
        const end = line.indexOf('*/');
        if (end < 0) continue;
        line = line.slice(end + 2);
        inBlock = false;
      }
      line = line.replace(/\/\*[\s\S]*?\*\//g, '');
      const open = line.indexOf('/*');
      if (open >= 0 && !/['"`][^'"`]*\/\*/.test(line)) { line = line.slice(0, open); inBlock = true; }
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*')) continue;
      const code = line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1');
      if (!/test server/i.test(code)) continue;
      if (/\blog(?:\.\w+)+\(|\blogMsg\(|console\.\w+\(/.test(code)) continue;
      const rel = path.relative(ROOT, file);
      counts[rel] = (counts[rel] ?? 0) + 1;
    }
  }
  return counts;
}

describe('no "test server" words for a Demo or a normal install', () => {
  it('every line that says it is known, with why a Demo user never reads it', () => {
    const counts = countLines();
    const unknown = Object.entries(counts).filter(([f, n]) => KNOWN[f]?.count !== n).map(([f, n]) => `${f}: ${n} (known ${KNOWN[f]?.count ?? 0})`);
    expect(unknown, 'a new user-facing "test server": say it with thisServer() or an IS_DEMO branch, or list it with why').toEqual([]);
    const gone = Object.keys(KNOWN).filter((f) => !counts[f]);
    expect(gone, 'a listed file no longer says it: drop it from KNOWN').toEqual([]);
  });

  it('the Demo calls itself the Demo', () => {
    expect(thisServer(true)).toBe('this Demo');
    expect(ThisServer(true)).toBe('This Demo');
    expect(thisServer(false)).toBe('this test server');
  });

  it('the inherited-session refusal reads plainly: no code, no "test server" in the Demo', () => {
    const demo = inheritedSessionText('501afb78-0000-4000-8000-000000000000', true);
    expect(demo).not.toMatch(/test server|inherited_session|501afb78/);
    expect(inheritedSessionText('s1', false)).toBe('This test server did not start session s1; start a new session instead.');
    expect(new InheritedSessionRefusedError('s1', 'start').message).not.toMatch(/^inherited_session:/);
  });

  it('a parked row never shows the raw code, old wording or new', () => {
    for (const err of [
      new InheritedSessionRefusedError('s1', 'start'),
      new Error(inheritedSessionText('s1', true)),
      new Error(inheritedSessionText('s1', false)),
      new Error('inherited_session: this test server did not start session s1; start a new session instead.'),
    ]) {
      const v = classifyDeliveryFailure(err);
      expect(v, err.message).toMatchObject({ kind: 'permanent', code: 'inherited_session' });
      expect(v.reason).not.toMatch(/^[a-z]+_[a-z_]+:/);
    }
  });
});
