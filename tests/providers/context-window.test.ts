import { describe, it, expect } from 'vitest';
import {
  resolveContextWindow, shortModelId, isRecognizedClaudeModel,
  rememberAutoCompactWindow, recallAutoCompactWindow,
  rememberEnvMaxContextTokens, recallEnvMaxContextTokens,
  rememberModelWindow, recallModelWindow, resetContextWindowCaches,
  knownModelWindow, recallModelWindowAnyHost, onModelWindowLearned, learnedModelWindows, seedModelWindows,
  ANTHROPIC_DEFAULT_WINDOW, EXTENDED_WINDOW, hasNativeExtendedWindow, modelNameWindowEstimate, isExactWindowSource,
} from '../../src/providers/context-window.js';
import { MODEL_CATALOG } from '../../src/model/providers/model-catalog.js';

// The percentages this module decides are the ones on the session badge. The
// incident it exists for (inc-1787517631989-wpy5i3, 2026-08-23): one session on
// a custom proxy model showed 70% → 25% → 10% as three different denominators
// arrived, and 9% on the badge next to "99.4K / 400K (25%)" in the picker.
//
// The denominator is the MODEL'S ABSOLUTE MAX. The auto-compact window is a
// setting, not a property of the model, so it never moves this number.

describe('resolveContextWindow', () => {
  it('prefers the window the CLI itself reported for this model', () => {
    // result.modelUsage[model].contextWindow. Live-verified on 2.1.240: 1M for
    // gpt-5.6-sol, opus-5[1m] and fable[1m] alike.
    expect(resolveContextWindow({
      cliModelWindow: 1_000_000,
      hostModelWindow: 400_000,
      envMaxContextTokens: 272_000,
      model: 'gpt-5.6-sol',
      observedTokens: 99_366,
    })).toEqual({ window: 1_000_000, source: 'cli-model-usage', estimate: false });
  });

  it('an auto-compact clamp does NOT shrink the denominator', () => {
    // The reversal: 99K of a 1M model is 10%, whatever the compact setting says.
    // Folding the clamp in is what made the badge and the picker disagree.
    const resolved = resolveContextWindow({ cliModelWindow: 1_000_000, model: 'claude-fable-5[1m]' });
    expect(resolved?.window).toBe(1_000_000);
  });

  it('falls back to what an earlier session on this host+model learned', () => {
    expect(resolveContextWindow({ hostModelWindow: 1_000_000, model: 'gpt-5.6-sol' }))
      .toEqual({ window: 1_000_000, source: 'host-model-cache', estimate: false });
  });

  it('uses CLAUDE_CODE_MAX_CONTEXT_TOKENS for a model the CLI does not recognize', () => {
    // The CLI's own words for an unrecognized model: "set
    // CLAUDE_CODE_MAX_CONTEXT_TOKENS to its real window".
    expect(resolveContextWindow({ envMaxContextTokens: 1_000_000, model: 'gpt-5.6-sol' }))
      .toEqual({ window: 1_000_000, source: 'env-max-tokens', estimate: true });
  });

  it('IGNORES that env var for a recognized Claude model — the CLI does too', () => {
    // Trusting it here would invent a 1M window for a 200K model.
    expect(resolveContextWindow({ envMaxContextTokens: 1_000_000, model: 'claude-sonnet-4-6' }))
      .toEqual({ window: ANTHROPIC_DEFAULT_WINDOW, source: 'model-string', estimate: true });
    expect(resolveContextWindow({ envMaxContextTokens: 1_000_000, model: 'global.anthropic.claude-fable-5[1m]' }))
      .toEqual({ window: EXTENDED_WINDOW, source: 'model-string', estimate: true });
  });

  it('returns NOTHING for a custom model with no CLI-sourced window', () => {
    // The regression: an Anthropic-shaped 200K guess made 99K read as 50%,
    // which collapsed to 10% one turn later. No number beats a wrong number.
    expect(resolveContextWindow({ model: 'gpt-5.6-sol', observedTokens: 99_366 })).toBeNull();
    expect(resolveContextWindow({ model: 'bedrock_mantle/openai.gpt-5.6-sol' })).toBeNull();
    expect(resolveContextWindow({})).toBeNull();
  });

  it('reads the [1m] marker, and the 200K default for plain Anthropic ids', () => {
    expect(resolveContextWindow({ model: 'claude-sonnet-4-6[1m]' }))
      .toEqual({ window: EXTENDED_WINDOW, source: 'model-string', estimate: true });
    expect(resolveContextWindow({ model: 'claude-sonnet-4-6' }))
      .toEqual({ window: ANTHROPIC_DEFAULT_WINDOW, source: 'model-string', estimate: true });
    // Family name without the "claude-" prefix still reads as Anthropic.
    expect(resolveContextWindow({ model: 'opus[1m]' }))
      .toEqual({ window: EXTENDED_WINDOW, source: 'model-string', estimate: true });
  });

  it('trusts observed tokens over a lost [1m] suffix', () => {
    expect(resolveContextWindow({ model: 'claude-sonnet-4-6', observedTokens: 250_000 })?.window)
      .toBe(EXTENDED_WINDOW);
  });

  // 2026-11-06, the user's Mac app: "Context 324.4K / 200K (162%)" on Opus 5.5, which runs a 1M
  // window as `claude-opus-5-5` with no `[1m]`. The session's turn was still running, so no
  // modelUsage reading had come; its CLI had answered a 500K effective window at its start, and
  // its record held a 200K guess an earlier attach wrote.
  it('reads the 1M window of a model with 1M built in, with no [1m] in its id', () => {
    for (const model of ['claude-opus-5-5', 'global.anthropic.claude-opus-5-5', 'claude-opus-5', 'global.anthropic.claude-haiku-5-5']) {
      expect(resolveContextWindow({ model })).toEqual({ window: EXTENDED_WINDOW, source: 'model-string', estimate: true });
    }
    expect(resolveContextWindow({ model: 'claude-opus-4-8' })?.window).toBe(ANTHROPIC_DEFAULT_WINDOW);
  });

  it('every guess is lifted to the effective window the CLI reported and to the tokens held', () => {
    // The incident: an unknown-to-the-catalog 1M model, a 500K effective window, a stored 200K.
    const model = 'claude-opus-9'; // a Claude id no catalog row names yet
    expect(resolveContextWindow({ model })?.window).toBe(ANTHROPIC_DEFAULT_WINDOW);
    expect(resolveContextWindow({ model, effectiveWindow: 500_000 }))
      .toEqual({ window: EXTENDED_WINDOW, source: 'floor', estimate: true });
    expect(resolveContextWindow({ model, recordWindow: 200_000, effectiveWindow: 500_000, observedTokens: 324_400 }))
      .toEqual({ window: EXTENDED_WINDOW, source: 'floor', estimate: true });
    expect(resolveContextWindow({ model, hostModelWindow: 200_000, observedTokens: 324_400 })?.window).toBe(EXTENDED_WINDOW);
    // A record or cache at or above the floor stands.
    expect(resolveContextWindow({ model, recordWindow: 1_000_000, observedTokens: 324_400 }))
      .toEqual({ window: 1_000_000, source: 'record', estimate: true });
    // An effective window at or below 200K proves nothing more.
    expect(resolveContextWindow({ model, effectiveWindow: 180_000 })?.window).toBe(ANTHROPIC_DEFAULT_WINDOW);
    // A model that is not Anthropic's is lifted to the floor itself, never to a made-up 1M.
    expect(resolveContextWindow({ model: 'my-proxy', envMaxContextTokens: 128_000, observedTokens: 300_000 }))
      .toEqual({ window: 300_000, source: 'floor', estimate: true });
    // The session's own reading is never second-guessed.
    expect(resolveContextWindow({ model, cliModelWindow: 1_000_000, effectiveWindow: 500_000 }))
      .toEqual({ window: 1_000_000, source: 'cli-model-usage', estimate: false });
  });

  it('only the CLI\'s own readings are restored as exact', () => {
    expect(isExactWindowSource('cli-model-usage')).toBe(true);
    expect(isExactWindowSource('host-model-cache')).toBe(true);
    for (const s of ['model-string', 'record', 'floor', 'env-max-tokens', undefined] as const) expect(isExactWindowSource(s)).toBe(false);
  });

  // The class guard: every Claude id the catalog marks 1M-native reads 1M from its id alone, in
  // each spelling a session reports it by. A new native-1M row is covered the day it is added.
  it('every catalog model with 1M built in reads 1M in every spelling', () => {
    const native = [...MODEL_CATALOG.bedrock ?? [], ...MODEL_CATALOG.anthropic ?? []].filter((m) => m.compat?.native_1m);
    expect(native.length).toBeGreaterThan(3);
    for (const m of native) {
      const short = shortModelId(m.id);
      for (const id of [m.id, short, `global.anthropic.${short}`, `${short}[1m]`]) {
        expect(hasNativeExtendedWindow(id) || id.endsWith('[1m]'), id).toBe(true);
        expect(modelNameWindowEstimate(id), id).toBe(EXTENDED_WINDOW);
      }
    }
    for (const m of [...MODEL_CATALOG.bedrock ?? [], ...MODEL_CATALOG.anthropic ?? []]) {
      if (m.compat?.native_1m || (m.context_window ?? 0) >= 1_000_000) continue;
      expect(modelNameWindowEstimate(m.id), m.id).toBe(ANTHROPIC_DEFAULT_WINDOW);
    }
  });

  it('ignores zero / negative / non-finite windows', () => {
    expect(resolveContextWindow({ cliModelWindow: 0, hostModelWindow: 1_000_000 })?.source)
      .toBe('host-model-cache');
    expect(resolveContextWindow({ cliModelWindow: Number.NaN, model: 'claude-sonnet-4-6' })?.source)
      .toBe('model-string');
    expect(resolveContextWindow({ envMaxContextTokens: -1, model: 'gpt-5.6-sol' })).toBeNull();
  });
});

