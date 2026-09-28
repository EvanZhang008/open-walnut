/**
 * session-organize × Jev — contract pinned:
 *   - a confident Choice → placement, and the fast-model path never runs
 *   - the Inbox sentinel or low confidence → empty suggestion (authoritative:
 *     the fast model is NOT consulted; a Jev answer is final)
 *   - a transport error → falls back to the existing fast-model path
 *   - Jev unconfigured → fast-model path exactly as before
 *
 * Real: organize logic. Fake: jev client, sendMessage, project digest.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const sendMessageMock = vi.fn();
vi.mock('../../src/model/model.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));
const digestMock = vi.fn();
vi.mock('../../src/core/quick-task-digest.js', () => ({
  buildProjectDigest: (...args: unknown[]) => digestMock(...args),
}));
const config: Record<string, unknown> = {
  version: 1, user: {}, defaults: { priority: 'backlog' }, agent: { main_provider: 'bedrock' },
};
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => config,
}));
const getJevClientMock = vi.fn();
// Keep the real module (readChoice is real validation logic under test here);
// only the client factory is faked.
vi.mock('../../src/core/decision/jev-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/decision/jev-client.js')>()),
  getJevClient: (...args: unknown[]) => getJevClientMock(...args),
}));

import { suggestSessionPlacement } from '../../src/core/session-organize.js';

const DIGEST = {
  digest: '- walnut (3 open tasks): "Add STT route"\n- Errands (1 open tasks): "Buy milk"',
  projects: ['walnut', 'Errands'],
};

function choiceAnswer(choice: string, confidence: number) {
  return {
    project: { type: 'choice', choice, probabilities: { [choice]: confidence }, confidence },
  };
}

const INPUT = { cwd: '/home/dev/walnut', message: 'fix the flaky e2e test' };

beforeEach(() => {
  sendMessageMock.mockReset();
  digestMock.mockReset();
  getJevClientMock.mockReset();
  digestMock.mockResolvedValue(DIGEST);
});

describe('suggestSessionPlacement with Jev', () => {
  it('places on a confident choice without consulting the fast model', async () => {
    const decide = vi.fn().mockResolvedValue(choiceAnswer('walnut', 0.9));
    getJevClientMock.mockReturnValue({ decide });

    expect(await suggestSessionPlacement(INPUT)).toEqual({ project: 'walnut' });
    expect(sendMessageMock).not.toHaveBeenCalled();
    // The question offers every project plus the Inbox sentinel.
    const [state, questions] = decide.mock.calls[0] as [string, Record<string, { criteria: Record<string, string> }>];
    expect(state).toContain('/home/dev/walnut');
    expect(Object.keys(questions.project.criteria)).toEqual(
      expect.arrayContaining(['__inbox__', 'walnut', 'Errands']),
    );
  });

  it('rides digest summaries into the criteria; a digest without them keeps bare names', async () => {
    const decide = vi.fn().mockResolvedValue(choiceAnswer('walnut', 0.9));
    getJevClientMock.mockReturnValue({ decide });
    digestMock.mockResolvedValue({
      ...DIGEST,
      summaries: { walnut: 'The Walnut personal-AI repo.' },
    });

    await suggestSessionPlacement(INPUT);
    const [, questions] = decide.mock.calls[0] as [string, Record<string, { criteria: Record<string, string> }>];
    expect(questions.project.criteria.walnut).toBe('File it under the project named "walnut". The Walnut personal-AI repo.');
    expect(questions.project.criteria.Errands).toBe('File it under the project named "Errands".');
  });

  it('treats the Inbox sentinel as final — no fast-model second opinion', async () => {
    getJevClientMock.mockReturnValue({ decide: vi.fn().mockResolvedValue(choiceAnswer('__inbox__', 0.95)) });

    expect(await suggestSessionPlacement(INPUT)).toEqual({});
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('treats low confidence as "stay in Inbox", not as an error', async () => {
    getJevClientMock.mockReturnValue({ decide: vi.fn().mockResolvedValue(choiceAnswer('walnut', 0.4)) });

    expect(await suggestSessionPlacement(INPUT)).toEqual({});
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('falls back to the fast model on a choice outside the offered list', async () => {
    getJevClientMock.mockReturnValue({ decide: vi.fn().mockResolvedValue(choiceAnswer('not-a-project', 0.9)) });
    sendMessageMock.mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });

    expect(await suggestSessionPlacement(INPUT)).toEqual({});
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('falls back (fail closed) when the answer has no numeric confidence', async () => {
    // A gateway that omits `confidence` must not clear the 0.6 floor:
    // `undefined < 0.6` is false, and this is the unattended call site.
    getJevClientMock.mockReturnValue({
      decide: vi.fn().mockResolvedValue({ project: { type: 'choice', choice: 'walnut', probabilities: { walnut: 1 } } }),
    });
    sendMessageMock.mockResolvedValue({ content: [{ type: 'text', text: '{"project":"Errands"}' }] });

    expect(await suggestSessionPlacement(INPUT)).toEqual({ project: 'Errands' });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('falls back when the answer key is missing entirely (schema drift is not "nothing fits")', async () => {
    getJevClientMock.mockReturnValue({ decide: vi.fn().mockResolvedValue({}) });
    sendMessageMock.mockResolvedValue({ content: [{ type: 'text', text: '{"project":"walnut"}' }] });

    expect(await suggestSessionPlacement(INPUT)).toEqual({ project: 'walnut' });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('an explicit modelOverride bypasses Jev entirely', async () => {
    const decide = vi.fn();
    getJevClientMock.mockReturnValue({ decide });
    sendMessageMock.mockResolvedValue({ content: [{ type: 'text', text: '{"project":"walnut"}' }] });

    expect(await suggestSessionPlacement(INPUT, { modelOverride: 'pinned-model' })).toEqual({ project: 'walnut' });
    expect(decide).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the fast-model path on a transport error', async () => {
    getJevClientMock.mockReturnValue({ decide: vi.fn().mockRejectedValue(new Error('Jev 503: down')) });
    sendMessageMock.mockResolvedValue({ content: [{ type: 'text', text: '{"project":"Errands"}' }] });

    expect(await suggestSessionPlacement(INPUT)).toEqual({ project: 'Errands' });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('decisions.session_organize === false keeps the fast-model path (client never built)', async () => {
    config.jev = { api_key: 'test-key', decisions: { session_organize: false } };
    const decide = vi.fn();
    getJevClientMock.mockReturnValue({ decide });
    sendMessageMock.mockResolvedValue({ content: [{ type: 'text', text: '{"project":"walnut"}' }] });

    expect(await suggestSessionPlacement(INPUT)).toEqual({ project: 'walnut' });
    expect(getJevClientMock).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    delete config.jev;
  });

  it('keeps the fast-model path when Jev is not configured', async () => {
    getJevClientMock.mockReturnValue(undefined);
    sendMessageMock.mockResolvedValue({ content: [{ type: 'text', text: '{"project":"walnut"}' }] });

    expect(await suggestSessionPlacement(INPUT)).toEqual({ project: 'walnut' });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });
});
