import { describe, expect, it } from 'vitest';
import { SESSION_ENGINE_IDS, type SessionEngine } from '../../src/core/types.js';
import {
  DEFAULT_ENGINE,
  ENGINE_REGISTRY,
  acpEngineIds,
  engineCaps,
  isAcpEngine,
  isKnownEngine,
  normalizeEngine,
  resolveEngine,
} from '../../src/core/agents/engine-registry.js';

describe('engine registry', () => {
  it('registers every declared engine, in SESSION_ENGINE_IDS order, with consistent ids', () => {
    expect([...ENGINE_REGISTRY.keys()]).toEqual([...SESSION_ENGINE_IDS]);
    for (const [id, caps] of ENGINE_REGISTRY) expect(caps.id).toBe(id);
  });

  it('resolveEngine: absent/unknown values degrade to the default engine', () => {
    expect(resolveEngine(undefined)).toBe(DEFAULT_ENGINE);
    expect(resolveEngine(null)).toBe(DEFAULT_ENGINE);
    expect(resolveEngine('claude')).toBe('claude');
    expect(resolveEngine('codex')).toBe('codex');
    expect(resolveEngine('gemini')).toBe('gemini');
    // A record written by a newer build with an engine this build does not
    // know must degrade, not crash.
    expect(resolveEngine('some-future-engine')).toBe(DEFAULT_ENGINE);
    expect(resolveEngine(42)).toBe(DEFAULT_ENGINE);
  });

  it('normalizeEngine preserves the storage contract (claude persists as undefined)', () => {
    expect(normalizeEngine('codex')).toBe('codex');
    expect(normalizeEngine('goose')).toBe('goose');
    expect(normalizeEngine('claude')).toBeUndefined();
    expect(normalizeEngine(undefined)).toBeUndefined();
    expect(normalizeEngine('CODEX')).toBeUndefined();
    expect(normalizeEngine('some-future-engine')).toBeUndefined();
    expect(normalizeEngine({ engine: 'codex' })).toBeUndefined();
  });

  it('capability answers match the shipped behavior matrix', () => {
    const claude = engineCaps(undefined);
    expect(claude.runtimeKind).toBe('native');
    expect(claude.historySource).toBe('provider-jsonl');
    expect(claude.idProvisioning).toBe('preassigned');
    expect(claude.fork).toBe(true);
    expect(claude.rewind).toBe('fork-based');
    expect(claude.sidLivenessProbe).toBe(true);
    expect(claude.snapshotPull).toBe(true);
    expect(claude.permissionAnswers).toBe(true);
    expect(claude.acpAdapter).toBeUndefined();

    const codex = engineCaps('codex');
    expect(codex.runtimeKind).toBe('acp');
    expect(codex.historySource).toBe('acp-journal');
    expect(codex.idProvisioning).toBe('provider-issued');
    expect(codex.fork).toBe(false);
    expect(codex.rewind).toBe('unsupported');
    expect(codex.sidLivenessProbe).toBe(false);
    expect(codex.snapshotPull).toBe(false);
    expect(codex.permissionAnswers).toBe(false);
    expect(codex.modeControl).toBe('config-options');
  });

  it('isAcpEngine mirrors runtimeKind', () => {
    expect(isAcpEngine('codex')).toBe(true);
    expect(isAcpEngine('opencode')).toBe(true);
    expect(isAcpEngine('claude')).toBe(false);
    expect(isAcpEngine(undefined)).toBe(false);
  });

  it('isKnownEngine validates route input', () => {
    expect(isKnownEngine('claude')).toBe(true);
    expect(isKnownEngine('codex')).toBe(true);
    expect(isKnownEngine('opencode')).toBe(true);
    expect(isKnownEngine('some-future-engine')).toBe(false);
    expect(isKnownEngine(undefined)).toBe(false);
  });

  it('model catalog source is declared per engine', () => {
    expect(engineCaps('claude').modelCatalog).toBe('static');
    expect(engineCaps('codex').modelCatalog).toBe('provider-advertised');
  });

  it('acpEngineIds lists exactly the acp-runtime engines, in registry order', () => {
    const fromRegistry = [...ENGINE_REGISTRY.values()]
      .filter((caps) => caps.runtimeKind === 'acp')
      .map((caps) => caps.id);
    expect(acpEngineIds()).toEqual(fromRegistry);
    expect(acpEngineIds()).toEqual(['codex', 'gemini', 'opencode', 'goose', 'custom']);
    expect(acpEngineIds()).not.toContain('claude');
  });

  it('the acp engines advertise the verified adapter argv', () => {
    expect(engineCaps('codex').acpAdapter).toEqual({
      source: 'bundled', binary: 'codex', args: null, versionArgs: ['--version'],
    });
    expect(engineCaps('gemini').acpAdapter).toEqual({
      source: 'cli', binary: 'gemini', args: ['--experimental-acp'], versionArgs: ['--version'],
    });
    expect(engineCaps('opencode').acpAdapter).toEqual({
      source: 'cli', binary: 'opencode', args: ['acp'], versionArgs: ['--version'],
    });
    expect(engineCaps('goose').acpAdapter).toEqual({
      source: 'cli', binary: 'goose', args: ['acp'], versionArgs: ['--version'],
    });
    expect(engineCaps('custom').acpAdapter).toEqual({
      source: 'config', binary: null, args: null, versionArgs: [],
    });
  });
});

