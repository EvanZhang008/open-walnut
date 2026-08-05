import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMessageMock = vi.fn();
const config = { agent: { main_provider: 'bedrock', fast_model: undefined as string | undefined } };
vi.mock('../../src/agent/model.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => config,
}));

import { parseQuickTask, type QuickTaskParse } from '../../src/core/quick-task-parse.js';
import { PIN_TIER_NONE_GUIDANCE, PIN_TIER_POLICY } from '../../src/core/types.js';

function textResult(text: string) {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

function parseOnly(parse: QuickTaskParse) {
  return expect.objectContaining({ parse, parseMs: expect.any(Number) });
}

function lastCall() {
  return sendMessageMock.mock.calls.at(-1)![0] as {
    system: string;
    messages: Array<{ role: string; content: string }>;
    config: { maxTokens: number; model?: string };
  };
}

describe('parseQuickTask', () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    config.agent.fast_model = undefined;
  });

  it('returns every valid parsed field in an envelope', async () => {
    sendMessageMock.mockResolvedValue(textResult(
      '{"title":"File my tax","due_date":"2026-07-15T10:00:00","pinTier":"focus","priority":"important","starred":true}',
    ));

    const result = await parseQuickTask('file my tax tomorrow at 10am pinned focus important and starred');
    expect(result).toEqual(parseOnly({
      title: 'File my tax',
      due_date: '2026-07-15T10:00:00',
      pinTier: 'focus',
      priority: 'important',
      starred: true,
    }));
    expect(result.model).toContain('haiku');
  });

  it('parses JSON wrapped in markdown fences', async () => {
    sendMessageMock.mockResolvedValue(textResult(
      '```json\n{"title":"File my tax","priority":"important"}\n```',
    ));
    await expect(parseQuickTask('file my tax important')).resolves.toEqual(
      parseOnly({ title: 'File my tax', priority: 'important' }),
    );
  });

  it('falls back to the original text for garbage model output', async () => {
    sendMessageMock.mockResolvedValue(textResult('not valid JSON'));
    await expect(parseQuickTask('Schedule dentist visit')).resolves.toEqual(
      parseOnly({ title: 'Schedule dentist visit' }),
    );
  });

  it('falls back without rejecting when the model throws', async () => {
    sendMessageMock.mockRejectedValue(new Error('model unavailable'));
    await expect(parseQuickTask('Prepare monthly budget')).resolves.toEqual(
      parseOnly({ title: 'Prepare monthly budget' }),
    );
  });

  it('drops invalid enum and due date values while keeping the title', async () => {
    sendMessageMock.mockResolvedValue(textResult(
      '{"title":"Plan website","due_date":"next week","pinTier":"top","priority":"high"}',
    ));
    await expect(parseQuickTask('plan website')).resolves.toEqual(
      parseOnly({ title: 'Plan website' }),
    );
  });

  it('rejects impossible calendar dates and non-local datetime forms', async () => {
    for (const dueDate of [
      '2026-02-31',
      '2026-07-15T25:00:00',
      '2026-07-15T10:00:00Z',
      '2026-07-15T10:00:00-07:00',
    ]) {
      sendMessageMock.mockResolvedValueOnce(textResult(
        JSON.stringify({ title: 'Plan website', due_date: dueDate }),
      ));
      await expect(parseQuickTask('plan website')).resolves.toEqual(
        parseOnly({ title: 'Plan website' }),
      );
    }
  });

  it('accepts valid local date and local datetime forms', async () => {
    sendMessageMock.mockResolvedValueOnce(textResult(
      '{"title":"Plan website","due_date":"2026-07-15"}',
    ));
    await expect(parseQuickTask('plan website')).resolves.toEqual(
      parseOnly({ title: 'Plan website', due_date: '2026-07-15' }),
    );

    sendMessageMock.mockResolvedValueOnce(textResult(
      '{"title":"Plan website","due_date":"2026-07-15T10:30:00"}',
    ));
    await expect(parseQuickTask('plan website')).resolves.toEqual(
      parseOnly({ title: 'Plan website', due_date: '2026-07-15T10:30:00' }),
    );
  });

  it('passes start_date through the same validation as due_date', async () => {
    sendMessageMock.mockResolvedValueOnce(textResult(
      '{"title":"Call mom","start_date":"2026-07-17"}',
    ));
    await expect(parseQuickTask('call mom friday')).resolves.toEqual(
      parseOnly({ title: 'Call mom', start_date: '2026-07-17' }),
    );

    // Both fields can coexist (start defers, due deadlines).
    sendMessageMock.mockResolvedValueOnce(textResult(
      '{"title":"File report","start_date":"2026-07-16T09:00:00","due_date":"2026-07-18"}',
    ));
    await expect(parseQuickTask('file report, start wed morning, due friday')).resolves.toEqual(
      parseOnly({ title: 'File report', start_date: '2026-07-16T09:00:00', due_date: '2026-07-18' }),
    );

    // Invalid start_date is dropped, not passed through.
    sendMessageMock.mockResolvedValueOnce(textResult(
      '{"title":"Call mom","start_date":"next friday"}',
    ));
    await expect(parseQuickTask('call mom friday')).resolves.toEqual(
      parseOnly({ title: 'Call mom' }),
    );
  });

  it('returns empty input without calling the model', async () => {
    await expect(parseQuickTask('')).resolves.toEqual({ parse: { title: '' }, parseMs: 0 });
    await expect(parseQuickTask('   ')).resolves.toEqual({ parse: { title: '   ' }, parseMs: 0 });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('round-trips a valid category and project with canonical casing', async () => {
    sendMessageMock.mockResolvedValue(textResult(
      '{"title":"Buy groceries","category":"personal","project":"errands"}',
    ));
    const result = await parseQuickTask('buy groceries', {
      knownCategories: ['Personal', 'Work'],
      knownProjects: { Personal: ['Errands'], Work: ['Website'] },
    });
    expect(result.parse).toEqual({ title: 'Buy groceries', category: 'Personal', project: 'Errands' });
  });

  it('drops both fields when project has no valid category', async () => {
    sendMessageMock.mockResolvedValue(textResult(
      '{"title":"Buy groceries","category":"Unknown","project":"Errands"}',
    ));
    const result = await parseQuickTask('buy groceries', {
      knownCategories: ['Personal'], knownProjects: { Personal: ['Errands'] },
    });
    expect(result.parse).toEqual({ title: 'Buy groceries' });
  });

  it('drops a project answered without a category', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Buy groceries","project":"Errands"}'));
    const result = await parseQuickTask('buy groceries', {
      knownCategories: ['Personal'], knownProjects: { Personal: ['Errands'] },
    });
    expect(result.parse).toEqual({ title: 'Buy groceries' });
  });

  it('drops a project not under the answered category but keeps category', async () => {
    sendMessageMock.mockResolvedValue(textResult(
      '{"title":"Buy groceries","category":"Personal","project":"Website"}',
    ));
    const result = await parseQuickTask('buy groceries', {
      knownCategories: ['Personal', 'Work'],
      knownProjects: { Personal: ['Errands'], Work: ['Website'] },
    });
    expect(result.parse).toEqual({ title: 'Buy groceries', category: 'Personal' });
  });

  it('drops category when it is not in knownCategories', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Buy groceries","category":"Finance"}'));
    const result = await parseQuickTask('buy groceries', { knownCategories: ['Personal'] });
    expect(result.parse).toEqual({ title: 'Buy groceries' });
  });

  it('drops category when knownCategories is omitted', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Buy groceries","category":"Personal"}'));
    const result = await parseQuickTask('buy groceries');
    expect(result.parse).toEqual({ title: 'Buy groceries' });
  });

  it('places a non-empty digest before the Note block', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Buy groceries"}'));
    await parseQuickTask('buy groceries', { categoryDigest: '- Personal (2 open tasks): "Call dentist"' });
    const content = lastCall().messages[0].content;
    expect(content).toContain('Your categories and projects (name, open task count, recent task titles):');
    expect(content.indexOf('- Personal')).toBeLessThan(content.indexOf('Note:\n'));
  });

  it('omits the digest header when categoryDigest is empty', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Buy groceries"}'));
    await parseQuickTask('buy groceries', { categoryDigest: '  ' });
    expect(lastCall().messages[0].content).not.toContain('Your categories and projects');
  });

  it('uses the configured fast_model override', async () => {
    config.agent.fast_model = 'custom-fast-model';
    sendMessageMock.mockResolvedValue(textResult('{"title":"Pay invoice"}'));
    const result = await parseQuickTask('pay invoice');
    expect(lastCall().config.model).toBe('custom-fast-model');
    expect(result.model).toBe('custom-fast-model');
  });

  it('lets modelOverride win over config and the provider catalog', async () => {
    config.agent.fast_model = 'custom-fast-model';
    sendMessageMock.mockResolvedValue(textResult('{"title":"Pay invoice"}'));
    const result = await parseQuickTask('pay invoice', { modelOverride: 'request-fast-model' });
    expect(lastCall().config.model).toBe('request-fast-model');
    expect(result.model).toBe('request-fast-model');
  });

  // The pinTier rule is RENDERED from PIN_TIER_POLICY so the prompt and the
  // picker tooltips can't drift. Assert the wiring (every tier's guidance
  // reaches the prompt), not the prose — editing a guidance line is allowed.
  it('builds the pinTier rule from the shared tier policy', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Pay invoice"}'));
    await parseQuickTask('pay invoice');
    const system = lastCall().system;
    for (const entry of PIN_TIER_POLICY) {
      expect(system).toContain(`· ${entry.tier} — ${entry.guidance}`);
    }
    // "leave it unpinned" is a real answer and must be spelled out, otherwise
    // the model pins everything it is asked about.
    expect(system).toContain(PIN_TIER_NONE_GUIDANCE);
    // The old rule only fired on a literal "pin"/"focus" in the note, so
    // "urgent: fix the login bug" came back unpinned. Judging the WORK is the fix.
    expect(system).toContain('Judge it from the work itself');
  });

  // Custom tiers: pinTier accepts a registered ct_* id verbatim, normalizes a
  // label match to the id, and the prompt advertises each custom tier.
  it('accepts the built-in backlog tier verbatim', async () => {
    sendMessageMock.mockResolvedValue(textResult(
      '{"title":"Sort receipts","pinTier":"backlog"}',
    ));
    const result = await parseQuickTask('sort receipts someday');
    expect(result.parse).toEqual({ title: 'Sort receipts', pinTier: 'backlog' });
  });

  it('accepts a custom tier id from options.customTiers', async () => {
    sendMessageMock.mockResolvedValue(textResult(
      '{"title":"Sort receipts","pinTier":"ct_k3x9q2ab"}',
    ));
    const result = await parseQuickTask('sort receipts into the icebox', {
      customTiers: [{ id: 'ct_k3x9q2ab', label: 'Icebox' }],
    });
    expect(result.parse).toEqual({ title: 'Sort receipts', pinTier: 'ct_k3x9q2ab' });
  });

  it('normalizes a custom tier label match to its id', async () => {
    sendMessageMock.mockResolvedValue(textResult(
      '{"title":"Sort receipts","pinTier":"icebox"}',
    ));
    const result = await parseQuickTask('sort receipts into the icebox', {
      customTiers: [{ id: 'ct_k3x9q2ab', label: 'Icebox' }],
    });
    expect(result.parse).toEqual({ title: 'Sort receipts', pinTier: 'ct_k3x9q2ab' });
  });

  it('drops an unregistered custom tier id', async () => {
    sendMessageMock.mockResolvedValue(textResult(
      '{"title":"Sort receipts","pinTier":"ct_unknown1"}',
    ));
    const result = await parseQuickTask('sort receipts', {
      customTiers: [{ id: 'ct_k3x9q2ab', label: 'Icebox' }],
    });
    expect(result.parse).toEqual({ title: 'Sort receipts' });
  });

  it('renders one prompt line per custom tier', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Pay invoice"}'));
    await parseQuickTask('pay invoice', {
      customTiers: [{ id: 'ct_k3x9q2ab', label: 'Icebox' }],
    });
    expect(lastCall().system).toContain('· ct_k3x9q2ab — user-defined tier "Icebox"');
  });

  it('uses 320 max tokens and includes a weekday in the datetime line', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"title":"Pay invoice"}'));
    await parseQuickTask('pay invoice tomorrow', {
      now: new Date('2026-07-23T21:00:00.000Z'),
      timeZone: 'America/Los_Angeles',
    });
    expect(lastCall().config.maxTokens).toBe(320);
    expect(lastCall().messages[0].content).toContain(
      'Current local datetime: 2026-07-23T14:00:00 (Thursday)',
    );
  });
});
