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
  _resetWriteLockForTest,
  _setConfigTimingsForTest,
  _configRepairIdleForTest,
} from '../../src/core/config-manager.js';

beforeEach(async () => {
  _resetWriteLockForTest();
  // Short waits for a missing/empty file to count as real (config-save-race.test.ts
  // pins the waits themselves).
  _setConfigTimingsForTest({ quietMs: 100, settleMs: 50, readRetryMs: 20, lateWriteWatchMs: 100 });
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  // A restore a read started must not run on into the next test's files.
  await _configRepairIdleForTest();
  _setConfigTimingsForTest(null);
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
    // The read answers from the backup at once; the file itself is put back only
    // after it stayed missing for the quiet period.
    await _configRepairIdleForTest();

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

/**
 * A config-read hiccup must never silently drop the `agent:` section.
 *
 * What lives there exists nowhere else: which provider Walnut's own model calls
 * use, which models Settings offers. The 2026-08-28 06:03 incident was exactly
 * this — the file was read in a state where `agent:` was absent, nothing threw so
 * nothing was logged, and one turn went at credentials this box does not keep.
 *
 * Each case here is a state config.yaml can genuinely be observed in, not a mocked
 * failure.
 */
describe('a config-read hiccup never silently drops the agent section', () => {
  it('recovers the section from the sidecar when the primary file is EMPTY', async () => {
    // fs.writeFile truncates then writes, so a reader can land on a zero-length or
    // prefix file. The sidecar is the last good copy and must win over defaults.
    await fs.writeFile(`${CONFIG_FILE}.bak`, yaml.dump({
      version: 1, user: {}, defaults: { priority: 'none' }, agent: { main_provider: 'bedrock' },
    }), 'utf-8');
    await fs.writeFile(CONFIG_FILE, '', 'utf-8');
    expect((await getConfig()).agent?.main_provider).toBe('bedrock');
  });

  it('an UNPARSEABLE file with no sidecar still yields a usable agent section', async () => {
    // The catch branch returns DEFAULT_CONFIG with the model catalog seeded. It
    // must SPREAD the default agent object rather than replace it, or a key added
    // to the defaults silently disappears on this path.
    await fs.writeFile(CONFIG_FILE, '{ this is not yaml: [oops', 'utf-8');
    const config = await getConfig();
    expect(config.agent?.main_model).toBeTruthy();
    expect((config.agent?.available_models ?? []).length).toBeGreaterThan(0);
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
      agent: { main_provider: 'claude_cli' },
      // Padding so a non-atomic write would take multiple syscalls to land.
      hosts: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`h${i}`, { hostname: `host-${i}.invalid` }])),
    });
    await fs.writeFile(CONFIG_FILE, full, 'utf-8');

    const writes = (async () => {
      for (let i = 0; i < 30; i++) await updateConfig({ user: { name: `w${i}` } } as any);
    })();
    // Read hard while the writer runs: every read must see the whole agent
    // section, never a prefix that stopped before it.
    const reads: Promise<void>[] = [];
    for (let i = 0; i < 120; i++) {
      reads.push((async () => {
        const raw = await fs.readFile(CONFIG_FILE, 'utf-8').catch(() => null);
        if (raw === null) return; // rename window: ENOENT is acceptable, a prefix is not
        const parsed = yaml.load(raw) as { agent?: { main_provider?: string } } | undefined;
        expect(parsed?.agent?.main_provider).toBe('claude_cli');
      })());
    }
    await Promise.all([writes, ...reads]);
  });
});

// The companion's keep choice where an older build kept it (replication/companion-keep.ts):
// every read shows it in cloud_bridge, and every write moves it there on disk.
describe('the companion keep choice moves from hosts.companion to cloud_bridge', () => {
  const legacy = {
    version: 1,
    cloud_bridge: { enabled: true },
    hosts: { companion: { keep: { notes: false, notes_exclude: ['Journal'] }, server: { copies: { inbox: false } } }, dev: { hostname: 'dev.example' } },
  };

  it('a read shows it in cloud_bridge and no hosts.companion', async () => {
    await fs.writeFile(CONFIG_FILE, yaml.dump(legacy), 'utf-8');
    const config = await getConfig();
    expect(config.cloud_bridge).toMatchObject({ enabled: true, keep: { notes: false, notes_exclude: ['Journal'] }, copies: { inbox: false } });
    expect(config.hosts?.companion).toBeUndefined();
    expect(config.hosts?.dev).toMatchObject({ hostname: 'dev.example' });
  });

  it('a write of another key moves it on disk; a write that replaces hosts never drops it', async () => {
    await fs.writeFile(CONFIG_FILE, yaml.dump(legacy), 'utf-8');
    await updateConfig({ hosts: { dev: { hostname: 'dev.example' } } } as any);
    const raw = yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as any;
    expect(raw.cloud_bridge).toEqual({ enabled: true, keep: { notes: false, notes_exclude: ['Journal'] }, copies: { inbox: false } });
    expect(raw.hosts.companion).toBeUndefined();
  });

  it('a save of cloud_bridge.keep from Settings writes cloud_bridge and the older keys go', async () => {
    await fs.writeFile(CONFIG_FILE, yaml.dump(legacy), 'utf-8');
    await updateConfig({ cloud_bridge: { enabled: true, keep: { memory: false }, copies: { inbox: false } } } as any);
    const raw = yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as any;
    expect(raw.cloud_bridge).toEqual({ enabled: true, keep: { memory: false }, copies: { inbox: false } });
    expect(raw.hosts).toEqual({ dev: { hostname: 'dev.example' } });
  });

  it('a stale write that carries the older keys back cannot bring them back', async () => {
    await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, cloud_bridge: { keep: { notes: true } } }), 'utf-8');
    await updateConfig({ hosts: { companion: { keep: { notes: false } } } } as any);
    const raw = yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as any;
    expect(raw.cloud_bridge).toEqual({ keep: { notes: true } });
    expect(raw.hosts).toEqual({});
  });

  it('a real host named companion keeps its own entry', async () => {
    const real = { version: 1, hosts: { companion: { hostname: 'box.example', keep: { notes: false } } } };
    await fs.writeFile(CONFIG_FILE, yaml.dump(real), 'utf-8');
    const config = await getConfig();
    expect(config.hosts?.companion).toMatchObject({ hostname: 'box.example', keep: { notes: false } });
    expect(config.cloud_bridge?.keep).toBeUndefined();
  });
});
