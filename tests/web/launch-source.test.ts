/**
 * The draft's side of a project's launch defaults (web/src/utils/launch-source.ts): what a draft
 * shows and where each value comes from (task > project > folder memory > global), and what its
 * Start sends (the project's values are left to the server; an own pick is sent, Claude Code
 * spelled out when the silence would start something else).
 */
import { describe, expect, it } from 'vitest';
import {
  defaultEngineRuns, draftLaunchChoice, draftLaunchPayload, launchSourceRows, sameModel, sessionLaunchFrom, unnamedLaunchIsNotClaude,
} from '@/utils/launch-source';

const PROJECT = { project: 'Walnut', engine: 'claude' as const, model: 'sonnet', mode: 'accept' as const };

describe('draftLaunchChoice', () => {
  it('no project defaults: the global engine and mode, as before', () => {
    const c = draftLaunchChoice({ meta: {} }, {}, 'codex');
    expect(c).toMatchObject({ engine: 'codex', model: undefined, mode: 'bypass', from: { engine: 'global', model: 'global', mode: 'global' } });
    expect(c.project).toBeUndefined();
  });

  it("the project's pair and mode when the draft picked none", () => {
    const c = draftLaunchChoice({ meta: {} }, PROJECT, 'codex');
    expect(c).toMatchObject({ engine: undefined, model: 'sonnet', mode: 'accept', project: 'Walnut', from: { engine: 'project', model: 'project', mode: 'project' } });
  });

  it("the project's engine wins over the folder's memory; the memory wins over the global", () => {
    const remembered = { meta: { engine: 'codex' as const, model: 'gpt-5.5' } };
    expect(draftLaunchChoice(remembered, PROJECT).from.engine).toBe('project');
    expect(draftLaunchChoice(remembered, {}).from).toMatchObject({ engine: 'folder', model: 'folder' });
  });

  it("the draft's own pick wins, pair and mode each on its own", () => {
    // An engine picked alone leaves its model to the engine: Default, not the task's.
    expect(draftLaunchChoice({ meta: { engine: 'codex' }, metaTouched: true }, {}).from).toMatchObject({ engine: 'task', model: 'global' });
    const own = draftLaunchChoice({ meta: { model: 'opus' }, metaTouched: true }, PROJECT);
    expect(own).toMatchObject({ model: 'opus', mode: 'accept', from: { engine: 'task', model: 'task', mode: 'project' } });
    const ownMode = draftLaunchChoice({ meta: { mode: 'plan' } }, PROJECT);
    expect(ownMode).toMatchObject({ mode: 'plan', from: { engine: 'project', mode: 'task' } });
  });

  it("a project engine that does not run where the draft launches gives way, as on the server", () => {
    const codex = { project: 'Walnut', engine: 'codex' as const, model: 'gpt-5.5', mode: 'plan' as const };
    const c = draftLaunchChoice({ meta: {} }, codex, 'claude', () => false);
    expect(c).toMatchObject({ engine: undefined, model: undefined, mode: 'plan', skipped: 'codex', project: 'Walnut', from: { engine: 'global', model: 'global', mode: 'project' } });
    // The folder's memory still applies under it.
    expect(draftLaunchChoice({ meta: { model: 'opus' } }, codex, 'claude', () => false).from.model).toBe('folder');
    expect(draftLaunchChoice({ meta: {} }, codex, 'claude', () => true).from.engine).toBe('project');
  });

  it('a project that sets only a mode leaves the pair to the global default', () => {
    const c = draftLaunchChoice({ meta: {} }, { project: 'Walnut', mode: 'plan' });
    expect(c.from).toEqual({ engine: 'global', model: 'global', mode: 'project' });
  });
});

describe('defaultEngineRuns', () => {
  const entry = (id: string, runtimeKind: 'native' | 'acp', installed = true) =>
    ({ id, displayName: id, runtimeKind, isDefault: false, localOnly: false, availability: { installed } }) as never;
  const catalog = [entry('claude', 'native'), entry('codex', 'acp'), entry('gemini', 'acp', false)];

  it("follows the server's rule for an engine nobody named: no ACP engine on a remote host", () => {
    expect(defaultEngineRuns('codex', '', catalog)).toBe(true);
    expect(defaultEngineRuns('codex', '__local__', catalog)).toBe(true);
    expect(defaultEngineRuns('codex', 'clouddev', catalog), 'catalog says not local-only, the server still gives way').toBe(false);
    expect(defaultEngineRuns('gemini', '', catalog), 'not installed').toBe(false);
    expect(defaultEngineRuns('claude', 'clouddev', catalog)).toBe(true);
  });
});

