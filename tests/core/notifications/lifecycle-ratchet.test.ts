import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lifecycle ratchet: every error-notification publish site must declare how the
 * card ends — a `recoveryKey` (the condition system retires it on the matching
 * success/death signal) or an explicit `// lifecycle: one-shot` comment (the
 * 48h keyless debris sweep is its terminal point).
 *
 * This is what keeps the condition system a SYSTEM instead of a pile of
 * hand-wired special cases: the enforcement lives here, so a new publish site
 * without a declared lifecycle fails CI instead of shipping another card that
 * can never leave the Errors rail (the 2026-08-22 wall: nine ui-prefs 500s,
 * SIGTERM exits, bus subscriber throws — none of them could ever retire).
 *
 * How to satisfy the ratchet when adding a publish site:
 *  - condition errors (something that can succeed again): pass `recoveryKey`
 *    and wire the matching success edge through publishRecovery — see
 *    docs/reference/notification-lifecycle.md for the contract catalog.
 *  - session/task-scoped errors: use publishSessionErrorNotification (keys and
 *    marks failing in one move).
 *  - genuine one-time events: write `// lifecycle: one-shot` within the 8
 *    lines above the call, with a word on why nothing can recover it.
 */

const SERVER = join(__dirname, '../../../src/web/server.ts');

interface PublishSite { line: number; snippet: string; hasLifecycle: boolean }

function collectSites(source: string): PublishSite[] {
  const lines = source.split('\n');
  const sites: PublishSite[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Call sites only: skip the function definitions and comment mentions.
    if (!/(?<![a-zA-Z])publishErrorNotification\(\{/.test(lines[i])) continue;
    if (/^\s*(async )?function/.test(lines[i])) continue;

    // A publish object literal is small; scan to its closing brace (bounded).
    const end = Math.min(i + 20, lines.length);
    const block = lines.slice(i, end).join('\n');
    const context = lines.slice(Math.max(0, i - 8), i).join('\n');
    sites.push({
      line: i + 1,
      snippet: lines[i].trim().slice(0, 90),
      hasLifecycle:
        /recoveryKey\s*:/.test(block) || /lifecycle:\s*one-shot/.test(context),
    });
  }
  return sites;
}

describe('notification lifecycle ratchet', () => {
  it('every publishErrorNotification site declares a lifecycle (recoveryKey or one-shot)', () => {
    const source = readFileSync(SERVER, 'utf8');
    const sites = collectSites(source);
    // Sanity: the scan must actually find the known sites — a refactor that
    // renames the function should update this ratchet, not silently pass it.
    expect(sites.length).toBeGreaterThanOrEqual(5);

    const undeclared = sites.filter(s => !s.hasLifecycle);
    expect(
      undeclared,
      `publish sites without a declared lifecycle (add recoveryKey, use ` +
      `publishSessionErrorNotification, or comment "// lifecycle: one-shot"):\n` +
      undeclared.map(s => `  server.ts:${s.line} ${s.snippet}`).join('\n'),
    ).toEqual([]);
  });
});
