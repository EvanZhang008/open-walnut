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
