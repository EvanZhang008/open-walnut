import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import yaml from 'js-yaml';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, CONFIG_FILE } from '../../src/constants.js';
import {
  getConfig,
  saveConfig,
  updateConfig,
  resolveAgentEngineProvider,
  _resetWriteLockForTest,
} from '../../src/core/config-manager.js';
import {
  DEFAULT_AGENT_ENGINE_PROVIDER,
  FALLBACK_AGENT_ENGINE_PROVIDER,
  type Config,
} from '../../src/core/types.js';

beforeEach(async () => {
  _resetWriteLockForTest();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('updateConfig', () => {
  it('preserves unmentioned top-level keys', async () => {
    // Write initial config with ms_todo section
    const initial = {
      version: 1,
      user: { name: 'TestUser' },
      defaults: { priority: 'none', project: 'Personal' },
      ms_todo: { client_id: 'abc-123', tenant_id: 'xyz-789' },
    };
    await fs.writeFile(CONFIG_FILE, yaml.dump(initial), 'utf-8');

    // Update only 'defaults' — ms_todo must survive
    await updateConfig({ defaults: { priority: 'immediate', project: 'Work' } } as any);

    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const result = yaml.load(raw) as any;

    expect(result.ms_todo).toEqual({ client_id: 'abc-123', tenant_id: 'xyz-789' });
    expect(result.defaults.priority).toBe('immediate');
    expect(result.user.name).toBe('TestUser');
  });

  it('adds new top-level keys without affecting existing ones', async () => {
    const initial = { version: 1, user: { name: 'TestUser' } };
    await fs.writeFile(CONFIG_FILE, yaml.dump(initial), 'utf-8');

    await updateConfig({ defaults: { priority: 'backlog', project: 'Life' } } as any);

    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const result = yaml.load(raw) as any;

    expect(result.version).toBe(1);
    expect(result.user.name).toBe('TestUser');
    expect(result.defaults.priority).toBe('backlog');
  });

  it('works when no config file exists yet', async () => {
    await updateConfig({ user: { name: 'New User' } } as any);

    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const result = yaml.load(raw) as any;

    expect(result.user.name).toBe('New User');
  });

  it('replaces a top-level key entirely (not deep merge)', async () => {
    const initial = {
      version: 1,
      defaults: { priority: 'none', project: 'Personal' },
    };
    await fs.writeFile(CONFIG_FILE, yaml.dump(initial), 'utf-8');

    // Send defaults with only priority — project should be gone (top-level key replacement)
    await updateConfig({ defaults: { priority: 'immediate' } } as any);

    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const result = yaml.load(raw) as any;

    expect(result.defaults.priority).toBe('immediate');
    expect(result.defaults.project).toBeUndefined();
  });

  it('does not write undefined values', async () => {
    const initial = { version: 1, user: { name: 'TestUser' } };
    await fs.writeFile(CONFIG_FILE, yaml.dump(initial), 'utf-8');

    await updateConfig({ version: 1, user: undefined } as any);

    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const result = yaml.load(raw) as any;

    // user should not be overwritten because the value was undefined
    expect(result.user.name).toBe('TestUser');
  });
});

describe('saveConfig (full replace)', () => {
  it('replaces entire file, dropping unmentioned keys', async () => {
    const initial = {
      version: 1,
      user: { name: 'TestUser' },
      ms_todo: { client_id: 'abc-123' },
    };
    await fs.writeFile(CONFIG_FILE, yaml.dump(initial), 'utf-8');

    // saveConfig with no ms_todo — it should be gone
    await saveConfig({ version: 1, user: { name: 'TestUser' }, defaults: { priority: 'none' }, provider: { type: 'claude-code' } });

    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const result = yaml.load(raw) as any;

    expect(result.ms_todo).toBeUndefined();
    expect(result.user.name).toBe('TestUser');
  });
});

// Inbox is now STRUCTURAL — the absence of a project. There is nothing to
// reserve in config: no registry row exists for '' and no provider can claim it
// (see tests/core/project-source-validation.test.ts). The old
// `defaults.category` / `local.categories` reservation machinery is gone; its
// removal path is covered by tests/core/config-migration-project-only.test.ts.
describe('default platform + optional default project', () => {
  it('new users default to the local platform and no default project (= Inbox)', async () => {
    // No config file on disk → DEFAULT_CONFIG applies
    const config = await getConfig();
    expect(config.defaults.platform).toBe('local');
    expect(config.defaults.project).toBeUndefined();
    // The whole `local:` reservation section is gone from the Config type too.
    expect((config as unknown as Record<string, unknown>).local).toBeUndefined();
  });

  it('preserves an existing user’s default project instead of forcing Inbox', async () => {
    await fs.writeFile(CONFIG_FILE, yaml.dump({
      version: 1,
      defaults: { priority: 'none', project: 'Walnut' },
    }), 'utf-8');

    const config = await getConfig();
    expect(config.defaults.project).toBe('Walnut');
  });
});

// ── Config-loss recovery (2026-07-25 incident) ──────────────────────────────
// A git-sync merge carried a remote deletion of config.yaml (it was gitignored
// locally but still TRACKED), so the live file vanished. Every reader then fell
// back to defaults and the next writer PERSISTED that skeleton — silently
// dropping `stt:` (voice input died), `hosts:`, `plugins:`, `tools:`. The
// sidecar backup makes that loss recoverable instead of terminal.
describe('config loss recovery via sidecar backup', () => {
  const BACKUP_FILE = `${CONFIG_FILE}.bak`;

  it('writes a sidecar backup alongside every config write', async () => {
    await updateConfig({ stt: { engine: 'whisper-cpp', whisper_cpp_model: '/m/model.bin' } } as any);

    const backup = yaml.load(await fs.readFile(BACKUP_FILE, 'utf-8')) as any;
    expect(backup.stt.engine).toBe('whisper-cpp');
  });

  it('getConfig recovers stt config when config.yaml is deleted underneath it', async () => {
    await updateConfig({
      stt: { engine: 'whisper-server', whisper_server_model: '/m/turbo.bin' },
      hosts: { devbox: { hostname: 'devbox.example.com', user: 'me' } },
    } as any);

    // Simulate the merge deleting the working-tree file.
    await fs.rm(CONFIG_FILE, { force: true });

    const config = await getConfig();
    expect(config.stt?.engine).toBe('whisper-server');
    expect(config.hosts?.devbox?.hostname).toBe('devbox.example.com');
  });

  it('restores the primary file on disk after recovering from backup', async () => {
    await updateConfig({ stt: { engine: 'whisper-cpp' } } as any);
    await fs.rm(CONFIG_FILE, { force: true });

    await getConfig();

    const restored = yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as any;
    expect(restored.stt.engine).toBe('whisper-cpp');
  });

  it('updateConfig does NOT drop unmentioned sections when the primary file was deleted', async () => {
    // This is the exact amplifier: merging a partial into `{}` persisted a
    // config with every other section gone.
    await updateConfig({
      stt: { engine: 'whisper-server', whisper_server_model: '/m/turbo.bin' },
      tools: { web_search: { provider: 'tavily' } },
    } as any);

    await fs.rm(CONFIG_FILE, { force: true });

    // A wholly unrelated write — must not erase stt/tools.
    await updateConfig({ defaults: { priority: 'none', project: 'Walnut' } } as any);

    const result = yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as any;
    expect(result.stt.engine).toBe('whisper-server');
    expect(result.tools.web_search.provider).toBe('tavily');
    expect(result.defaults.project).toBe('Walnut');
  });

  it('still falls back to defaults on a genuine first run (no config, no backup)', async () => {
    const config = await getConfig();
    expect(config.version).toBe(1);
    expect(config.stt).toBeUndefined();
  });
});

describe('resolveAgentEngineProvider: default vs fallback are SEPARATE roles', () => {
  // The default (unset key) and the degrade target (unrecognized string) stay two
  // separate constants so the two roles can diverge again. These tests pin the
  // ROLE split; the value assertions below pin what each role currently means.
  const cfg = (agent?: Record<string, unknown>): Config =>
    ({ version: 1, user: {}, defaults: { priority: 'none' }, agent } as unknown as Config);

  // The engine follows the AI provider (what Ask Walnut runs on): Claude Code →
  // the lane session, anything else → the in-process loop on that provider.
  it('unset engine + Claude Code installed → the DEFAULT (lane) engine', () => {
    expect(resolveAgentEngineProvider(cfg(undefined), true)).toBe(DEFAULT_AGENT_ENGINE_PROVIDER);
    expect(resolveAgentEngineProvider(cfg({}), true)).toBe(DEFAULT_AGENT_ENGINE_PROVIDER);
    expect(resolveAgentEngineProvider(cfg({ main_provider: 'claude_cli' }), false)).toBe('claude-code');
  });

  it('unset engine + another AI provider → the in-process loop, which is what can call it', () => {
    expect(resolveAgentEngineProvider(cfg({ main_provider: 'bedrock' }), true)).toBe('walnut-agent');
    expect(resolveAgentEngineProvider(cfg({ main_provider: 'openai' }), true)).toBe('walnut-agent');
    // No provider chosen and no `claude` on the box: the lane engine could not answer.
    expect(resolveAgentEngineProvider(cfg(undefined), false)).toBe('walnut-agent');
  });

  it('an explicit engine outranks the provider rule (advanced override)', () => {
    expect(resolveAgentEngineProvider(cfg({ provider: 'claude-code', main_provider: 'bedrock' }), true)).toBe('claude-code');
    expect(resolveAgentEngineProvider(cfg({ provider: 'walnut-agent', main_provider: 'claude_cli' }), true)).toBe('walnut-agent');
  });

  it('a valid explicit value is honored verbatim', () => {
    expect(resolveAgentEngineProvider(cfg({ provider: 'claude-code' }))).toBe('claude-code');
    expect(resolveAgentEngineProvider(cfg({ provider: 'walnut-agent' }))).toBe('walnut-agent');
  });

  it('an unrecognized string → the FALLBACK engine, regardless of the default', () => {
    expect(resolveAgentEngineProvider(cfg({ provider: 'wat' }))).toBe(FALLBACK_AGENT_ENGINE_PROVIDER);
    expect(resolveAgentEngineProvider(cfg({ provider: '' }))).toBe(FALLBACK_AGENT_ENGINE_PROVIDER);
    // Non-string garbage degrades the same way.
    expect(resolveAgentEngineProvider(cfg({ provider: 42 }))).toBe(FALLBACK_AGENT_ENGINE_PROVIDER);
    expect(resolveAgentEngineProvider(cfg({ provider: null }))).toBe(FALLBACK_AGENT_ENGINE_PROVIDER);
  });

  // Both roles resolve to the lane engine as of 2026-08-28. The previous rule
  // ("degrade to walnut-agent forever") was written to keep a corrupt config off
  // a NEW engine, but the incident it caused inverted the risk: the in-process
  // loop needs Bedrock credentials of its own, which a CLI-only install does not
  // keep, so degrading onto it means degrading onto an engine that CANNOT answer
  // at all. On 2026-08-28 06:03 one relayed turn resolved 'walnut-agent' and the
  // phone reported "Could not load credentials from any providers" — an engine
  // surprise wearing a credential error's clothes. An unrecognized value is now
  // made audible by a warn log instead of by a silent engine switch.
  it('neither role degrades onto an engine a CLI-only install cannot run', () => {
    expect(DEFAULT_AGENT_ENGINE_PROVIDER).toBe('claude-code');
    expect(FALLBACK_AGENT_ENGINE_PROVIDER).toBe('claude-code');
  });
});

/**
 * A config-read hiccup must never change which engine answers chat.
 *
 * The 2026-08-28 06:03 incident: one relayed turn resolved 'walnut-agent' while
 * every other turn that day resolved 'claude-code', so it reached for Bedrock
 * credentials this box does not keep and the phone showed "Could not load
 * credentials from any providers". Nothing had thrown, so nothing was logged —
 * the file had simply been read in a state where `agent:` was absent, and the
 * engine choice absorbed it silently.
 *
 * Each case here is a state config.yaml can genuinely be observed in, not a
 * mocked failure. The engine must survive all of them.
 */
describe('a config-read hiccup never changes the chat engine', () => {
  // `true` = a Mac with Claude Code installed, the machine the incident happened on.
  const engineOf = async () => resolveAgentEngineProvider(await getConfig(), true);

  it('survives a HALF-WRITTEN file that stops before the agent: section', async () => {
    // The real window: fs.writeFile truncates then writes, and `agent:` sits at
    // line 12 of a 281-line config. A reader landing mid-write got valid YAML
    // with no agent section at all.
    await fs.writeFile(CONFIG_FILE, 'version: 1\nuser: {}\ndefaults:\n  priority: none\n', 'utf-8');
    expect(await engineOf()).toBe('claude-code');
  });

  it('survives an EMPTY file (yaml.load returns undefined, which spread away every setting)', async () => {
    await fs.writeFile(CONFIG_FILE, '', 'utf-8');
    expect(await engineOf()).toBe('claude-code');
  });

  it('survives an UNPARSEABLE file — the getConfig catch must keep provider', async () => {
    // The bug was in this exact branch: the catch returned
    // `{ ...DEFAULT_CONFIG, agent: { available_models, main_model } }`, replacing
    // the agent object and dropping `provider` with it.
    await fs.writeFile(CONFIG_FILE, '{ this is not yaml: [oops', 'utf-8');
    expect(await engineOf()).toBe('claude-code');
  });

  it('recovers an explicit walnut-agent choice from the sidecar rather than defaulting', async () => {
    // The mirror image: a user who deliberately chose the in-process loop must
    // not be flipped onto the lane engine by a truncated primary either.
    await fs.writeFile(`${CONFIG_FILE}.bak`, yaml.dump({
      version: 1, user: {}, defaults: { priority: 'none' }, agent: { provider: 'walnut-agent' },
    }), 'utf-8');
    await fs.writeFile(CONFIG_FILE, '', 'utf-8');
    expect(await engineOf()).toBe('walnut-agent');
  });
});

/**
 * config.yaml is replaced atomically (temp + rename), so a concurrent reader sees
 * either the old file or the new one — never a prefix. Without this, the reader
 * above had a real window to land in.
 */
describe('config writes are atomic', () => {
  it('a reader racing a write never observes a partial file', async () => {
    const full = yaml.dump({
      version: 1, user: {}, defaults: { priority: 'none' },
      agent: { provider: 'claude-code' },
      // Padding so a non-atomic write would take multiple syscalls to land.
      hosts: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`h${i}`, { hostname: `host-${i}.invalid` }])),
    });
    await fs.writeFile(CONFIG_FILE, full, 'utf-8');

    const writes = (async () => {
      for (let i = 0; i < 30; i++) await updateConfig({ user: { name: `w${i}` } } as any);
    })();
    // Read hard while the writer runs: every read must yield the lane engine,
    // never the default-from-a-prefix.
    const reads: Promise<void>[] = [];
    for (let i = 0; i < 120; i++) {
      reads.push((async () => {
        const raw = await fs.readFile(CONFIG_FILE, 'utf-8').catch(() => null);
        if (raw === null) return; // rename window: ENOENT is acceptable, a prefix is not
        const parsed = yaml.load(raw) as { agent?: { provider?: string } } | undefined;
        expect(parsed?.agent?.provider).toBe('claude-code');
      })());
    }
    await Promise.all([writes, ...reads]);
  });
});
