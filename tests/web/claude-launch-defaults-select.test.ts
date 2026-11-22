/**
 * Settings > Sessions: the "Default model" and "Default effort" rows' save shape.
 *
 * The page saves a section whole (saveSection -> rebaseOnto: a key the patch leaves out or sets
 * undefined is removed), so a pick of one row must carry the other row's value, and clearing the
 * older `agent.session_effort` must keep every other agent setting. Both bugs would be invisible
 * in the row itself (it keeps showing the pick), which is why they are pinned here.
 */
import { describe, it, expect } from 'vitest';
import type { Config } from '@open-walnut/core';
import { rebaseOnto } from '@/hooks/config-rebase';
import {
  currentDefaultEffort, currentDefaultModel, launchDefaultSave, NOT_SET, observedEffortWords,
} from '@/components/settings/sections/claude-launch-defaults-select';

/** What the stored config becomes after a page save of `patch` (sections stored as sent). */
function save(config: Config, patch: Partial<Config>): Config {
  return { ...config, ...rebaseOnto(patch, config, config) } as Config;
}

const base = {
  defaults: { priority: 'backlog', engine: 'claude' },
  agent: { main_model: 'opus', language: 'en' },
} as unknown as Config;

describe('launchDefaultSave', () => {
  it('a pick of one keeps the other', () => {
    let c = save(base, launchDefaultSave(base, 'effort', 'high'));
    c = save(c, launchDefaultSave(c, 'model', 'sonnet'));
    expect(c.launch_defaults).toEqual({ effort: 'high', model: 'sonnet' });
    expect(currentDefaultEffort(c)).toBe('high');
    expect(currentDefaultModel(c)).toBe('sonnet');
    expect(c.defaults).toEqual(base.defaults);
    expect(c.agent).toEqual(base.agent);
  });

  it('Not set removes only its own key', () => {
    let c = save(base, launchDefaultSave(base, 'effort', 'high'));
    c = save(c, launchDefaultSave(c, 'model', 'sonnet'));
    c = save(c, launchDefaultSave(c, 'effort', NOT_SET));
    expect(c.launch_defaults).toEqual({ model: 'sonnet' });
    expect(currentDefaultEffort(c)).toBe(NOT_SET);
  });

  it('an effort pick clears the older agent.session_effort and keeps every other agent setting', () => {
    const legacy = { ...base, agent: { ...base.agent, session_effort: 'low' } } as unknown as Config;
    expect(currentDefaultEffort(legacy)).toBe('low');
    const c = save(legacy, launchDefaultSave(legacy, 'effort', NOT_SET));
    expect(c.agent).toEqual(base.agent);
    expect(currentDefaultEffort(c)).toBe(NOT_SET);
  });
});

describe('observedEffortWords', () => {
  const row = (model: string, effort: string) => ({ model, effort, at: '2026-11-22T00:00:00Z', sessionId: 's' });

  // 2026-11-22, the UI audit: "Opus 5.5: High, Opus 5.5: High, Fable 5.2: Medium" (an alias and the
  // full id of one model were seen apart).
  it('names each model once, with the first row seen for it', () => {
    const words = observedEffortWords([
      row('global.anthropic.claude-opus-5-5', 'high'),
      row('opus-5-5', 'low'),
      row('claude-fable-5-2', 'medium'),
    ]);
    expect(words).toBe('Opus 5.5: High, Fable 5.2: Medium');
  });

  it('keeps at most max names, counted after merging', () => {
    const words = observedEffortWords([
      row('opus-5-5', 'high'), row('global.anthropic.claude-opus-5-5', 'high'), row('claude-fable-5-2', 'medium'),
    ], 2);
    expect(words).toBe('Opus 5.5: High, Fable 5.2: Medium');
  });
});
