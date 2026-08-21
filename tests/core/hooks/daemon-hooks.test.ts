/**
 * Daemon-runtime hooks: YAML loader + compiler (src/core/hooks/daemon-hooks.ts)
 * and the pure rule evaluator they feed (daemon-core evalDaemonHookRules).
 *
 * These lock the Phase 1 contract:
 *  - one self-contained YAML in ~/.open-walnut/hooks/ = one hook; invalid files
 *    are listed with errors but never compiled (fail-closed per file)
 *  - default posture is ZERO hooks — an empty dir compiles to an empty set
 *  - config sugar session.cron_policy:'session-only' compiles the built-in
 *    rule set; a user file with the same id wins
 *  - the evaluator is strict-equality on flat dot-paths, dedups actions, and
 *    skips malformed rules instead of throwing
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { WALNUT_HOME } from '../../../src/constants.js';
import { loadDaemonHookFiles, compileDaemonHooks } from '../../../src/core/hooks/daemon-hooks.js';
import {
  evalDaemonHookRules,
  builtinSessionOnlyCronHook,
  type DaemonHooksConfig,
} from '../../../src/providers/daemon-core.js';
import type { Config } from '../../../src/core/types.js';

const HOOKS_DIR = path.join(WALNUT_HOME, 'hooks');

// Minimal config shims — compileDaemonHooks only reads session.cron_policy.
const cfgOff = { session: {} } as unknown as Config;
const cfgSessionOnly = { session: { cron_policy: 'session-only' } } as unknown as Config;

beforeEach(() => {
  fs.rmSync(HOOKS_DIR, { recursive: true, force: true });
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
});
afterEach(() => {
  fs.rmSync(HOOKS_DIR, { recursive: true, force: true });
});

const write = (name: string, body: string) => fs.writeFileSync(path.join(HOOKS_DIR, name), body);

describe('loadDaemonHookFiles', () => {
  it('returns [] when the hooks dir is missing or empty (zero-hook default)', () => {
    expect(loadDaemonHookFiles()).toEqual([]);
    fs.rmSync(HOOKS_DIR, { recursive: true, force: true });
    expect(loadDaemonHookFiles()).toEqual([]);
  });

  it('loads a valid runtime:daemon hook with rules and defaults enabled:true', () => {
    write('my-hook.yaml', [
      'id: my-hook',
      'runtime: daemon',
      'rules:',
      '  - on: cron.create',
      '    when: { input.durable: true }',
      '    action: deny',
    ].join('\n'));
    const files = loadDaemonHookFiles();
    expect(files).toHaveLength(1);
    expect(files[0].id).toBe('my-hook');
    expect(files[0].enabled).toBe(true);
    expect(files[0].errors).toEqual([]);
    expect(files[0].rules).toEqual([
      { on: 'cron.create', when: { 'input.durable': true }, action: 'deny' },
    ]);
  });

  it('ignores files without runtime:daemon (future server-runtime hooks are not ours)', () => {
    write('server-hook.yaml', 'id: server-hook\nruntime: server\nrules: []');
    write('no-runtime.yaml', 'id: no-runtime\nrules: []');
    expect(loadDaemonHookFiles()).toEqual([]);
  });

  it('flags invalid id / bad point / bad action / non-map when — file listed but has errors', () => {
    write('bad.yaml', [
      'id: Bad_ID!',
      'runtime: daemon',
      'rules:',
      '  - on: cron.create',
      '    action: deny',
      '  - on: not-a-point',
      '    action: deny',
      '  - on: cron.fire',
      '    action: reboot',
      '  - on: cron.fire',
      '    when: [1, 2]',
      '    action: evict',
    ].join('\n'));
    const files = loadDaemonHookFiles();
    expect(files).toHaveLength(1);
    expect(files[0].errors.join(' ')).toMatch(/kebab-case/);
    expect(files[0].errors.join(' ')).toMatch(/rules\[1\]\.on/);
    expect(files[0].errors.join(' ')).toMatch(/rules\[2\]\.action/);
    expect(files[0].errors.join(' ')).toMatch(/rules\[3\]\.when/);
    // The one valid rule still parses — but errors > 0 keeps the file out of compilation.
    expect(files[0].rules).toContainEqual({ on: 'cron.create', action: 'deny' });
  });

  it('an unparseable file is reported, not thrown', () => {
    write('broken.yaml', 'id: [unclosed');
    const files = loadDaemonHookFiles();
    expect(files).toHaveLength(1);
    expect(files[0].errors[0]).toMatch(/unreadable/);
  });

  it('a valid file with zero rules is an error (nothing to push is a mistake, not a hook)', () => {
    write('empty.yaml', 'id: empty\nruntime: daemon\nrules: []');
    const files = loadDaemonHookFiles();
    expect(files[0].errors).toContain('no valid rules');
  });
});

describe('compileDaemonHooks', () => {
  it('empty dir + no config sugar → zero hooks, stable version/hash shape', () => {
    const out = compileDaemonHooks(cfgOff);
    expect(out.version).toBe(1);
    expect(out.hooks).toEqual([]);
    expect(out.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('invalid files are never compiled (fail-closed per file)', () => {
    write('bad.yaml', 'id: bad\nruntime: daemon\nrules:\n  - on: nope\n    action: deny');
    write('good.yaml', 'id: good\nruntime: daemon\nrules:\n  - on: session.reap\n    action: strip-own-rows');
    const out = compileDaemonHooks(cfgOff);
    expect(out.hooks.map((h) => h.id)).toEqual(['good']);
  });

  it("config sugar session.cron_policy:'session-only' compiles the built-in rule set", () => {
    const out = compileDaemonHooks(cfgSessionOnly);
    expect(out.hooks).toEqual([builtinSessionOnlyCronHook()]);
  });

  it('a user file with id session-only-cron wins over the config sugar', () => {
    write('mine.yaml', [
      'id: session-only-cron',
      'runtime: daemon',
      'enabled: false',
      'rules:',
      '  - on: session.reap',
      '    action: strip-own-rows',
    ].join('\n'));
    const out = compileDaemonHooks(cfgSessionOnly);
    expect(out.hooks).toHaveLength(1);
    expect(out.hooks[0].enabled).toBe(false);
    expect(out.hooks[0].rules).toEqual([{ on: 'session.reap', action: 'strip-own-rows' }]);
  });

  it('hash is deterministic across calls and changes when rules change', () => {
    write('a.yaml', 'id: aaa\nruntime: daemon\nrules:\n  - on: cron.fire\n    when: { foreign: true }\n    action: evict');
    const h1 = compileDaemonHooks(cfgOff).hash;
    expect(compileDaemonHooks(cfgOff).hash).toBe(h1);
    write('a.yaml', 'id: aaa\nruntime: daemon\nrules:\n  - on: cron.fire\n    when: { foreign: true }\n    action: log');
    expect(compileDaemonHooks(cfgOff).hash).not.toBe(h1);
  });

  it('the shipped template YAML compiles to exactly the built-in rule set — SAME hash', () => {
    // The template must never drift from builtinSessionOnlyCronHook — a user
    // installing the file gets byte-for-byte what the config sugar compiles.
    // Hash equality is the real contract (toEqual is key-order insensitive,
    // JSON.stringify → sha256 is not): a differing hash would make the daemon
    // log a spurious changed:true rewrite when the user installs the file.
    const sugarHash = compileDaemonHooks(cfgSessionOnly).hash;
    const tpl = fs.readFileSync(
      path.join(process.cwd(), 'src/data/hook-templates/session-only-cron.yaml'), 'utf-8');
    write('session-only-cron.yaml', tpl);
    const out = compileDaemonHooks(cfgOff);
    expect(out.hooks).toEqual([builtinSessionOnlyCronHook()]);
    expect(out.hash).toBe(sugarHash);
  });

  it('duplicate ids: first file (alphabetical) wins, the loser is skipped', () => {
    // A stale copy (x.yaml + x-backup.yaml, same id) must not double-compile:
    // the daemon UNIONS actions across hooks, so enabled:false on one copy
    // would not shadow the other. First-wins keeps behavior deterministic.
    write('a-first.yaml', 'id: dup\nruntime: daemon\nrules:\n  - on: cron.fire\n    when: { foreign: true }\n    action: evict');
    write('b-second.yaml', 'id: dup\nruntime: daemon\nenabled: false\nrules:\n  - on: session.reap\n    action: strip-own-rows');
    const out = compileDaemonHooks(cfgOff);
    expect(out.hooks).toHaveLength(1);
    expect(out.hooks[0].enabled).toBe(true);
    expect(out.hooks[0].rules[0].action).toBe('evict');
  });

  it('an INVALID user file with id session-only-cron still suppresses the config sugar', () => {
    // The user deliberately edited (and broke) their copy — silently
    // substituting the built-in rules would resurrect rules they removed.
    write('mine.yaml', 'id: session-only-cron\nruntime: daemon\nrules:\n  - on: nope\n    action: deny');
    const out = compileDaemonHooks(cfgSessionOnly);
    expect(out.hooks).toEqual([]);
  });

  it('nested when values are rejected loudly (strict equality would never match them)', () => {
    write('nested.yaml', [
      'id: nested',
      'runtime: daemon',
      'rules:',
      '  - on: cron.create',
      '    when:',
      '      input:',
      '        durable: true',
      '    action: deny',
    ].join('\n'));
    const files = loadDaemonHookFiles();
    expect(files[0].errors.join(' ')).toMatch(/must be a primitive/);
    expect(compileDaemonHooks(cfgOff).hooks).toEqual([]);
  });
});

describe('evalDaemonHookRules (pure evaluator, mirrored into both daemon twins)', () => {
  const config: DaemonHooksConfig = { version: 1, hash: 'x', hooks: [builtinSessionOnlyCronHook()] };

  it('matches the built-in set at every point', () => {
    expect(evalDaemonHookRules(config, 'cron.create', { input: { durable: true } })).toEqual(['deny']);
    expect(evalDaemonHookRules(config, 'cron.create', { input: { durable: false } })).toEqual([]);
    expect(evalDaemonHookRules(config, 'cron.create', { input: {} })).toEqual([]);
    expect(evalDaemonHookRules(config, 'cron.created', { input: { durable: true } })).toEqual(['inject']);
    expect(evalDaemonHookRules(config, 'cron.fire', { foreign: true })).toEqual(['evict']);
    expect(evalDaemonHookRules(config, 'cron.fire', { foreign: false })).toEqual([]);
    expect(evalDaemonHookRules(config, 'session.reap', { sid: 's', cwd: '/x' })).toEqual(['strip-own-rows']);
  });

  it('strict equality: string "true" does not match boolean true', () => {
    expect(evalDaemonHookRules(config, 'cron.create', { input: { durable: 'true' } })).toEqual([]);
  });

  it('null config / disabled hook / malformed rules yield [] without throwing', () => {
    expect(evalDaemonHookRules(null, 'cron.create', {})).toEqual([]);
    const disabled: DaemonHooksConfig = {
      version: 1, hash: 'x',
      hooks: [{ ...builtinSessionOnlyCronHook(), enabled: false }],
    };
    expect(evalDaemonHookRules(disabled, 'cron.create', { input: { durable: true } })).toEqual([]);
    const malformed = {
      version: 1, hash: 'x',
      hooks: [{ id: 'm', enabled: true, rules: [null, 42, { on: 'cron.create' }, { action: 'deny' }] }],
    } as unknown as DaemonHooksConfig;
    expect(evalDaemonHookRules(malformed, 'cron.create', { input: { durable: true } })).toEqual([]);
  });

  it('dedups the same action across hooks and preserves rule order', () => {
    const two: DaemonHooksConfig = {
      version: 1, hash: 'x',
      hooks: [
        { id: 'a', enabled: true, rules: [{ on: 'cron.fire', action: 'log' }, { on: 'cron.fire', when: { foreign: true }, action: 'evict' }] },
        { id: 'b', enabled: true, rules: [{ on: 'cron.fire', action: 'log' }] },
      ],
    };
    expect(evalDaemonHookRules(two, 'cron.fire', { foreign: true })).toEqual(['log', 'evict']);
    expect(evalDaemonHookRules(two, 'cron.fire', { foreign: false })).toEqual(['log']);
  });

  it('dot-paths walk nested ctx; missing paths are undefined (no match, no throw)', () => {
    const cfg: DaemonHooksConfig = {
      version: 1, hash: 'x',
      hooks: [{ id: 'd', enabled: true, rules: [{ on: 'cron.create', when: { 'input.schedule.cron': '* * * * *' }, action: 'log' }] }],
    };
    expect(evalDaemonHookRules(cfg, 'cron.create', { input: { schedule: { cron: '* * * * *' } } })).toEqual(['log']);
    expect(evalDaemonHookRules(cfg, 'cron.create', { input: {} })).toEqual([]);
    expect(evalDaemonHookRules(cfg, 'cron.create', {})).toEqual([]);
  });
});
