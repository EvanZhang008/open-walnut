/**
 * Human-inbox ops — how an agent writes to the ONE human who reads its letters.
 *
 * Two ops only: send a letter, reply in an existing letter's thread. The
 * envelope (which session, task, project, host) is stamped server-side from the
 * caller's session id, so the descriptions below spend their words on the thing
 * the model actually has to get right: writing a letter worth reading.
 */

import { z } from 'zod'
import { defineOp } from './registry.js'

const LETTER_TYPE = z.enum(['completion', 'action_required', 'review', 'info'])

const ACTION = z.object({
  id: z.string().min(1).describe('Stable id you receive back when the human picks this option'),
  label: z.string().min(1).describe('Button text, e.g. "Option A: cache the result"'),
  description: z.string().optional().describe('One line of trade-off shown under the button'),
})

defineOp({
  name: 'human_inbox_send',
  title: 'Send the human a letter',
  description:
    'Send your user a letter they read in Walnut (web or phone) and can reply to. Use it for a '
    + 'finished result, a report worth keeping, a heads-up, or a decision you are blocked on. '
    + 'Writing standard: one phone screen, background in 1-2 sentences, then the point; '
    + 'self-contained (never "see the session"); link long artifacts by path instead of pasting them. '
    + 'Body is markdown (usual choice) or self-contained html with inline styles, exactly one of the two. '
    + 'type=action_required means you need a decision: give `actions` as the options, and the human '
    + 'taps one, whose choice is delivered back into this session. Never write who you are; the '
    + 'sender (session, task, host) is stamped for you. Returns the letter id, which you need to reply.',
  input: {
    subject: z.string().min(1).describe('One line the human reads first, like an email subject'),
    type: LETTER_TYPE.describe('completion | action_required | review | info'),
    markdown: z.string().optional().describe('Letter body as markdown (exactly one of markdown | html)'),
    html: z.string().optional().describe(
      'Letter body as self-contained HTML, no scripts (inline styles only). The one body that may '
      + 'carry inline media as data: URIs — a chart image, an audio digest as '
      + '<audio controls src="data:audio/mpeg;base64,...">, or a clip as '
      + '<video controls src="data:video/mp4;base64,...">. Up to 24MB (about a 35-minute podcast); '
      + 'remote URLs are blocked. A payload this big cannot ride argv: pass it with '
      + '`walnut tools call human_inbox_send @/path/payload.json`.'),
    text: z.string().optional().describe('Short plain-text preview for the envelope row and the phone push'),
    actions: z.array(ACTION).optional().describe('action_required only: the options rendered as buttons'),
    task_refs: z.array(z.string()).optional().describe('Task ids this letter is about; rendered as clickable pills'),
    pin: z.boolean().optional().describe('Pin it to the top of the inbox (digests, standing reports)'),
  },
  bind: { method: 'POST', path: '/human-inbox' },
  mapResult: ({ body }) => ({
    letterId: (body as { id?: unknown } | undefined)?.id,
    instruction:
      'The letter is in the human\'s inbox. If they answer, their reply arrives as a message in '
      + 'this session; continue the thread with human_inbox_reply and that letterId.',
  }),
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'human_inbox_reply',
  title: 'Reply in a letter thread',
  description:
    'Append your answer to a letter you already sent, once the human has replied or clicked an '
    + 'option. Same standard as the letter itself: answer the question first, keep it to a few '
    + 'sentences, link anything long. This flips the letter back to unread and notifies them, so '
    + 'reply here rather than only in the session, otherwise your answer never leaves this host.',
  input: {
    letter: z.string().min(1).describe('Letter id from human_inbox_send (lt-...)'),
    text: z.string().min(1).describe('Your reply as plain text (always required: it is the thread line)'),
    markdown: z.string().optional().describe('Optional richer body rendered under the reply'),
    html: z.string().optional().describe('Optional self-contained HTML body, no scripts'),
  },
  bind: { method: 'POST', path: '/human-inbox/:letter/reply' },
  tags: { readonly: false, remote: 'allow' },
})
