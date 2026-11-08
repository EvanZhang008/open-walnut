/**
 * A project's launch defaults (src/core/sessions/project-launch-defaults.ts): the engine, model
 * and permission mode a new task of the project starts on when its launch names none. The launch's
 * own value wins, then the project's, then the global default; engine and model are one pair; the
 * fallback engine stands in for whichever default engine applies.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const meta = vi.hoisted(() => ({ byProject: new Map<string, Record<string, unknown>>() }));
const fb = vi.hoisted(() => ({ decide: vi.fn(async (_c: unknown, _engine: string, _host: unknown) => null as unknown) }));

vi.mock('../../../src/core/task-manager.js', () => ({
  getProjectMetadata: async (name: string) => meta.byProject.get(name.toLowerCase()) ?? null,
}));
vi.mock('../../../src/core/agents/fallback-engine.js', () => ({
  resolveFallbackLaunch: (c: unknown, engine: string, host: unknown) => fb.decide(c, engine, host),
}));

import {
  checkLaunchDefaultsPatch, inheritedEnginePick, launchNamesOwnPair, pickLaunchDefaults, ProjectSettingsError,
  projectLaunchDefaultsOf, readProjectLaunchDefaults,
} from '../../../src/core/sessions/project-launch-defaults.js';

const GLOBAL_CODEX = { defaults: { engine: 'codex' } };
const NO_GLOBAL = { defaults: {} };

beforeEach(() => {
  meta.byProject.clear();
  fb.decide.mockReset();
  fb.decide.mockImplementation(async () => null);
});

describe('readProjectLaunchDefaults', () => {
  it('reads nothing from an absent, empty or unrelated blob', () => {
    expect(readProjectLaunchDefaults(null)).toEqual({});
    expect(readProjectLaunchDefaults({})).toEqual({});
    expect(readProjectLaunchDefaults({ default_cwd: '/w', default_host: 'box' })).toEqual({});
  });

  it('reads the three values, and drops what no longer reads as valid', () => {
    expect(readProjectLaunchDefaults({ default_engine: 'codex', default_model: 'gpt-5.5', default_mode: 'accept' }))
      .toEqual({ engine: 'codex', model: 'gpt-5.5', mode: 'accept' });
    // A model without its engine names no catalog: dropped.
    expect(readProjectLaunchDefaults({ default_model: 'opus' })).toEqual({});
    expect(readProjectLaunchDefaults({ default_engine: 'gone-engine', default_model: 'x', default_mode: 'yolo' })).toEqual({});
    expect(readProjectLaunchDefaults({ default_engine: 'claude', default_model: 'a b' })).toEqual({ engine: 'claude' });
    expect(readProjectLaunchDefaults({ default_engine: 'claude', default_model: 'default' })).toEqual({ engine: 'claude' });
  });

  it('looks a project up by name, case-insensitively, and Inbox has none', async () => {
    meta.byProject.set('walnut', { default_mode: 'plan' });
    expect(await projectLaunchDefaultsOf('Walnut')).toEqual({ mode: 'plan' });
    expect(await projectLaunchDefaultsOf('')).toEqual({});
    expect(await projectLaunchDefaultsOf(undefined)).toEqual({});
    expect(await projectLaunchDefaultsOf('Unknown')).toEqual({});
  });
});

describe('checkLaunchDefaultsPatch', () => {
  it('passes a patch that touches none of the three unchanged', () => {
    const patch = { default_cwd: '/w' };
    expect(checkLaunchDefaultsPatch({ default_engine: 'codex' }, patch)).toBe(patch);
  });

  it('refuses an unknown engine, a model without an engine, a bad model id and a bad mode', () => {
    expect(() => checkLaunchDefaultsPatch({}, { default_engine: 'nope' })).toThrow(ProjectSettingsError);
    expect(() => checkLaunchDefaultsPatch({}, { default_model: 'opus' })).toThrow(/needs default_engine/);
    expect(() => checkLaunchDefaultsPatch({}, { default_engine: 'claude', default_model: 'a b' })).toThrow(/not a model id/);
    expect(() => checkLaunchDefaultsPatch({}, { default_mode: 'yolo' })).toThrow(/default_mode/);
    expect(() => checkLaunchDefaultsPatch({}, { default_mode: 42 })).toThrow(ProjectSettingsError);
  });

  it('a model rides with an engine set before, and a new or cleared engine drops the old model', () => {
    expect(checkLaunchDefaultsPatch({ default_engine: 'claude' }, { default_model: ' sonnet ' })).toEqual({ default_model: 'sonnet' });
    expect(checkLaunchDefaultsPatch({ default_engine: 'claude', default_model: 'opus' }, { default_engine: 'codex' }))
      .toEqual({ default_engine: 'codex', default_model: undefined });
    expect(checkLaunchDefaultsPatch({ default_engine: 'claude', default_model: 'opus' }, { default_engine: undefined }))
      .toEqual({ default_engine: undefined, default_model: undefined });
    // The same engine again keeps the model; a patch naming both sets both.
    expect(checkLaunchDefaultsPatch({ default_engine: 'claude', default_model: 'opus' }, { default_engine: 'claude' })).toEqual({ default_engine: 'claude' });
    expect(checkLaunchDefaultsPatch({}, { default_engine: 'codex', default_model: 'gpt-5.5[high]' })).toEqual({ default_engine: 'codex', default_model: 'gpt-5.5[high]' });
    // Clearing all three ("Use global defaults").
    expect(checkLaunchDefaultsPatch({ default_engine: 'codex', default_model: 'x', default_mode: 'plan' },
      { default_engine: undefined, default_model: undefined, default_mode: undefined }))
      .toEqual({ default_engine: undefined, default_model: undefined, default_mode: undefined });
    // An Auto model is no model.
    expect(checkLaunchDefaultsPatch({ default_engine: 'claude' }, { default_model: 'default' })).toEqual({ default_model: undefined });
  });
});

describe('launchNamesOwnPair', () => {
  it('an engine or a model is the launch choosing its own pair; an effort alone is not', () => {
    expect(launchNamesOwnPair({})).toBe(false);
    expect(launchNamesOwnPair({ model: '' })).toBe(false);
    expect(launchNamesOwnPair({ model: 'default' })).toBe(false);
    expect(launchNamesOwnPair({ model: 'opus' })).toBe(true);
    expect(launchNamesOwnPair({ engine: 'claude' })).toBe(true);
    expect(launchNamesOwnPair({ effort: 'high' } as never)).toBe(false);
  });
});

describe('inheritedEnginePick', () => {
  it('the project engine wins over the global one, with its model', async () => {
    expect(await inheritedEnginePick(GLOBAL_CODEX, { engine: 'claude', model: 'opus' }, undefined))
      .toEqual({ engine: 'claude', model: 'opus', from: 'project' });
    expect(await inheritedEnginePick(NO_GLOBAL, { engine: 'codex' }, undefined)).toEqual({ engine: 'codex', from: 'project' });
  });

  it('no project engine: the global default', async () => {
    expect(await inheritedEnginePick(GLOBAL_CODEX, {}, undefined)).toEqual({ engine: 'codex', from: 'global' });
    expect(await inheritedEnginePick(NO_GLOBAL, { mode: 'plan' }, undefined)).toEqual({ engine: 'claude', from: 'global' });
  });

  it('a project engine the host cannot run (an ACP engine on a remote host) is no project pick, and its model goes', async () => {
    expect(await inheritedEnginePick(NO_GLOBAL, { engine: 'codex', model: 'gpt-5.5' }, 'clouddev'))
      .toEqual({ engine: 'claude', from: 'global' });
  });
});

describe('pickLaunchDefaults', () => {
  const pick = (o: Partial<Parameters<typeof pickLaunchDefaults>[0]>) => pickLaunchDefaults({
    config: NO_GLOBAL, project: 'P', host: undefined, named: {}, decidesFallback: true, ...o,
  });

  it('no project defaults: the launch is what it was (global engine, no model, no mode)', async () => {
    expect(await pick({})).toEqual({ engine: undefined, fallback: null, source: { engine: 'global', model: 'global', mode: 'global' } });
    expect(await pick({ config: GLOBAL_CODEX })).toMatchObject({ engine: 'codex', source: { engine: 'global' } });
    expect(await pick({ project: '' })).toMatchObject({ engine: undefined, source: { engine: 'global', mode: 'global' } });
  });

  it('project engine + model + mode apply to a launch that names none, and say which project', async () => {
    meta.byProject.set('p', { default_engine: 'codex', default_model: 'gpt-5.5', default_mode: 'accept' });
    expect(await pick({})).toEqual({
      engine: 'codex', model: 'gpt-5.5', mode: 'accept', fallback: null,
      source: { engine: 'project', model: 'project', mode: 'project', project: 'P' },
    });
  });

  it('a project that says Claude Code beats a global Codex (absent = Claude in storage shape)', async () => {
    meta.byProject.set('p', { default_engine: 'claude' });
    expect(await pick({ config: GLOBAL_CODEX })).toMatchObject({ engine: undefined, source: { engine: 'project', model: 'global' } });
  });

  it('a launch that names its engine, model or mode keeps it', async () => {
    meta.byProject.set('p', { default_engine: 'codex', default_model: 'gpt-5.5', default_mode: 'accept' });
    expect(await pick({ named: { engine: 'claude' } })).toEqual({
      engine: undefined, mode: 'accept', fallback: null, source: { engine: 'task', model: 'global', mode: 'project', project: 'P' },
    });
    // A model alone keeps the global engine, as these routes always did.
    expect(await pick({ named: { model: 'opus' }, config: GLOBAL_CODEX })).toMatchObject({ engine: 'codex', source: { engine: 'global', model: 'task' } });
    expect(await pick({ named: { mode: 'plan' } })).toMatchObject({ engine: 'codex', model: 'gpt-5.5', source: { mode: 'task' } });
    expect((await pick({ named: { mode: 'plan' } })).mode).toBeUndefined();
    expect(fb.decide).toHaveBeenCalledTimes(2);
  });

  it('the fallback engine stands in for the project engine while it is out of usage, and keeps the project mode', async () => {
    meta.byProject.set('p', { default_engine: 'codex', default_model: 'gpt-5.5', default_mode: 'accept' });
    const decision = { engine: 'claude', model: 'sonnet', note: { from: 'codex', to: 'claude', at: 'now' } };
    fb.decide.mockImplementation(async () => decision);
    const got = await pick({});
    expect(fb.decide).toHaveBeenCalledWith(NO_GLOBAL, 'codex', undefined);
    expect(got).toEqual({
      engine: undefined, model: 'sonnet', mode: 'accept', fallback: decision,
      source: { engine: 'fallback', model: 'fallback', mode: 'project', project: 'P' },
    });
    // A launch that does not decide the fallback (the phone, Ask Walnut) never asks.
    fb.decide.mockClear();
    expect(await pick({ decidesFallback: false })).toMatchObject({ engine: 'codex', model: 'gpt-5.5' });
    expect(fb.decide).not.toHaveBeenCalled();
  });
});

describe("the phone's engine names", () => {
  it('name every engine of the registry (a new engine needs its name on the phone)', async () => {
    const { ENGINE_REGISTRY } = await import('../../../src/core/agents/engine-registry.js')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const swift = fs.readFileSync(path.resolve(import.meta.dirname, '../../../ios-native/Walnut/Views/Sessions/DraftLaunchDefaults.swift'), 'utf8')
    for (const id of ENGINE_REGISTRY.keys()) expect(swift, id).toContain(`case "${id}":`)
  })
})
