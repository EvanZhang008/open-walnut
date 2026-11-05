/**
 * The tasks a message in Main's, a VP's or a lead's chat is about (src/core/org/message-about.ts).
 * 2026-10-31, the user decided it: the node's session ends its message with a hidden line, Walnut
 * takes the line off and draws the tasks under the message; without the line, Walnut falls back to
 * the task the message answered or was sent to. Covered here: the parser, the fallback, the history
 * parse (one field the web and the phone read), the prompt rule for Main and a lead (never a
 * worker), and the web's renderer wiring.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-message-about'))

import { aboutIds, envelopeFromTask, messageAbout, readAboutTag, sentToTasks, stripAboutTag } from '../../../src/core/org/message-about.js'
import { parseSessionMessages } from '../../../src/core/session-history.js'
import { MESSAGE_ABOUT_LINE, buildSessionContext } from '../../../src/core/sessions/session-context.js'
import type { Task } from '../../../src/core/types.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')

describe('the line', () => {
  it('is read off the end, outside a code block, and leaves the text', () => {
    expect(readAboutTag('Done.\n\n<walnut-about tasks="mt-a-1,mt-b-2"/>')).toEqual({ text: 'Done.', ids: ['mt-a-1', 'mt-b-2'], tagged: true })
    // Before the agent-ack line, or with spaces between the ids.
    expect(readAboutTag('Ok\n<walnut-about tasks="mt-a-1 mt-b-2"/>\n<walnut-turn status="agent-ack"/>').ids).toEqual(['mt-a-1', 'mt-b-2'])
    // In a code block, in a sentence, or far up the message: text.
    const fenced = 'Use this:\n```\n<walnut-about tasks="mt-a-1"/>\n```'
    expect(readAboutTag(fenced)).toMatchObject({ tagged: false, text: fenced })
    expect(readAboutTag('Write <walnut-about tasks="mt-a-1"/> at the end.').tagged).toBe(false)
    expect(readAboutTag('<walnut-about tasks="mt-a-1"/>\none\ntwo\nthree\nfour').tagged).toBe(false)
  })

  it('names each id once, at most six, and nothing that is not an id', () => {
    expect(aboutIds('a1b, a1b ,x,"y", mt-c-3')).toEqual(['a1b', 'mt-c-3'])
    expect(aboutIds(Array.from({ length: 9 }, (_, i) => `mt-${i}-x`).join(','))).toHaveLength(6)
  })

  it('never flashes while it streams in', () => {
    expect(stripAboutTag('Done.\n<walnut-ab', true)).toBe('Done.')
    expect(stripAboutTag('Done.\n<walnut-about tasks="mt-a', true)).toBe('Done.')
    expect(stripAboutTag('Done.\n<walnut-ab', false)).toBe('Done.\n<walnut-ab')
    expect(stripAboutTag('a < b', true)).toBe('a < b')
  })
})

describe('the fallback', () => {
  const ask = '<walnut-message kind="request" from="Walnut lead" from-task="mt-lead-1" request="rq-1">Status?</walnut-message>'
  const send = { name: 'Bash', input: { command: `walnut tools call task_send '{"task":"mt-worker-2","text":"go"}'` } }

  it('is the task whose message started the turn, and the tasks the turn sent to', () => {
    expect(envelopeFromTask(ask)).toBe('mt-lead-1')
    expect(sentToTasks(send)).toEqual(['mt-worker-2'])
    expect(sentToTasks({ name: 'Bash', input: { command: 'git status' } })).toEqual([])
    // org_send's `to` names a project or a VP: only a task id counts.
    expect(sentToTasks({ name: 'org_send', input: { to: 'mvp0vp33-3a1b', text: 'hi' } })).toEqual(['mvp0vp33-3a1b'])
    expect(sentToTasks({ name: 'org_send', input: { to: 'Inbox', text: 'hi' } })).toEqual([])
    expect(sentToTasks({ name: 'Bash', input: { command: `walnut tools call org_send '{"to":"Garden Team","text":"hi"}'` } })).toEqual([])
    // A task the turn made: its id from task_create's answer.
    expect(sentToTasks({ name: 'Bash', input: { command: `walnut tools call task_create '{"title":"Water the beds"}'` }, result: '{\n  "task": {\n    "id": "mvq1abcd-12ef",\n    "title": "Water the beds"' })).toEqual(['mvq1abcd-12ef'])
    expect(sentToTasks({ name: 'Bash', input: { command: `walnut tools call task_create '{"title":"x"}'` }, result: 'error: 409' })).toEqual([])
    const rows = [
      { role: 'user' as const, text: ask },
      { role: 'assistant' as const, text: '', tools: [send] },
      { role: 'assistant' as const, text: 'Asked the worker.' },
      // The person's own next message: a new turn with no asker.
      { role: 'user' as const, text: 'thanks' },
      { role: 'assistant' as const, text: 'Sure.' },
      { role: 'assistant' as const, text: 'Tagged.\n<walnut-about tasks="mt-x-9"/>' },
    ]
    const about = messageAbout(rows)
    expect(about.get(2)).toEqual({ ids: ['mt-lead-1', 'mt-worker-2'], tagged: false })
    expect(about.has(4)).toBe(false)
    expect(about.get(5)).toEqual({ ids: ['mt-x-9'], tagged: true })
  })
})

describe('the history parse', () => {
  const line = (o: Record<string, unknown>) => JSON.stringify(o)
  const jsonl = [
    line({ type: 'user', uuid: 'u1', timestamp: '2026-10-31T10:00:00Z', message: { role: 'user', content: 'How is the move going?' } }),
    line({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-31T10:00:05Z', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'The movers are booked.\n\n<walnut-about tasks="mt-move-1,mt-vp-2"/>' }] } }),
  ].join('\n')

  it('puts the tasks on the row and takes the line off its text', () => {
    const rows = parseSessionMessages(jsonl)
    const reply = rows.find((r) => r.role === 'assistant')!
    expect(reply.text).toBe('The movers are booked.')
    expect(reply.about).toEqual(['mt-move-1', 'mt-vp-2'])
    expect(reply.aboutTagged).toBe(true)
  })
})

describe('the line never leaves the chat', () => {
  it('is off a quoted last message and off the Brief', async () => {
    const { createEnvelopeKit } = await import('../../../src/core/peers/envelope-kit.js')
    const kit = createEnvelopeKit()
    expect(kit.clipNoticeMessage('Done.\n<walnut-about tasks="mt-a-1"/>')?.text).toBe('Done.')
    expect(kit.clipNoticeMessage('Done.\n<walnut-about tasks="mt-a-1"/>\n<walnut-turn status="agent-ack"/>')?.text).toBe('Done.')
    expect(kit.clipNoticeMessage('Done.\n<walnut-about tasks="mt-a-1"/>\n\n<walnut-turn status="agent-ack"/>')?.text).toBe('Done.')
    // Not a last line of its own: it stays.
    expect(kit.clipNoticeMessage('Write <walnut-about tasks="mt-a-1"/> last.')?.text).toContain('walnut-about')
    const { structureBrief } = await import('../../../src/core/sessions/brief-structure.js')
    expect(structureBrief('### Working\n- moving\n<walnut-about tasks="mt-a-1"/>', 'mt-owner', []).text).not.toContain('walnut-about')
  })
})

describe('the rule', () => {
  const task = (over: Partial<Task>): Task => ({ id: 'mt-about-1', title: 'Plan the move', project: 'marina', phase: 'IN_PROGRESS', ...over }) as Task
  const promptOf = async (over: Partial<Task>) => (await buildSessionContext('mt-about-1', '/x', 'h', { task: task(over) })).systemPrompt

  it('rides the prompt of Main and of a lead, never a worker\'s', async () => {
    expect(MESSAGE_ABOUT_LINE).toMatch(/<walnut-about tasks="<id>,<id>"\/>/)
    expect(MESSAGE_ABOUT_LINE).toMatch(/The main agent names the VP's own task and the task itself/)
    expect(MESSAGE_ABOUT_LINE).toMatch(/a VP names the task and, when that task leads a team of its own, its lead too/)
    expect(await promptOf({ org_role: 'main', walnut_agent: true })).toContain(MESSAGE_ABOUT_LINE.trim())
    expect(await promptOf({ org_role: 'lead' })).toContain(MESSAGE_ABOUT_LINE.trim())
    expect(await promptOf({})).not.toContain('<walnut-about')
  })
})

describe('the web', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  it('draws the tasks under a reply in Main\'s or a lead\'s chat, and the line never prints', () => {
    expect(read('web/src/components/sessions/SessionPanel.tsx')).toMatch(/<MessageAboutContext\.Provider value=\{sessionTask\?\.org_role === 'main' \|\| sessionTask\?\.org_role === 'lead'\}>/)
    expect(read('web/src/components/sessions/SessionMessage.tsx')).toMatch(/<MessageAbout ids=\{aboutIds\} \/>/)
    expect(read('src/lib/turn-end-marker.ts')).toMatch(/stripAboutTag\(text, streaming\)/)
    expect(read('web/src/types/session.ts')).toMatch(/about\?: string\[\];/)
  })
})
