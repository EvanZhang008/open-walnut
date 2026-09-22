/**
 * Settings › Engines — the "Default engine for new sessions" picker's logic.
 *
 * The save shape is the assertion with teeth: `updateConfig` replaces a whole
 * top-level key, so a patch of `{ defaults: { engine } }` would delete the
 * default task priority, the default platform and the default project. That
 * class of bug is invisible in the UI (the picker works; something unrelated
 * quietly resets), which is why it is pinned here rather than in a browser spec.
 */
import { describe, it, expect } from 'vitest';
import type { Config } from '@open-walnut/core';
import { DEFAULT_ENGINE_CATALOG, type EngineCatalog } from '@/utils/engines';
import {
  currentDefaultEngine,
  defaultEngineOptions,
  defaultEngineSave,
} from '@/components/settings/sections/default-engine-select';

function config(defaults: Record<string, unknown>): Config {
  return { version: 1, user: {}, defaults, provider: { type: 'claude-code' } } as unknown as Config;
}

/** The catalog as the page sees it after hydration, with availability per row. */
function catalog(rows: Array<{ id: string; installed: boolean; name?: string }>): EngineCatalog {
  return rows.map(({ id, installed, name }) => ({
    id: id as EngineCatalog[number]['id'],
    displayName: name ?? id,
    runtimeKind: id === 'claude' ? 'native' : 'acp',
    isDefault: id === 'claude',
    localOnly: id !== 'claude',
    capabilities: {
      rewind: false, fork: false, modelCatalog: 'static', modeControl: 'claude-modes',
      idProvisioning: 'preassigned', settings: false,
    },
    availability: { installed, version: null, reason: installed ? null : 'not installed' },
  }));
}

describe('currentDefaultEngine', () => {
  it('reads the configured engine, and answers claude for everything else', () => {
    expect(currentDefaultEngine(config({ priority: 'none' }))).toBe('claude');
    expect(currentDefaultEngine(config({ priority: 'none', engine: 'codex' }))).toBe('codex');
    expect(currentDefaultEngine(config({ priority: 'none', engine: 'claude' }))).toBe('claude');
    // Same degrade rule as the server's reader: a hand-edited typo, a value from
    // a newer build, a non-string — never an empty select.
    expect(currentDefaultEngine(config({ priority: 'none', engine: 'codx' }))).toBe('claude');
    expect(currentDefaultEngine(config({ priority: 'none', engine: 7 }))).toBe('claude');
    expect(currentDefaultEngine(undefined)).toBe('claude');
  });
});

describe('defaultEngineOptions', () => {
  it('offers only installed engines, in catalog order', () => {
    const rows = defaultEngineOptions(
      catalog([
        { id: 'claude', installed: true, name: 'Claude' },
        { id: 'codex', installed: true, name: 'Codex' },
        { id: 'gemini', installed: false, name: 'Gemini' },
      ]),
      'claude',
    );
    expect(rows.map((r) => r.id)).toEqual(['claude', 'codex']);
    expect(rows.every((r) => r.installed)).toBe(true);
    expect(rows[1]!.label).toBe('Codex');
  });

  it('keeps the CONFIGURED engine listed even when it is not installed', () => {
    // Otherwise the select would show claude while the config says gemini, and
    // one stray change event would silently rewrite the user's setting.
    const rows = defaultEngineOptions(
      catalog([
        { id: 'claude', installed: true, name: 'Claude' },
        { id: 'gemini', installed: false, name: 'Gemini' },
      ]),
      'gemini',
    );
    expect(rows[0]).toEqual({ id: 'gemini', label: 'Gemini (not installed)', installed: false });
    expect(rows.map((r) => r.id)).toEqual(['gemini', 'claude']);
  });

  it('survives a configured engine the catalog does not carry at all', () => {
    const rows = defaultEngineOptions(catalog([{ id: 'claude', installed: true }]), 'goose');
    expect(rows[0]!.label).toBe('goose (not installed)');
    expect(rows.map((r) => r.id)).toContain('claude');
  });

  it('works against the compiled-in catalog a cold page paints from', () => {
    const rows = defaultEngineOptions(DEFAULT_ENGINE_CATALOG, 'claude');
    expect(rows.map((r) => r.id)).toEqual(['claude', 'codex']);
  });
});

describe('defaultEngineSave', () => {
  it('sets the engine and keeps every sibling under defaults', () => {
    const before = config({
      priority: 'important', platform: 'local', project: 'Walnut',
    });
    const patch = defaultEngineSave(before, 'codex');
    expect(patch).toEqual({
      defaults: { priority: 'important', platform: 'local', project: 'Walnut', engine: 'codex' },
    });
    // Only `defaults` is patched — the section must not resend unrelated sections.
    expect(Object.keys(patch)).toEqual(['defaults']);
    // And the source config is untouched (the page renders from it until the
    // server answers).
    expect(before.defaults.engine).toBeUndefined();
  });

  it('replaces a previous pick without dropping siblings', () => {
    const patch = defaultEngineSave(
      config({ priority: 'none', project: 'Inbox things', engine: 'codex' }),
      'claude',
    );
    expect(patch.defaults).toEqual({ priority: 'none', project: 'Inbox things', engine: 'claude' });
  });
});
