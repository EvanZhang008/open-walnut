/**
 * ACP model-id parsing (web/src/components/sessions/acp-model-id.ts) — the
 * pure logic behind the ModelPicker's ACP pane regrouping. Two real id
 * dialects exist today: codex brackets effort ("openai.gpt-5.6-sol[xhigh]"),
 * opencode path-tails it on provider/model ids
 * ("amazon-bedrock/us.anthropic.claude-sonnet-4-6/high", 304-row catalog).
 */
import { describe, it, expect } from 'vitest';
import {
  parseAcpModelId,
  acpFamilyName,
  acpProviderGroupId,
  prettyGroupLabel,
  shortAcpModelName,
  acpModelDisplayName,
  groupAcpModels,
  acpFilterMatch,
} from '../../web/src/components/sessions/acp-model-id';

describe('parseAcpModelId', () => {
  it('splits the codex bracket form', () => {
    expect(parseAcpModelId('openai.gpt-5.6-sol[xhigh]'))
      .toEqual({ familyId: 'openai.gpt-5.6-sol', effort: 'xhigh' });
  });

  it('splits the opencode path-tail form', () => {
    expect(parseAcpModelId('amazon-bedrock/us.anthropic.claude-sonnet-4-6/high'))
      .toEqual({ familyId: 'amazon-bedrock/us.anthropic.claude-sonnet-4-6', effort: 'high' });
    expect(parseAcpModelId('amazon-bedrock/openai.gpt-oss-120b-1:0/max'))
      .toEqual({ familyId: 'amazon-bedrock/openai.gpt-oss-120b-1:0', effort: 'max' });
  });

  it('keeps a suffix-less provider/model id whole', () => {
    expect(parseAcpModelId('amazon-bedrock/us.anthropic.claude-sonnet-4-6'))
      .toEqual({ familyId: 'amazon-bedrock/us.anthropic.claude-sonnet-4-6', effort: null });
  });

  it('does NOT treat a two-segment "provider/high" as an effort variant', () => {
    expect(parseAcpModelId('someprovider/high'))
      .toEqual({ familyId: 'someprovider/high', effort: null });
  });

  it('leaves plain ids untouched (mock catalogs)', () => {
    expect(parseAcpModelId('mock-gpt-best')).toEqual({ familyId: 'mock-gpt-best', effort: null });
  });
});

describe('acpProviderGroupId', () => {
  it('takes the segment before the first slash', () => {
    expect(acpProviderGroupId('amazon-bedrock/us.anthropic.claude-sonnet-4-6')).toBe('amazon-bedrock');
  });

  it('is empty for slash-less ids (single anonymous group — column hides)', () => {
    expect(acpProviderGroupId('openai.gpt-5.6-sol')).toBe('');
    expect(acpProviderGroupId('mock-gpt-best')).toBe('');
  });
});

describe('labels', () => {
  it('prettyGroupLabel turns a provider slug into words', () => {
    expect(prettyGroupLabel('amazon-bedrock')).toBe('Amazon Bedrock');
    expect(prettyGroupLabel('github-copilot')).toBe('Github Copilot');
  });

  it('acpFamilyName gives Anthropic ids the versioned short form', () => {
    expect(acpFamilyName('amazon-bedrock/us.anthropic.claude-sonnet-4-6')).toBe('Sonnet 4.6');
  });

  it('acpFamilyName keeps the historical GPT prettification', () => {
    expect(acpFamilyName('openai.gpt-5.6-sol')).toBe('GPT 5.6 Sol');
  });

  it('shortAcpModelName renders family · effort for both dialects', () => {
    expect(shortAcpModelName('openai.gpt-5.6-sol[xhigh]')).toBe('GPT 5.6 Sol · X-High');
    expect(shortAcpModelName('amazon-bedrock/us.anthropic.claude-sonnet-4-6/high')).toBe('Sonnet 4.6 · High');
    // mock- prefix strips like the other adapter prefixes; no effort half.
    expect(shortAcpModelName('mock-gpt-best')).toBe('GPT Best');
  });
});

describe('acpModelDisplayName (the live pill label)', () => {
  it('strips the provider prefix off an advertised name when the id is grouped', () => {
    expect(acpModelDisplayName(
      'amazon-bedrock/us.anthropic.claude-sonnet-4-6/high',
      'Amazon Bedrock/Claude Sonnet 4.6 (US)',
    )).toBe('Claude Sonnet 4.6 (US)');
  });

  it('keeps an advertised name whole when the id has no provider group', () => {
    // A codex name could legitimately contain a slash — only a grouped ID
    // licenses the strip.
    expect(acpModelDisplayName('gpt-5.6-codex', 'GPT-5.6 Codex w/ tools'))
      .toBe('GPT-5.6 Codex w/ tools');
  });

  it('keeps a grouped model\'s name whole when its slash is NOT the provider prefix', () => {
    // Grouped id, but the advertised name skips the provider and just happens
    // to contain a slash — cutting at it would render "tools".
    expect(acpModelDisplayName('some-provider/claude-x', 'Claude w/ tools'))
      .toBe('Claude w/ tools');
  });

  it('derives from the id when no name is advertised, and nulls when neither exists', () => {
    expect(acpModelDisplayName('openai.gpt-5.6-sol[xhigh]', undefined)).toBe('GPT 5.6 Sol · X-High');
    expect(acpModelDisplayName(undefined, undefined)).toBeNull();
  });
});