describe('isRecognizedClaudeModel', () => {
  it('sees through transport / region / provider decoration', () => {
    expect(isRecognizedClaudeModel('global.anthropic.claude-opus-5[1m]')).toBe(true);
    expect(isRecognizedClaudeModel('bedrock_mantle/openai.gpt-5.6-sol')).toBe(false);
    expect(isRecognizedClaudeModel('fable')).toBe(true);
    expect(isRecognizedClaudeModel(undefined)).toBe(false);
  });
});

describe('host+model window cache', () => {
  // The exact window only arrives at a turn END, so without this cache every
  // session spends its first turn on a guess (or, for a proxy model, on no
  // percentage) and then jumps.
  it('answers for later sessions on the same host+model only', () => {
    resetContextWindowCaches();
    expect(recallModelWindow(null, 'gpt-5.6-sol')).toBeUndefined();
    rememberModelWindow(null, 'gpt-5.6-sol', 1_000_000);
    expect(recallModelWindow(null, 'gpt-5.6-sol')).toBe(1_000_000);
    expect(recallModelWindow(null, 'GPT-5.6-SOL')).toBe(1_000_000); // case-insensitive
    expect(recallModelWindow('clouddev', 'gpt-5.6-sol')).toBeUndefined();
    expect(recallModelWindow(null, 'claude-sonnet-4-6')).toBeUndefined();
  });

  it('ignores nonsense and a missing model', () => {
    resetContextWindowCaches();
    rememberModelWindow(null, 'x', 0);
    rememberModelWindow(null, undefined, 1_000_000);
    expect(recallModelWindow(null, 'x')).toBeUndefined();
    expect(recallModelWindow(null, undefined)).toBeUndefined();
  });
});