// Invariants every descriptor must satisfy — the point of the registry is that
// adding an engine is one descriptor, so these run per engine rather than being
// hand-listed per vendor.
describe.each([...SESSION_ENGINE_IDS])('engine descriptor invariants: %s', (id: SessionEngine) => {
  const caps = engineCaps(id);

  it('is registered under its own id with a display name', () => {
    expect(ENGINE_REGISTRY.has(id)).toBe(true);
    expect(caps.id).toBe(id);
    expect(caps.displayName.trim().length).toBeGreaterThan(0);
  });

  it('round-trips through resolveEngine / normalizeEngine', () => {
    expect(resolveEngine(id)).toBe(id);
    expect(isKnownEngine(id)).toBe(true);
    if (id === DEFAULT_ENGINE) expect(normalizeEngine(id)).toBeUndefined();
    else expect(normalizeEngine(id)).toBe(id);
    // Whatever normalize persists must resolve back to the same engine.
    expect(resolveEngine(normalizeEngine(id))).toBe(id);
  });

  it('declares an acpAdapter iff the runtime is the acp family', () => {
    if (caps.runtimeKind === 'acp') {
      expect(caps.acpAdapter, `${id} is acp but has no adapter`).toBeDefined();
      expect(acpEngineIds()).toContain(id);
    } else {
      expect(caps.acpAdapter).toBeUndefined();
      expect(acpEngineIds()).not.toContain(id);
    }
  });

  it('adapter source, binary and args are mutually consistent', () => {
    const adapter = caps.acpAdapter;
    if (!adapter) return;
    expect(['bundled', 'cli', 'config']).toContain(adapter.source);
    // args is the argv TAIL after the resolved binary: only a CLI-speaks-ACP
    // engine has one; bundled/config resolve their whole argv elsewhere.
    if (adapter.source === 'cli') {
      expect(typeof adapter.binary).toBe('string');
      expect(adapter.binary).toBeTruthy();
      expect(Array.isArray(adapter.args)).toBe(true);
      expect(adapter.args?.length ?? 0).toBeGreaterThan(0);
      expect(adapter.versionArgs.length).toBeGreaterThan(0);
    } else if (adapter.source === 'bundled') {
      expect(typeof adapter.binary).toBe('string');
      expect(adapter.args).toBeNull();
      expect(adapter.versionArgs.length).toBeGreaterThan(0);
    } else {
      // 'config': argv comes from walnut config, so there is nothing to probe.
      expect(adapter.binary).toBeNull();
      expect(adapter.args).toBeNull();
      expect(adapter.versionArgs).toEqual([]);
    }
  });

  it('acp engines share the acp transport answers; only claude is native', () => {
    if (caps.runtimeKind === 'native') {
      expect(id).toBe(DEFAULT_ENGINE);
      return;
    }
    expect(caps.historySource).toBe('acp-journal');
    expect(caps.idProvisioning).toBe('provider-issued');
    expect(caps.modeControl).toBe('config-options');
    expect(caps.modelSwitch).toBe('config-option');
    expect(caps.modelCatalog).toBe('provider-advertised');
    expect(caps.permissionAnswers).toBe(false);
    expect(caps.rewind).toBe('unsupported');
    expect(caps.fork).toBe(false);
    expect(caps.snapshotPull).toBe(false);
    expect(caps.sidLivenessProbe).toBe(false);
  });
});
