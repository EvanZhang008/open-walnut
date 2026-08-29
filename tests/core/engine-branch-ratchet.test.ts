/**
 * Ratchet: no new `engine === '<vendor>'` comparisons outside the engine
 * registry (docs/plan/agent-provider-platform.md, P0).
 *
 * Engine-specific facts belong in src/core/agents/engine-registry.ts as
 * capabilities. A call site that needs to know "is this codex?" should ask
 * a capability question (engineCaps(...).historySource, .runtimeKind, ...)
 * instead of naming the vendor — that is what keeps "add an engine" a
 * one-descriptor change.
 *
 * Allowed zones:
 *  - src/core/agents/            the registry itself
 *  - src/providers/              transport layer (an AcpSession legitimately
 *                                knows it speaks ACP; the daemon dispatch is
 *                                the strategy-selection point)
 * If you legitimately need a new exemption, add it to ALLOWED with a comment
 * explaining why it is transport-layer, not a capability.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');

// Vendor comparisons on an `engine`-holding value, either operand order.
// Covers ==/===/!=/!==, single or double quotes, and camelCase holders
// (currentEngine, existingEngine, record.engine, ...).
const PATTERN = String.raw`([A-Za-z_.]*[Ee]ngine\s*[!=]=+\s*['"](codex|claude)['"])|(['"](codex|claude)['"]\s*[!=]=+\s*[A-Za-z_.]*[Ee]ngine\b)`;

const ALLOWED_PREFIXES = [
  'src/core/agents/', // the registry itself
];

function grepEngineComparisons(dir: string): string[] {
  let out = '';
  try {
    out = execFileSync(
      'grep',
      ['-rInE', PATTERN, dir, '--include=*.ts', '--include=*.tsx'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
  } catch (err: unknown) {
    // grep exits 1 on zero matches — that is the desired outcome. Anything
    // else (2 = bad pattern / missing dir) must FAIL the ratchet, not pass
    // it silently: a renamed directory would otherwise turn this green forever.
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1) return [];
    if (e.status !== undefined && e.status !== 0) {
      throw new Error(`grep failed (exit ${e.status}) scanning ${dir} — ratchet cannot run`);
    }
    out = e.stdout ?? '';
  }
  return out
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
      const file = line.slice(0, line.indexOf(':'));
      return !ALLOWED_PREFIXES.some((p) => file.startsWith(p));
    });
}

describe('engine branch ratchet', () => {
  it('src/core has no vendor-engine comparisons outside the registry', () => {
    const hits = grepEngineComparisons('src/core');
    expect(hits, `Vendor engine comparisons found — express these as capabilities in src/core/agents/engine-registry.ts:\n${hits.join('\n')}`).toEqual([]);
  });

  it('src/web has no vendor-engine comparisons', () => {
    const hits = grepEngineComparisons('src/web');
    expect(hits, `Vendor engine comparisons found — express these as capabilities in src/core/agents/engine-registry.ts:\n${hits.join('\n')}`).toEqual([]);
  });

  it('src/ops, src/commands and src/utils have no vendor-engine comparisons', () => {
    const hits = [
      ...grepEngineComparisons('src/ops'),
      ...grepEngineComparisons('src/commands'),
      ...grepEngineComparisons('src/utils'),
    ];
    expect(hits, `Vendor engine comparisons found — express these as capabilities in src/core/agents/engine-registry.ts:\n${hits.join('\n')}`).toEqual([]);
  });
});