describe('CLAUDE_CODE_MAX_CONTEXT_TOKENS cache (host-scoped)', () => {
  it('shares per host', () => {
    resetContextWindowCaches();
    rememberEnvMaxContextTokens(null, 1_000_000);
    expect(recallEnvMaxContextTokens(null)).toBe(1_000_000);
    expect(recallEnvMaxContextTokens('clouddev')).toBeUndefined();
  });
});

describe('auto-compact clamp cache (host-scoped)', () => {
  // Live WS capture right after a server restart: one fable[1m] session reported
  // window 1000000 (20%) while another reported 400000 (89%) — the second had
  // completed its get_settings read, the first had not. The clamp is a HOST
  // property, so the first read answers for every session on that host.
  it('shares a clamp across sessions on the same host, and only that host', () => {
    resetContextWindowCaches();
    expect(recallAutoCompactWindow(null)).toBeUndefined();
    rememberAutoCompactWindow(null, 400_000);
    expect(recallAutoCompactWindow(null)).toBe(400_000);
    expect(recallAutoCompactWindow(undefined)).toBe(400_000); // undefined ≡ local
    expect(recallAutoCompactWindow('clouddev')).toBeUndefined(); // remote is separate
    rememberAutoCompactWindow('clouddev', 200_000);
    expect(recallAutoCompactWindow('clouddev')).toBe(200_000);
    expect(recallAutoCompactWindow(null)).toBe(400_000);
  });

  it('ignores a nonsense clamp', () => {
    resetContextWindowCaches();
    rememberAutoCompactWindow(null, 0);
    rememberAutoCompactWindow(null, Number.NaN);
    rememberAutoCompactWindow(null, -5);
    expect(recallAutoCompactWindow(null)).toBeUndefined();
  });
});

