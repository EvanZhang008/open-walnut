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
 * This ratchet pins the properties that make the rest of the removal safe:
 *  1. the model layer's public surface really lives at `src/model/model.ts`;
 *  2. EVERY file left under `src/agent/` is a shim (one `export * from` per line, no
 *     logic), so nobody "adds a small fix" back into a directory scheduled for deletion;
 *  3. the new homes the shims point at all exist;
 *  4. nothing in a new home imports from `src/agent/` — the moved code must survive the
 *     deletion of the agent directory, or deleting it takes the moved code with it.
 *
 * `src/agent/session-context.ts` is the one deliberate exception: it is not model or
 * agent-loop code, it builds the system-prompt block for a `claude` CLI session, and it
 * moves under `src/core/sessions/` in its own change.
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
const agentDir = path.join(repoRoot, 'src/agent');
const agentProvidersDir = path.join(repoRoot, 'src/agent/providers');

/** The one file under src/agent/ that is still real code (see the header). */
const AGENT_EXEMPT = new Set(['src/agent/session-context.ts']);

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

describe('src/agent/ holds nothing but shims', () => {
  const files = walkTs(agentDir).filter((rel) => !AGENT_EXEMPT.has(rel));

  it('every remaining file is accounted for as a shim or an exemption', () => {
    // Once src/agent/ is deleted the whole suite is vacuously true; until then
    // a NEW real file must not appear there unnoticed.
    if (!fs.existsSync(agentDir)) return;
    expect(walkTs(agentDir).length).toBeGreaterThan(0);
  });

  for (const rel of files) {
    it(`${rel} contains only re-exports`, () => {
      const lines = fs.readFileSync(path.join(repoRoot, rel), 'utf-8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const code = lines.filter((l) => !l.startsWith('//'));
      expect(code.length, `${rel} must be a shim — real code belongs in its new home`).toBeGreaterThan(0);
      for (const statement of code) {
        // A shim re-exports a new home and does nothing else: no logic, no
        // wrappers, no re-declared types.
        expect(
          statement,
          `${rel}: only "export * from '<new home>'" statements may live under src/agent/`,
        ).toMatch(/^export \* from '(?:\.\.\/)+(?:model|core)\/[\w./-]+\.js';$/);
      }
      expect(lines.some((l) => l.startsWith('//')), `${rel} needs the shim header comment`).toBe(true);
    });
  }

  it('the exempted file is the only real code left (and is still there)', () => {
    if (!fs.existsSync(agentDir)) return;
    const real = walkTs(agentDir).filter((rel) => {
      const code = fs.readFileSync(path.join(repoRoot, rel), 'utf-8')
        .split('\n').map((l) => l.trim()).filter(Boolean)
        .filter((l) => !l.startsWith('//'));
      return !code.every((l) => l.startsWith('export * from '));
    });
    expect(real).toEqual([...AGENT_EXEMPT].filter((rel) => fs.existsSync(path.join(repoRoot, rel))));
  });
});

describe('the shims point at homes that exist', () => {
  const newHomes = [
    'src/model/model.ts',
    'src/model/tools.ts',
    'src/model/micro-agent.ts',
    'src/core/tools/read-only.ts',
    'src/core/plugins/plugin-tools.ts',
    'src/core/context-sources.ts',
    'src/core/overview-maintainer.ts',
    'src/core/memory/working-memory-updater.ts',
    'src/core/sessions/persona-sections.ts',
  ];

  for (const rel of newHomes) {
    it(`${rel} exists`, () => {
      expect(fs.existsSync(path.join(repoRoot, rel))).toBe(true);
    });
  }

  it('every shim target under src/agent/ resolves to a real file', () => {
    const missing: string[] = [];
    for (const rel of walkTs(agentDir)) {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
      for (const m of src.matchAll(/^export \* from '([^']+)';$/gm)) {
        const target = path.resolve(path.dirname(path.join(repoRoot, rel)), m[1]).replace(/\.js$/, '.ts');
        if (!fs.existsSync(target)) missing.push(`${rel} → ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('the moved code does not depend on the agent', () => {
  const newHomeDirs = [
    modelDir,
    path.join(repoRoot, 'src/core/tools'),
  ];
  const newHomeFiles = [
    'src/core/plugins/plugin-tools.ts',
    'src/core/sessions/persona-sections.ts',
    'src/core/context-sources.ts',
    'src/core/overview-maintainer.ts',
    'src/core/memory/working-memory-updater.ts',
  ];

  it('no moved file imports from src/agent/', () => {
    const offenders: string[] = [];
    const rels = [
      ...newHomeDirs.flatMap((dir) => walkTs(dir)),
      ...newHomeFiles.filter((rel) => fs.existsSync(path.join(repoRoot, rel))),
    ];
    for (const rel of rels) {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
      for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)'([^']+)'/g)) {
        if (/(^|\/)agent\//.test(m[1])) offenders.push(`${rel} → ${m[1]}`);
      }
    }
    expect(
      offenders,
      'the moved code must survive the deletion of src/agent/ — move the shared code instead',
    ).toEqual([]);
  });
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
