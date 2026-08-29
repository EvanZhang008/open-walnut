import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENGINE,
  ENGINE_REGISTRY,
  engineCaps,
  isAcpEngine,
  isKnownEngine,
  normalizeEngine,
  resolveEngine,
} from '../../src/core/agents/engine-registry.js';

describe('engine registry', () => {
  it('registers both shipped engines with consistent ids', () => {
    expect([...ENGINE_REGISTRY.keys()]).toEqual(['claude', 'codex']);
    for (const [id, caps] of ENGINE_REGISTRY) expect(caps.id).toBe(id);
  });

  it('resolveEngine: absent/unknown values degrade to the default engine', () => {
    expect(resolveEngine(undefined)).toBe(DEFAULT_ENGINE);
    expect(resolveEngine(null)).toBe(DEFAULT_ENGINE);
    expect(resolveEngine('claude')).toBe('claude');
    expect(resolveEngine('codex')).toBe('codex');
    // A record written by a newer build with an engine this build does not
    // know must degrade, not crash.
    expect(resolveEngine('opencode')).toBe(DEFAULT_ENGINE);
    expect(resolveEngine(42)).toBe(DEFAULT_ENGINE);
  });

  it('normalizeEngine preserves the storage contract (claude persists as undefined)', () => {
    expect(normalizeEngine('codex')).toBe('codex');
    expect(normalizeEngine('claude')).toBeUndefined();
    expect(normalizeEngine(undefined)).toBeUndefined();
    expect(normalizeEngine('CODEX')).toBeUndefined();
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
    expect(isAcpEngine('claude')).toBe(false);
    expect(isAcpEngine(undefined)).toBe(false);
  });

  it('isKnownEngine validates route input', () => {
    expect(isKnownEngine('claude')).toBe(true);
    expect(isKnownEngine('codex')).toBe(true);
    expect(isKnownEngine('opencode')).toBe(false);
    expect(isKnownEngine(undefined)).toBe(false);
  });

  it('model catalog source is declared per engine', () => {
    expect(engineCaps('claude').modelCatalog).toBe('static');
    expect(engineCaps('codex').modelCatalog).toBe('provider-advertised');
  });
});
