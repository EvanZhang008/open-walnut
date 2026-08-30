/**
 * engineCaps — the flat capability view the LIVE session surfaces read.
 *
 * This is the ONE place that turns a catalog row into the yes/no answers the
 * chat header, composer and model picker branch on, so its job is to make
 * `engine === '<vendor>'` comparisons unnecessary. What is pinned here:
 *   - the default (native) engine keeps rewind + fork and a STATIC model list,
 *     and labels as "<name> Code" — the attribution the console always showed;
 *   - an ACP engine is the mirror image: provider-advertised models, provider
 *     config options for modes, no rewind/fork, and the bare product name;
 *   - a REGISTERED engine the catalog doesn't carry degrades to the conservative
 *     ACP shape and reports WHY it is unusable, instead of looking installed;
 *   - a string this build doesn't know at all reads as the default engine.
 *   - `unavailableReason` is the HOST-INDEPENDENT half of the lock rule only:
 *     a local-only engine is not "unavailable" here, because this view has no
 *     host to judge against.
 */
import { describe, it, expect } from 'vitest';
import { engineCaps, engineLabel } from '../../web/src/utils/engine-capabilities';
import {
  DEFAULT_ENGINE_CATALOG,
  engineEntry,
  type EngineCatalog,
} from '../../web/src/utils/engines';

/** The two-engine catalog a cold page starts from (claude native + codex ACP). */
const CATALOG: EngineCatalog = DEFAULT_ENGINE_CATALOG;

describe('the default (native) engine', () => {
  const caps = engineCaps('claude', CATALOG);

  it('is native, rewindable and forkable, on a static model list', () => {
    expect(caps.id).toBe('claude');
    expect(caps.isDefault).toBe(true);
    expect(caps.isAcp).toBe(false);
    expect(caps.rewind).toBe(true);
    expect(caps.fork).toBe(true);
    expect(caps.providerModelCatalog).toBe(false);
    expect(caps.configModes).toBe(false);
    expect(caps.installed).toBe(true);
    expect(caps.unavailableReason).toBeNull();
  });

  it('labels as "<name> Code" — a native engine gets the product suffix', () => {
    expect(caps.displayName).toBe('Claude Code');
    expect(engineLabel(engineEntry(CATALOG, 'claude'))).toBe('Claude Code');
  });
});

describe('an ACP engine', () => {
  const caps = engineCaps('codex', CATALOG);

  it('discovers its models from the provider and takes config-option modes', () => {
    expect(caps.id).toBe('codex');
    expect(caps.isAcp).toBe(true);
    expect(caps.providerModelCatalog).toBe(true);
    expect(caps.configModes).toBe(true);
    expect(caps.rewind).toBe(false);
    expect(caps.fork).toBe(false);
    expect(caps.isDefault).toBe(false);
  });

  it('keeps the bare product name — no "Code" suffix for an ACP worker', () => {
    expect(caps.displayName).toBe('Codex');
  });

  it('installed + local-only is NOT an unavailable engine (no host to judge)', () => {
    expect(caps.installed).toBe(true);
    expect(caps.unavailableReason).toBeNull();
  });
});

describe('a registered engine the catalog does not carry', () => {
  // Real case: hydration hasn't landed yet, or an older server's /api/engines
  // answered without this row. 'gemini' is registered in SESSION_ENGINE_IDS but
  // absent from the two compiled-in rows.
  const caps = engineCaps('gemini', CATALOG);

  it('degrades to the conservative ACP shape', () => {
    expect(caps.id).toBe('gemini');
    expect(caps.isAcp).toBe(true);
    expect(caps.providerModelCatalog).toBe(true);
    expect(caps.configModes).toBe(true);
    expect(caps.rewind).toBe(false);
    expect(caps.fork).toBe(false);
    expect(caps.isDefault).toBe(false);
    expect(caps.displayName).toBe('Gemini');
  });

  it('reads as uninstalled WITH a reason, never as silently usable', () => {
    expect(caps.installed).toBe(false);
    expect(caps.unavailableReason).toBe('gemini is not available on this server');
  });
});

describe('an unavailable engine the catalog DOES describe', () => {
  it('passes the server\'s own reason through', () => {
    const catalog: EngineCatalog = [
      ...CATALOG,
      {
        ...engineEntry(CATALOG, 'codex'),
        id: 'goose',
        displayName: 'Goose',
        availability: { installed: false, version: null, reason: 'goose not found on PATH' },
      },
    ];
    const caps = engineCaps('goose', catalog);
    expect(caps.installed).toBe(false);
    expect(caps.unavailableReason).toBe('goose not found on PATH');
    expect(caps.displayName).toBe('Goose');
  });
});

describe('an engine value this build knows nothing about', () => {
  it('reads as the default engine rather than throwing or blanking', () => {
    for (const unknown of ['engine-from-a-newer-build', '', undefined, null, 7, {}]) {
      const caps = engineCaps(unknown, CATALOG);
      expect(caps.id).toBe('claude');
      expect(caps.isDefault).toBe(true);
      expect(caps.isAcp).toBe(false);
      expect(caps.rewind).toBe(true);
      expect(caps.fork).toBe(true);
      expect(caps.displayName).toBe('Claude Code');
      expect(caps.unavailableReason).toBeNull();
    }
  });
});
