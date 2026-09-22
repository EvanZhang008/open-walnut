/**
 * parseQuickTask × Jev — contract pinned:
 *   - direct-API fast model: Jev runs IN PARALLEL and its confident answers
 *     override the LLM's classification fields; a confident "none" CLEARS an
 *     LLM claim (the LLM notoriously over-claims focus/wait)
 *   - a Jev existing-project pick beats an LLM new-project proposal; a Jev
 *     "none" keeps the proposal (Jev never saw the new-name escape hatch)
 *   - low confidence → the LLM's answer stands
 *   - Jev error → LLM-only, byte-identical to the pre-Jev behavior
 *   - CLI fast model (the measured-hopeless spawn): the LLM leg is skipped,
 *     title is the raw note, Jev supplies the classification
 *   - LLM error + live Jev → raw title with Jev fields, never a throw
 *
 * Real: parse/merge logic. Fake: sendMessage, config, jev client.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMessageMock = vi.fn();
vi.mock('../../src/model/model.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));
const config = {
  version: 1,
  user: {},
  defaults: { priority: 'backlog' },
  agent: { main_provider: 'bedrock' as string, fast_model: undefined as string | undefined },
  jev: { api_key: 'test-key', model: 'typesafe/jev-1.13' } as Record<string, string> | undefined,
};
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => config,
}));
const decideMock = vi.fn();
const getJevClientMock = vi.fn();
// Keep the real module (readChoice is real validation logic under test here);
// only the client factory is faked.
vi.mock('../../src/core/decision/jev-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/decision/jev-client.js')>()),
  getJevClient: (...args: unknown[]) => getJevClientMock(...args),
}));

import { parseQuickTask } from '../../src/core/quick-task-parse.js';

function textResult(text: string) {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

function choice(key: string, confidence: number) {
  return { type: 'choice', choice: key, probabilities: { [key]: confidence }, confidence };
}

beforeEach(() => {
  sendMessageMock.mockReset();
  decideMock.mockReset();
  getJevClientMock.mockReset();
  getJevClientMock.mockReturnValue({ decide: decideMock, model: 'typesafe/jev-1.13' });
  config.agent.main_provider = 'bedrock';
  config.agent.fast_model = undefined;
});

describe('parseQuickTask with Jev (direct-API fast model: parallel merge)', () => {
  it('confident Jev answers override the LLM classification fields', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Fix login","pinTier":"focus","priority":"backlog"}'));
    decideMock.mockResolvedValue({
      pinTier: choice('satellite', 0.8),
      priority: choice('immediate', 0.7),
    });

    const result = await parseQuickTask('fix login bug by friday');
    expect(result.parse).toMatchObject({ title: 'Fix login', pinTier: 'satellite', priority: 'immediate' });
    // The Jev leg runs on its own tight budget, never the LLM's 10s default.
    const [, , decideOpts] = decideMock.mock.calls[0] as [string, unknown, { timeoutMs?: number }];
    expect(decideOpts.timeoutMs).toBeLessThanOrEqual(2_500);
  });

  it('a confident "none" clears the LLM over-claim', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Read paper","pinTier":"focus","priority":"immediate"}'));
    decideMock.mockResolvedValue({
      pinTier: choice('__none__', 0.9),
      priority: choice('__none__', 0.9),
    });

    const { parse } = await parseQuickTask('read that paper sometime');
    expect(parse.title).toBe('Read paper');
    expect(parse.pinTier).toBeUndefined();
    expect(parse.priority).toBeUndefined();
  });

  it('low-confidence Jev answers leave the LLM fields alone', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Fix login","pinTier":"focus"}'));
    decideMock.mockResolvedValue({ pinTier: choice('satellite', 0.3) });

    const { parse } = await parseQuickTask('fix login asap');
    expect(parse.pinTier).toBe('focus');
  });

  it('an answer without numeric confidence is "no opinion", not an override', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Fix login","pinTier":"focus"}'));
    decideMock.mockResolvedValue({
      pinTier: { type: 'choice', choice: 'satellite', probabilities: { satellite: 1 } },
    });

    const { parse } = await parseQuickTask('fix login asap');
    expect(parse.pinTier).toBe('focus');
  });

  it('a Jev existing-project pick beats an LLM new-project proposal', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Add search","project":"Search Revamp","project_is_new":true}'));
    decideMock.mockResolvedValue({ project: choice('walnut', 0.8) });

    const { parse } = await parseQuickTask('add search to the app', { knownProjects: ['walnut', 'Errands'] });
    expect(parse.project).toBe('walnut');
    expect(parse.project_is_new).toBeUndefined();
  });

  it('a Jev "none" keeps the LLM new-project proposal (escape hatch Jev cannot see)', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Plan the move","project":"Seattle Move","project_is_new":true}'));
    decideMock.mockResolvedValue({ project: choice('__none__', 0.9) });

    const { parse } = await parseQuickTask('plan the seattle move', { knownProjects: ['walnut'] });
    expect(parse.project).toBe('Seattle Move');
    expect(parse.project_is_new).toBe(true);
  });

  it('project uses its own lower floor (many options thin the mass): 0.45 lands, 0.35 does not', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Fix panel scroll"}'));
    decideMock.mockResolvedValue({ project: choice('walnut', 0.45) });
    const a = await parseQuickTask('panel scroll blocked at wide width', { knownProjects: ['walnut'] });
    expect(a.parse.project).toBe('walnut');

    decideMock.mockResolvedValue({ project: choice('walnut', 0.35) });
    const b = await parseQuickTask('panel scroll blocked at wide width', { knownProjects: ['walnut'] });
    expect(b.parse.project).toBeUndefined();

    // tier/priority keep the 0.5 bar: 0.45 there is still "no opinion".
    sendMessageMock.mockResolvedValue(textResult('{"title":"Fix login","pinTier":"focus"}'));
    decideMock.mockResolvedValue({ pinTier: choice('satellite', 0.45) });
    const c = await parseQuickTask('fix login asap');
    expect(c.parse.pinTier).toBe('focus');
  });

  it('a Jev "none" clears an LLM EXISTING-project claim', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Buy milk","project":"walnut"}'));
    decideMock.mockResolvedValue({ project: choice('__none__', 0.9) });

    const { parse } = await parseQuickTask('buy milk', { knownProjects: ['walnut'] });
    expect(parse.project).toBeUndefined();
  });

  it('accepts a confident custom-tier id and offers it in the question', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Sharpen saw"}'));
    decideMock.mockResolvedValue({ pinTier: choice('icebox', 0.8) });

    const { parse } = await parseQuickTask('sharpen the saw — icebox', {
      customTiers: [{ id: 'icebox', label: 'Icebox' }],
    });
    expect(parse.pinTier).toBe('icebox');
    const [, questions] = decideMock.mock.calls[0] as [string, Record<string, { criteria: Record<string, string> }>];
    expect(Object.keys(questions.pinTier.criteria)).toEqual(
      expect.arrayContaining(['focus', 'satellite', 'backlog', 'wait', 'icebox', '__none__']),
    );
  });

  it('Jev transport error → LLM-only result, unchanged from pre-Jev behavior', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Fix login","pinTier":"focus"}'));
    decideMock.mockRejectedValue(new Error('Jev 503'));

    const result = await parseQuickTask('fix login asap');
    expect(result.parse).toMatchObject({ title: 'Fix login', pinTier: 'focus' });
  });

  it('LLM failure still delivers the Jev classification on the raw title', async () => {
    sendMessageMock.mockRejectedValue(new Error('model down'));
    decideMock.mockResolvedValue({ priority: choice('immediate', 0.8) });

    const { parse } = await parseQuickTask('call the bank asap');
    expect(parse).toMatchObject({ title: 'call the bank asap', priority: 'immediate' });
  });

  it('rides project summaries into the criteria; bare names stay bare', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"x"}'));
    decideMock.mockResolvedValue({});

    await parseQuickTask('local maple server for fun', {
      knownProjects: ['Fun', 'walnut'],
      projectSummaries: { Fun: 'Hobby games and side quests.' },
    });
    const [, questions] = decideMock.mock.calls[0] as [string, Record<string, { criteria: Record<string, string> }>];
    expect(questions.project.criteria.Fun).toBe('File it under the project named "Fun". Hobby games and side quests.');
    // No summary → byte-identical to the pre-summaries criteria text.
    expect(questions.project.criteria.walnut).toBe('File it under the project named "walnut".');
  });

  it('does not ask a project question without knownProjects', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"x"}'));
    decideMock.mockResolvedValue({});

    await parseQuickTask('do the thing');
    const [, questions] = decideMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(questions.project).toBeUndefined();
    expect(questions.pinTier).toBeDefined();
    expect(questions.priority).toBeDefined();
  });
});

describe('parseQuickTask with Jev (CLI fast model: LLM leg skipped)', () => {
  beforeEach(() => {
    config.agent.main_provider = 'claude_cli';
  });

  it('never spawns the hopeless CLI parse; Jev classifies on the raw note', async () => {
    decideMock.mockResolvedValue({
      pinTier: choice('satellite', 0.8),
      priority: choice('__none__', 0.9),
    });

    const result = await parseQuickTask('fix login bug by friday');
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(result.parse).toMatchObject({ title: 'fix login bug by friday', pinTier: 'satellite' });
    expect(result.parse.due_date).toBeUndefined();
    expect(result.model).toBe('typesafe/jev-1.13');
  });

  it('an explicit modelOverride bypasses Jev and forces the LLM leg', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Fix login"}'));

    const result = await parseQuickTask('fix login', { modelOverride: 'some-direct-model' });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(decideMock).not.toHaveBeenCalled();
    expect(result.parse.title).toBe('Fix login');
  });

  it('Jev failure in skip mode degrades to the raw note, never a throw, and claims no model', async () => {
    decideMock.mockRejectedValue(new Error('Jev 503'));

    const result = await parseQuickTask('fix login bug');
    expect(result.parse).toEqual({ title: 'fix login bug' });
    // A model that produced nothing must not be attributed in the envelope.
    expect(result.model).toBeUndefined();
  });
});

describe('parseQuickTask with the Settings opt-out', () => {
  it('decisions.quick_parse === false keeps the LLM-only path (client never built)', async () => {
    config.jev = { api_key: 'test-key', decisions: { quick_parse: false } } as never;
    sendMessageMock.mockResolvedValue(textResult('{"title":"Fix login","pinTier":"focus"}'));

    const { parse } = await parseQuickTask('fix login asap');
    expect(parse).toMatchObject({ title: 'Fix login', pinTier: 'focus' });
    expect(getJevClientMock).not.toHaveBeenCalled();
    expect(decideMock).not.toHaveBeenCalled();
    config.jev = { api_key: 'test-key', model: 'typesafe/jev-1.13' } as never;
  });

  it('an unset toggle means ON (configuring Jev is the opt-in)', async () => {
    config.jev = { api_key: 'test-key', decisions: {} } as never;
    sendMessageMock.mockResolvedValue(textResult('{"title":"Fix login","pinTier":"focus"}'));
    decideMock.mockResolvedValue({ pinTier: choice('satellite', 0.8) });

    const { parse } = await parseQuickTask('fix login by friday');
    expect(parse.pinTier).toBe('satellite');
    config.jev = { api_key: 'test-key', model: 'typesafe/jev-1.13' } as never;
  });
});

describe('parseQuickTask without Jev', () => {
  it('is byte-identical to the historical LLM-only behavior', async () => {
    getJevClientMock.mockReturnValue(undefined);
    sendMessageMock.mockResolvedValue(textResult('{"title":"Fix login","pinTier":"focus"}'));

    const result = await parseQuickTask('fix login asap');
    expect(result.parse).toMatchObject({ title: 'Fix login', pinTier: 'focus' });
    expect(decideMock).not.toHaveBeenCalled();
  });
});
