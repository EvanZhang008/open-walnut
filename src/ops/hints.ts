/**
 * Message-hint ops: the registry of Walnut text that rides messages to a session's
 * model (src/core/hints/), open to agents exactly as Settings opens it to the user
 * (the same /api/v1/hints routes).
 */

import { z } from 'zod'
import { defineOp } from './registry.js'
import { withOutcome } from './outcome.js'

const TRIGGERS = ['every_turn', 'every_n_turns', 'session_start', 'after_compaction', 'on_change', 'on_drift', 'on_request'] as const
const ROLES = ['main', 'lead', 'worker', 'ask', 'other'] as const

const TRIGGER_HELP =
  'every_turn = every message; every_n_turns = every `every_turns` messages; session_start = the first message of '
  + 'a conversation; after_compaction = the first message after a compaction (also stated by the post-compaction hook); '
  + 'on_change = when what it says changed (a mode switch, an edited setting); on_drift = after a reply broke its rule '
  + '(the reply language); on_request = only when the sender asks (a voice send, a question number).'

type HintRow = { kind: string; label: string; enabled: boolean; triggers: string[]; every_turns?: number; placement: string; built_in: boolean }

function line(h: HintRow): string {
  const when = h.triggers.map((t) => (t === 'every_n_turns' ? `every ${h.every_turns ?? 5} messages` : t)).join(', ') || 'never'
  return `${h.kind}${h.enabled ? '' : ' (off)'}: ${when}, ${h.placement} the message`
}

defineOp({
  name: 'hint_list',
  title: 'List the message hints',
  description:
    'Every message hint: Walnut text sent with a message to a session\'s model as a <system-reminder> block '
    + '(question number, rich output, reply language, voice reply, and custom ones), with when each is sent, who gets it '
    + 'and where it goes. With `session`, also what that session was told and which hints its next message would carry. '
    + TRIGGER_HELP,
  input: {
    session: z.string().optional().describe('A session id: also show its hint state'),
  },
  handler: async (args, call) => {
    const q = typeof args.session === 'string' && args.session ? `?session=${encodeURIComponent(args.session)}` : ''
    const body = await call('GET', `/hints${q}`) as { hints: HintRow[]; session?: { next_message_carries: string[] } }
    return withOutcome(
      { ...body },
      `${body.hints.length} message hints: ${body.hints.map(line).join('; ')}.`
        + (body.session ? ` That session's next message would carry: ${body.session.next_message_carries.join(', ') || 'none'}.` : ''),
      'Change one with hint_set, put a built-in back to its default with hint_reset.',
    )
  },
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'hint_set',
  title: 'Change or add a message hint',
  description:
    'Change when a message hint is sent, who gets it, or where it goes; or add a custom hint (a new kind with `text`). '
    + 'Only the fields you pass change. ' + TRIGGER_HELP
    + ' A built-in keeps its own text: the reply language and the output mode are their own settings.',
  input: {
    kind: z.string().min(2).describe('The hint kind, e.g. "rich-output", "reply-language", or a new one for a custom hint'),
    enabled: z.boolean().optional(),
    triggers: z.array(z.enum(TRIGGERS)).optional().describe('When it is sent: any one that holds sends it'),
    every_turns: z.number().int().min(1).max(1000).optional().describe('For every_n_turns'),
    placement: z.enum(['before', 'after']).optional().describe('Before or after the message text'),
    audience: z.object({
      roles: z.array(z.enum(ROLES)).optional(),
      agents: z.array(z.string()).optional().describe('Agent ids (console agents)'),
      sessions: z.array(z.string()).optional().describe('Session ids'),
    }).optional().describe('Who gets it; an empty list means everyone'),
    text: z.string().optional().describe('A custom hint\'s text'),
    label: z.string().optional().describe('A custom hint\'s name in Settings'),
  },
  handler: async (args, call) => {
    const { kind, ...settings } = args as Record<string, unknown> & { kind: string }
    const body = await call('PUT', `/hints/${encodeURIComponent(kind)}`, settings) as { hint: HintRow | null }
    return withOutcome(
      { ...body },
      body.hint ? `Message hint ${line(body.hint)}.` : `Message hint ${kind} saved.`,
      'It applies from the next message each session receives.',
    )
  },
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'hint_reset',
  title: 'Reset a message hint',
  description: 'Put a built-in message hint back to its default, or remove a custom one.',
  input: {
    kind: z.string().min(2).describe('The hint kind'),
  },
  handler: async (args, call) => {
    const kind = String(args.kind)
    const body = await call('DELETE', `/hints/${encodeURIComponent(kind)}`) as { hint: HintRow | null }
    return withOutcome(
      { ...body },
      body.hint ? `Message hint back to its default: ${line(body.hint)}.` : `Custom message hint ${kind} removed.`,
      'It applies from the next message each session receives.',
    )
  },
  tags: { readonly: false, remote: 'allow' },
})