describe('draftLaunchPayload', () => {
  it("leaves the project's values to the server", () => {
    const meta = {};
    const c = draftLaunchChoice({ meta }, PROJECT);
    expect(draftLaunchPayload(c, meta, unnamedLaunchIsNotClaude(PROJECT))).toEqual({ engine: undefined, model: undefined, mode: undefined });
  });

  it("names Claude Code for an own Default model over the project's model", () => {
    const meta = {};
    const c = draftLaunchChoice({ meta, metaTouched: true }, PROJECT);
    expect(draftLaunchPayload(c, meta, unnamedLaunchIsNotClaude(PROJECT))).toEqual({ engine: 'claude', model: undefined, mode: undefined });
  });

  it('names Claude Code over a global engine that is not, and stays silent with no defaults', () => {
    const meta = { model: 'opus' };
    const c = draftLaunchChoice({ meta, metaTouched: true }, {}, 'codex');
    expect(draftLaunchPayload(c, meta, unnamedLaunchIsNotClaude({}, 'codex')).engine).toBe('claude');
    const plain = draftLaunchChoice({ meta, metaTouched: true }, {}, 'claude');
    expect(draftLaunchPayload(plain, meta, unnamedLaunchIsNotClaude({}, 'claude')).engine).toBeUndefined();
  });

  it('sends an own mode, and a named engine as it is', () => {
    const meta = { engine: 'codex' as const, mode: 'plan' as const };
    const c = draftLaunchChoice({ meta, metaTouched: true }, PROJECT);
    expect(draftLaunchPayload(c, meta, true)).toEqual({ engine: 'codex', model: undefined, mode: 'plan' });
  });
});

describe('sessionLaunchFrom', () => {
  const rec = { engine: 'project' as const, model: 'project' as const, mode: 'project' as const, project: 'Walnut', started: { engine: 'claude' as const, model: 'claude-sonnet-4-6', mode: 'accept' as const } };

  it('reads the record while the session runs on what it started on', () => {
    expect(sessionLaunchFrom(rec, { engine: 'claude', model: 'claude-sonnet-4-6', mode: 'accept' })).toEqual({ engine: 'project', model: 'project', mode: 'project' });
  });

  it('a value the session changed since reads as its own pick', () => {
    expect(sessionLaunchFrom(rec, { engine: 'claude', model: 'claude-opus-4-7', mode: 'plan' })).toEqual({ engine: 'project', model: 'task', mode: 'task' });
  });

  it('the same model in another spelling, or none reported yet, is no change', () => {
    const alias = { ...rec, started: { engine: 'claude' as const, model: 'haiku', mode: 'accept' as const } };
    expect(sessionLaunchFrom(alias, { engine: 'claude', model: 'claude-haiku-4-5-20251001', mode: 'accept' }).model).toBe('project');
    expect(sessionLaunchFrom(alias, { engine: 'claude', model: undefined, mode: 'accept' }).model).toBe('project');
    // A start on the engine's default: a model named later is a switch, none is no change.
    const dflt = { ...rec, started: { engine: 'claude' as const, mode: 'accept' as const } };
    expect(sessionLaunchFrom(dflt, { engine: 'claude', model: 'opus', mode: 'accept' }).model).toBe('task');
    expect(sessionLaunchFrom(dflt, { engine: 'claude', model: undefined, mode: 'accept' }).model).toBe('project');
  });

  it("a start that named no mode runs in the engine's own default: only a mode picked since is the task's", () => {
    const none = { ...rec, mode: 'global' as const, started: { engine: 'claude' as const, model: 'claude-sonnet-4-6' } };
    // Claude Code's own default (its settings, else Auto) is no pick, whatever it reads.
    expect(sessionLaunchFrom(none, { engine: 'claude', model: 'claude-sonnet-4-6', mode: 'auto' }).mode).toBe('global');
    expect(sessionLaunchFrom(none, { engine: 'claude', model: 'claude-sonnet-4-6', mode: 'default' }).mode).toBe('global');
    expect(sessionLaunchFrom(none, { engine: 'claude', model: 'claude-sonnet-4-6', mode: 'auto', modeChosen: true }).mode).toBe('task');
  });

  it('an older record without the start reads as it is', () => {
    const { started: _, ...old } = rec;
    expect(sessionLaunchFrom(old, { engine: 'codex' })).toEqual({ engine: 'project', model: 'project', mode: 'project' });
  });
});

describe('sameModel', () => {
  it('matches an alias, a provider prefix, a date suffix and a context marker; not another model', () => {
    expect(sameModel('sonnet', 'claude-sonnet-4-6')).toBe(true);
    expect(sameModel('claude-haiku-4-5', 'claude-haiku-4-5-20251001')).toBe(true);
    expect(sameModel('global.anthropic.claude-opus-4-7', 'opus')).toBe(true);
    expect(sameModel('sonnet[1m]', 'claude-sonnet-4-6')).toBe(true);
    expect(sameModel('sonnet', 'claude-opus-4-7')).toBe(false);
    expect(sameModel('gpt-5.5', 'gpt-5.4')).toBe(false);
    expect(sameModel(undefined, undefined)).toBe(true);
    expect(sameModel('opus', undefined)).toBe(false);
  });
});

describe('launchSourceRows', () => {
  it('names each value and its source; the fallback takes the pair', () => {
    const rows = launchSourceRows({ engine: 'project', model: 'global', mode: 'project' }, { engineName: 'Codex', mode: 'accept', showMode: true, project: 'Walnut' });
    expect(rows.map((r) => [r.label, r.value, r.source, r.words])).toEqual([
      ['Engine', 'Codex', 'project', 'Default of project Walnut'],
      ['Model', 'Codex default', 'engine', "The engine's own default model"],
      ['Mode', 'Accept', 'project', 'Default of project Walnut'],
    ]);
    const fb = launchSourceRows({ engine: 'project', model: 'project', mode: 'global' }, { engineName: 'Claude Code', mode: 'bypass', showMode: false, onFallback: true });
    expect(fb.map((r) => r.source)).toEqual(['fallback', 'fallback']);
  });
});
