import { describe, it, expect } from 'vitest'
import {
  describeText, filledParamsText, ideaText, missingRequired, templateHandoffText, TRIGGER_IDEAS, TRIGGER_PLAIN_LEAD,
} from '../../web/src/components/sessions/trigger-picker-model'
import type { TriggerTemplate } from '../../web/src/api/trigger-templates'

const TEMPLATE: TriggerTemplate = {
  id: 'slack:channel-message',
  pluginId: 'slack',
  pluginName: 'Slack',
  title: 'New message in a channel',
  description: 'Fires on each new message.',
  every: '5m',
  params: [
    { key: 'channel', label: 'Channel', required: true },
    { key: 'contains', label: 'Contains' },
  ],
}

describe('trigger picker words', () => {
  it('leads with the skill command for Claude Code and a plain sentence for an ACP engine', () => {
    expect(describeText(false)).toBe('/walnut-trigger ')
    expect(describeText(false, 'When PR #')).toBe('/walnut-trigger When PR #')
    expect(describeText(true, 'When PR #')).toBe(`${TRIGGER_PLAIN_LEAD}When PR #`)
  })

  it('an idea about a time goes in as plain words, so the AI can pick a cron job', () => {
    const schedule = TRIGGER_IDEAS.find((i) => i.schedule)!
    expect(ideaText(false, schedule)).toBe('Set up a cron job: every weekday at 9:00, ')
    const pr = TRIGGER_IDEAS[0]!
    expect(ideaText(false, pr)).toBe(`/walnut-trigger ${pr.text}`)
    expect(ideaText(true, pr)).toBe(`${TRIGGER_PLAIN_LEAD}${pr.text}`)
  })

  it('hands a template to the AI by its exact id, with what the user filled', () => {
    expect(templateHandoffText(false, TEMPLATE, { channel: '#eng-oncall' })).toBe(
      '/walnut-trigger Use the "New message in a channel" trigger from the Slack plugin '
      + '(template slack:channel-message, channel #eng-oncall). When it fires, ',
    )
    expect(templateHandoffText(true, TEMPLATE, {})).toContain('(template slack:channel-message). When it fires, ')
    expect(filledParamsText(TEMPLATE, { channel: ' #a ', contains: 'deploy' })).toBe('channel #a, contains deploy')
  })

  it('names the required params still empty', () => {
    expect(missingRequired(TEMPLATE, {})).toEqual(['Channel'])
    expect(missingRequired(TEMPLATE, { channel: '  ' })).toEqual(['Channel'])
    expect(missingRequired(TEMPLATE, { channel: '#a' })).toEqual([])
  })
})