describe('groupAcpModels', () => {
  // A realistic mixed catalog: two provider groups (opencode-style path ids
  // with effort tails) plus flat codex-style ids in the anonymous group.
  const CATALOG = [
    { modelId: 'mock-gpt-best', name: 'Mock GPT Best' },
    { modelId: 'mock-gpt-fast', name: 'Mock GPT Fast' },
    { modelId: 'amazon-bedrock/us.anthropic.claude-sonnet-4-6/low', name: 'Amazon Bedrock/Claude Sonnet 4.6 (US) (low)' },
    { modelId: 'amazon-bedrock/us.anthropic.claude-sonnet-4-6/high', name: 'Amazon Bedrock/Claude Sonnet 4.6 (US) (high)' },
    { modelId: 'amazon-bedrock/us.anthropic.claude-opus-4-8', name: 'Amazon Bedrock/Claude Opus 4.8 (US)' },
    { modelId: 'opencode/grok-code', name: 'opencode/Grok Code' },
  ];

  it('groups by provider prefix in catalog order, families carry their group label', () => {
    const groups = groupAcpModels(CATALOG);
    expect(groups.map((g) => g.id)).toEqual(['', 'amazon-bedrock', 'opencode']);
    expect(groups[1].label).toBe('Amazon Bedrock');
    const sonnet = groups[1].families.find((f) => f.familyId.includes('sonnet-4-6'))!;
    expect(sonnet.groupId).toBe('amazon-bedrock');
    expect(sonnet.groupLabel).toBe('Amazon Bedrock');
  });

  it('folds effort variants into one family with the tail stripped from the label', () => {
    const groups = groupAcpModels(CATALOG);
    const bedrock = groups.find((g) => g.id === 'amazon-bedrock')!;
    const sonnet = bedrock.families.find((f) => f.familyId === 'amazon-bedrock/us.anthropic.claude-sonnet-4-6')!;
    expect(sonnet.label).toBe('Claude Sonnet 4.6 (US)');
    expect([...sonnet.byEffort.keys()].sort()).toEqual(['high', 'low']);
    expect(sonnet.byEffort.get('high')!.modelId).toBe('amazon-bedrock/us.anthropic.claude-sonnet-4-6/high');
  });

  it('sorts families inside a group by model strength (opus above sonnet)', () => {
    const groups = groupAcpModels(CATALOG);
    const bedrock = groups.find((g) => g.id === 'amazon-bedrock')!;
    const order = bedrock.families.map((f) => f.familyId);
    expect(order.indexOf('amazon-bedrock/us.anthropic.claude-sonnet-4-6'))
      .toBeLessThan(order.indexOf('amazon-bedrock/us.anthropic.claude-opus-4-8'));
  });

  it('an adapter with NO names (name === modelId) still gets readable family labels', () => {
    const groups = groupAcpModels([
      { modelId: 'openai.gpt-5.6-sol[high]', name: 'openai.gpt-5.6-sol[high]' },
      { modelId: 'openai.gpt-5.6-sol[medium]', name: 'openai.gpt-5.6-sol[medium]' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].families[0].label).toBe('GPT 5.6 Sol');
    expect([...groups[0].families[0].byEffort.keys()].sort()).toEqual(['high', 'medium']);
  });

  it('handles an empty catalog', () => {
    expect(groupAcpModels([])).toEqual([]);
  });
});

describe('acpFilterMatch (the picker filter)', () => {
  const sonnet = {
    label: 'Claude Sonnet 4.6 (US)',
    familyId: 'amazon-bedrock/us.anthropic.claude-sonnet-4-6',
  };

  it('is separator-insensitive: dots, dashes and spaces all match each other', () => {
    expect(acpFilterMatch(sonnet, 'sonnet 4.6')).toBe(true);
    expect(acpFilterMatch(sonnet, 'sonnet 4-6')).toBe(true);
    expect(acpFilterMatch(sonnet, 'sonnet-4-6')).toBe(true);
    expect(acpFilterMatch(sonnet, 'sonnet_4_6')).toBe(true);
  });

  it('matches the raw family id too (provider slugs, dotted vendor ids)', () => {
    expect(acpFilterMatch(sonnet, 'us.anthropic')).toBe(true);
    expect(acpFilterMatch(sonnet, 'amazon bedrock')).toBe(true);
  });

  it('ANDs whitespace tokens across label+id+provider: "bedrock sonnet" hits', () => {
    // The natural query is provider + model — the two things the row shows —
    // and those never sit contiguously in any one haystack string.
    expect(acpFilterMatch(sonnet, 'bedrock sonnet')).toBe(true);
    expect(acpFilterMatch(sonnet, 'sonnet bedrock')).toBe(true);
    expect(acpFilterMatch({ ...sonnet, groupLabel: 'Amazon Bedrock' }, 'bedrock 4.6')).toBe(true);
    // Every token must hit — one stray token rejects.
    expect(acpFilterMatch(sonnet, 'bedrock opus')).toBe(false);
  });

  it('treats "/" as a separator (provider/model ids match across the slash)', () => {
    expect(acpFilterMatch(sonnet, 'bedrock us anthropic')).toBe(true);
  });

  it('rejects a non-substring and accepts a blank query', () => {
    expect(acpFilterMatch(sonnet, 'opus')).toBe(false);
    expect(acpFilterMatch(sonnet, '   ')).toBe(true);
  });
});
