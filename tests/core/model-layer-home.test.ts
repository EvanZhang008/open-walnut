/**
 * Model-layer home ratchet.
 *
 * The in-process agent (`src/agent/`) is being removed, but its MODEL layer is not
 * agent-specific: `sendMessage`/`sendMessageStream`, the provider registry, the model
 * catalog and the protocol adapters are what Settings, STT, titles, quick-parse and
 * every background summarizer call. Step 1 of the removal moved that layer to
 * `src/model/` and left one-line re-export shims behind at the old paths so no
 * importer had to change in the same commit.
 *
 * This ratchet pins the three properties that make the rest of the removal safe:
 *  1. the model layer's public surface really lives at `src/model/model.ts`;
 *  2. everything left under `src/agent/providers/` is a shim, so nobody "adds a small
 *     provider fix" back into a directory that is scheduled for deletion;
 *  3. nothing under `src/model/` imports from `src/agent/` — the model layer must not
 *     depend on the agent, or deleting the agent takes the model layer with it.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockConstants } from '../helpers/mock-constants.js';

// The model layer pulls in config-manager; keep its paths inside a temp dir.
vi.mock('../../src/constants.js', () => createMockConstants('walnut-model-layer-home'));

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const modelDir = path.join(repoRoot, 'src/model');
const agentProvidersDir = path.join(repoRoot, 'src/agent/providers');

/** Every .ts file under a directory, recursively, as repo-relative paths. */
function walkTs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(abs));
    else if (entry.name.endsWith('.ts')) out.push(path.relative(repoRoot, abs));
  }
  return out.sort();
}

describe('model layer lives in src/model/', () => {
  it('src/model/model.ts exists and exports the public model API', async () => {
    expect(fs.existsSync(path.join(modelDir, 'model.ts'))).toBe(true);

    const mod = await import('../../src/model/model.js');
    for (const name of ['sendMessage', 'sendMessageStream', 'getContextWindowSize', 'getContextThreshold']) {
      expect(typeof (mod as Record<string, unknown>)[name], `${name} must be exported`).toBe('function');
    }
    expect(typeof mod.DEFAULT_MODEL).toBe('string');
    expect(mod.DEFAULT_MODEL.length).toBeGreaterThan(0);
  });

  it('the moved provider modules are all present under src/model/providers/', () => {
    const expected = [
      'types.ts', 'registry.ts', 'index.ts', 'defaults.ts', 'model-catalog.ts',
      'default-provider.ts', 'secret.ts', 'retry.ts', 'claude-cli-protocol.ts',
      'adapter-anthropic.ts', 'adapter-bedrock.ts', 'adapter-claude-cli.ts',
      'adapter-google.ts', 'adapter-ollama.ts', 'adapter-openai.ts',
    ];
    for (const file of expected) {
      expect(fs.existsSync(path.join(modelDir, 'providers', file)), `src/model/providers/${file}`).toBe(true);
    }
  });
});

describe('src/agent/providers/ holds nothing but shims', () => {
  const files = walkTs(agentProvidersDir);

  it('has at least the shims it is supposed to have (or is already deleted)', () => {
    // Once src/agent/ is deleted (removal step 4) this directory is gone and the
    // rest of this suite is vacuously true. Until then it must not be empty.
    if (fs.existsSync(agentProvidersDir)) expect(files.length).toBeGreaterThan(0);
  });

  for (const rel of files) {
    it(`${rel} is a one-line re-export of src/model/providers/`, () => {
      const lines = fs.readFileSync(path.join(repoRoot, rel), 'utf-8')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
      const code = lines.filter(l => !l.startsWith('//'));
      expect(
        code,
        `${rel} must contain exactly one statement — real provider code belongs in src/model/providers/`,
      ).toHaveLength(1);
      expect(code[0]).toMatch(/^export \* from '\.\.\/\.\.\/model\/providers\/[\w.-]+\.js';$/);
      expect(lines.some(l => l.startsWith('//')), `${rel} needs the shim header comment`).toBe(true);
    });
  }
});

describe('the model layer does not depend on the agent', () => {
  it('no file under src/model/ imports from src/agent/', () => {
    const offenders: string[] = [];
    for (const rel of walkTs(modelDir)) {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
      // Any specifier that walks back into the agent directory, however deep —
      // static `from '…'` and the dynamic/type-position `import('…')` form alike.
      for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)'([^']+)'/g)) {
        if (/(^|\/)agent\//.test(m[1])) offenders.push(`${rel} → ${m[1]}`);
      }
    }
    expect(
      offenders,
      'the model layer must survive the deletion of src/agent/ — move the shared code instead',
    ).toEqual([]);
  });
});
