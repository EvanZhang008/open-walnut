/**
 * Reading a person's mail reply back into a topic: the subject token, addresses, Message-IDs,
 * and the quoted part of realistic Gmail, Outlook and phone replies.
 */
import { describe, expect, it } from 'vitest'
import {
  bareAddress, canonicalMessageId, MAX_INBOUND_CHARS, stripQuotedReply, topicIdFromSubject, topicMailSubject,
} from '../../../src/core/topics/topic-mail-text.js'

describe('subject token', () => {
  it('builds and reads "<title> [topic tp-...]", through Re:/Fwd: and case changes', () => {
    expect(topicMailSubject('Launch plan', 'tp-0123456789ab')).toBe('Launch plan [topic tp-0123456789ab]')
    expect(topicMailSubject('Two\nlines', 'tp-0123456789ab')).toBe('Two lines [topic tp-0123456789ab]')
    expect(topicIdFromSubject('Re: Launch plan [topic tp-0123456789ab]')).toBe('tp-0123456789ab')
    expect(topicIdFromSubject('RE: FW: Launch plan [Topic TP-0123456789AB]')).toBe('tp-0123456789ab')
    expect(topicIdFromSubject('Launch plan')).toBeUndefined()
    expect(topicIdFromSubject('[topic tp-]')).toBeUndefined()
  })
})

describe('addresses and Message-IDs', () => {
  it('reads the bare address, lower case', () => {
    expect(bareAddress('Ada Lovelace <Ada@Example.com>')).toBe('ada@example.com')
    expect(bareAddress(' ada@example.com ')).toBe('ada@example.com')
  })

  it('keeps a Message-ID in <id@host> form and refuses what is not one', () => {
    expect(canonicalMessageId('abc@example.org')).toBe('<abc@example.org>')
    expect(canonicalMessageId('<abc@example.org>')).toBe('<abc@example.org>')
    expect(canonicalMessageId('<abc example.org>')).toBe('')
    expect(canonicalMessageId('no-at-sign')).toBe('')
    expect(canonicalMessageId(undefined)).toBe('')
  })
})

describe('stripQuotedReply', () => {
  it('drops a Gmail "On ... wrote:" block and its quote', () => {
    const body = [
      'Sounds good, I will take the API part.',
      '',
      'Ada',
      '',
      'On Fri, Nov 20, 2026 at 10:14 AM Walnut <walnut@example.org> wrote:',
      '',
      '> Owner: Can someone take the API?',
      '>',
      '> Reply to this email to post in the topic. Mention @Name to call someone.',
      '',
    ].join('\n')
    expect(stripQuotedReply(body)).toBe('Sounds good, I will take the API part.\n\nAda')
  })

  it('drops a Gmail attribution wrapped over two lines', () => {
    const body = [
      'Sure, Thursday.',
      '',
      'On Fri, Nov 20, 2026 at 10:14 AM Walnut Topic Mailer <',
      'walnut@example.org> wrote:',
      '> Owner: When?',
    ].join('\r\n')
    expect(stripQuotedReply(body)).toBe('Sure, Thursday.')
  })

  it('drops an Outlook web reply (rule, then From/Sent/To/Subject)', () => {
    const body = [
      'Yes, Thursday works for me.',
      '',
      'Ada',
      '',
      '________________________________',
      'From: Walnut <walnut@example.org>',
      'Sent: Friday, November 20, 2026 10:14 AM',
      'To: Ada <ada@example.com>',
      'Subject: Launch plan [topic tp-0123456789ab]',
      '',
      'Owner: Does Thursday work?',
    ].join('\r\n')
    expect(stripQuotedReply(body)).toBe('Yes, Thursday works for me.\n\nAda')
  })

  it('drops an Outlook desktop reply (From/Sent block without a rule, or Original Message)', () => {
    expect(stripQuotedReply([
      'Agreed.',
      '',
      'From: Walnut <walnut@example.org>',
      'Sent: Friday, November 20, 2026 10:14 AM',
      'To: Ada',
      'Subject: RE: Launch plan',
      '',
      'Owner: ok?',
    ].join('\n'))).toBe('Agreed.')
    expect(stripQuotedReply('Fine by me.\n\n-----Original Message-----\nFrom: Walnut\nOwner: ok?')).toBe('Fine by me.')
  })

  it('keeps an ordinary line that starts with "From:" when no header block follows', () => {
    expect(stripQuotedReply('From: my side the numbers look right.\nThanks')).toBe('From: my side the numbers look right.\nThanks')
  })

  it('drops a signature after "-- " and a phone footer', () => {
    expect(stripQuotedReply('Done.\n\n-- \nAda Lovelace\nExample Labs')).toBe('Done.')
    expect(stripQuotedReply('On it\n\nSent from my phone\n\nOn Fri wrote:\n> x')).toBe('On it')
  })

  it('keeps inline replies between quoted lines', () => {
    const body = '> Owner: Who takes the API?\nI do.\n> Owner: And the docs?\nBob, I think.'
    expect(stripQuotedReply(body)).toBe('I do.\nBob, I think.')
  })

  it('answers empty for a reply that is only quote, and cuts a very long one', () => {
    expect(stripQuotedReply('> only quote\n>\n')).toBe('')
    const long = stripQuotedReply('x'.repeat(MAX_INBOUND_CHARS + 50))
    expect(long.endsWith('[cut: the mail was longer]')).toBe(true)
    expect(long.length).toBeLessThan(MAX_INBOUND_CHARS + 40)
  })
})