describe('shortModelId', () => {
  it('keeps a version dot inside the model id', () => {
    // The old rule was `replace(/^.*\./, '')` — greedy, so it ate "gpt-5." and
    // the composer badge read "6-sol 9%" (2026-08-23 screenshot).
    expect(shortModelId('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(shortModelId('openai.gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(shortModelId('bedrock_mantle/openai.gpt-5.6-sol')).toBe('gpt-5.6-sol');
  });

  it('strips region + provider prefixes and the revision suffix, keeping [1m]', () => {
    expect(shortModelId('global.anthropic.claude-fable-5[1m]')).toBe('claude-fable-5[1m]');
    expect(shortModelId('us.anthropic.claude-opus-4-6-v1')).toBe('claude-opus-4-6');
    expect(shortModelId('us.anthropic.claude-sonnet-4-6-v1:0')).toBe('claude-sonnet-4-6');
    expect(shortModelId('us.anthropic.claude-opus-4-6-v1[1m]')).toBe('claude-opus-4-6[1m]');
    expect(shortModelId('us-gov-west-1.anthropic.claude-opus-4-6')).toBe('claude-opus-4-6');
  });

  it('leaves anything it does not recognize alone', () => {
    expect(shortModelId('claude-haiku-4-5')).toBe('claude-haiku-4-5');
    expect(shortModelId('my-lab.custom-model-2.1')).toBe('my-lab.custom-model-2.1');
    expect(shortModelId('default')).toBe('default');
  });
});

// 2026-11-07, the user: "find the actual model context window for the current model ... not by
// string matching which is flaky". The CLI's own numbers come first and are kept; a name rule is
// the last resort and says it is an estimate.
describe('the window from the real source', () => {
  it('an unclamped get_context_usage reading is exact, before any turn ends', () => {
    // CLI 2.1.312, Opus 5.5 with no auto-compact setting: maxTokens 1000000, autocompactSource "auto".
    expect(resolveContextWindow({ cliUnclampedWindow: 1_000_000, effectiveWindow: 1_000_000, model: 'global.anthropic.claude-opus-5-5' }))
      .toEqual({ window: 1_000_000, source: 'cli-context-usage', estimate: false });
    // The turn-end reading still outranks it.
    expect(resolveContextWindow({ cliModelWindow: 400_000, cliUnclampedWindow: 1_000_000 }).source).toBe('cli-model-usage');
  });

  it('a usage read never replaces a turn-end reading in the cache', () => {
    resetContextWindowCaches();
    rememberModelWindow('clouddev', 'claude-opus-5-5', 1_000_000);
    rememberModelWindow('clouddev', 'claude-opus-5-5', 500_000, 'cli-context-usage');
    expect(recallModelWindow('clouddev', 'claude-opus-5-5')).toBe(1_000_000);
    // A turn end replaces anything.
    rememberModelWindow('clouddev', 'claude-opus-5-5', 900_000);
    expect(recallModelWindow('clouddev', 'claude-opus-5-5')).toBe(900_000);
  });

  it('a place with no session reads the CLI\'s number from any host, else the name as an estimate', () => {
    resetContextWindowCaches();
    // A proxy model the name rule cannot name at all.
    expect(knownModelWindow('__local__', 'gpt-6.1-sol')).toBeNull();
    rememberModelWindow('clouddev', 'openai.gpt-6.1-sol', 400_000);
    expect(knownModelWindow('clouddev', 'gpt-6.1-sol')).toEqual({ window: 400_000, source: 'host-model-cache', estimate: false });
    // Another host's alias may name another model there: never taken for this host's.
    expect(knownModelWindow('__local__', 'gpt-6.1-sol')).toBeNull();
    // A place with no host of its own reads it, as an estimate.
    expect(knownModelWindow(null, 'gpt-6.1-sol')).toEqual({ window: 400_000, source: 'host-model-cache', estimate: true });
    expect(recallModelWindowAnyHost('gpt-6.1-sol')).toBe(400_000);
    expect(knownModelWindow(null, 'claude-opus-5-5')).toEqual({ window: EXTENDED_WINDOW, source: 'model-string', estimate: true });
  });

  it('the cache round-trips through the store and keeps only exact readings', () => {
    resetContextWindowCaches();
    const told: string[] = [];
    onModelWindowLearned((key) => told.push(key));
    rememberModelWindow('mac', 'global.anthropic.claude-opus-5-5', 1_000_000);
    rememberModelWindow('mac', 'global.anthropic.claude-opus-5-5', 1_000_000); // same again: no news
    onModelWindowLearned(undefined);
    expect(told).toEqual(['mac::claude-opus-5-5']);
    const saved = learnedModelWindows();
    resetContextWindowCaches();
    const n = seedModelWindows({
      ...saved,
      'mac::bogus': { window: 200_000, source: 'model-string' as never, at: 1 },
      'nohost': { window: 1, source: 'cli-model-usage', at: 1 },
    });
    expect(n).toBe(1);
    expect(recallModelWindow('mac', 'claude-opus-5-5')).toBe(1_000_000);
    expect(recallModelWindow('mac', 'bogus')).toBeUndefined();
  });

  it('every exact source says so, every other one is an estimate', () => {
    for (const s of ['cli-model-usage', 'host-model-cache', 'cli-context-usage', 'engine']) expect(isExactWindowSource(s), s).toBe(true);
    expect(resolveContextWindow({ model: 'claude-opus-4-8' })?.estimate).toBe(true);
    expect(resolveContextWindow({ model: 'claude-opus-4-8', observedTokens: 300_000 })).toEqual({ window: EXTENDED_WINDOW, source: 'floor', estimate: true });
  });
});

describe('the CLI\'s own reading under a session that holds more', () => {
  // 2026-11-08, the user's Mac: Claude Code 2.1.284 reports contextWindow 200000 for a plain
  // `claude-opus-5-5` (2.1.312 on another host reports 1000000). A session holding 324K runs a
  // larger window than that, so the reading is lifted and shown as an estimate: never 162%.
  it('is lifted to the floor and flagged, never read over 100%', () => {
    expect(resolveContextWindow({ cliModelWindow: 200_000, observedTokens: 324_400, model: 'global.anthropic.claude-opus-5-5' }))
      .toEqual({ window: EXTENDED_WINDOW, source: 'floor', estimate: true });
    expect(resolveContextWindow({ cliModelWindow: 200_000, observedTokens: 150_000, model: 'claude-opus-5-5' }))
      .toEqual({ window: 200_000, source: 'cli-model-usage', estimate: false });
  });
});
