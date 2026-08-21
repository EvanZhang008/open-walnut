import { describe, expect, it } from 'vitest'
import { sortByModelStrength } from '../../web/src/utils/model-strength-order'

interface Choice {
  id: string
  label: string
  resolved?: string
}

function sort(choices: Choice[]): Choice[] {
  return sortByModelStrength(choices, (choice) =>
    [choice.id, choice.label, choice.resolved].filter(Boolean).join(' '))
}

describe('sortByModelStrength', () => {
  it('orders the mixed Claude Code catalog from weakest to strongest', () => {
    const choices: Choice[] = [
      { id: 'global.anthropic.claude-opus-5[1m]', label: 'Opus 5 1M' },
      { id: 'default', label: 'Default', resolved: 'global.anthropic.claude-opus-5[1m]' },
      { id: 'global.anthropic.claude-fable-5[1m]', label: 'Fable 5 1M' },
      { id: 'global.anthropic.claude-sonnet-5', label: 'Sonnet 5' },
      { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Haiku 4.5' },
      { id: 'openai.gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    ]

    expect(sort(choices).map((choice) => choice.label)).toEqual([
      'Haiku 4.5',
      'Sonnet 5',
      'Fable 5 1M',
      'GPT-5.6 Sol',
      'Default',
      'Opus 5 1M',
    ])
  })

  it('orders versions and context sizes ascending inside one model family', () => {
    const choices: Choice[] = [
      { id: 'claude-opus-5[1m]', label: 'Opus 5 1M' },
      { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 1M' },
      { id: 'claude-opus-4-7', label: 'Opus 4.7' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
    ]

    expect(sort(choices).map((choice) => choice.label)).toEqual([
      'Opus 4.7',
      'Opus 4.8',
      'Opus 4.8 1M',
      'Opus 5 1M',
    ])
  })

  it('uses provider tier names for dynamically discovered Codex families', () => {
    const choices: Choice[] = [
      { id: 'openai.gpt-5.6-pro', label: 'GPT 5.6 Pro' },
      { id: 'openai.gpt-5.6-sol', label: 'GPT 5.6 Sol' },
      { id: 'openai.gpt-5.6-mini', label: 'GPT 5.6 Mini' },
      { id: 'openai.gpt-5.6-nano', label: 'GPT 5.6 Nano' },
    ]

    expect(sort(choices).map((choice) => choice.label)).toEqual([
      'GPT 5.6 Nano',
      'GPT 5.6 Mini',
      'GPT 5.6 Sol',
      'GPT 5.6 Pro',
    ])
  })

  it('keeps unknown models stable and does not mutate the input', () => {
    const choices: Choice[] = [
      { id: 'vendor.unknown-b', label: 'Unknown B' },
      { id: 'vendor.unknown-a', label: 'Unknown A' },
    ]
    const before = [...choices]

    expect(sort(choices)).toEqual(before)
    expect(choices).toEqual(before)
  })
})
