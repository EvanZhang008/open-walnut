/**
 * The topic ops' outside words, framed for the agent that reads them (core/outside-content.ts).
 *
 * A topic's person members (core/topics/topics-model.ts MEMBER_WORDS) reply by mail: what they wrote
 * is an outside party's text, and can say "ignore your instructions" as well as any mail. So
 * topic_read gives each such message's text in its own envelope, and topic_list the last message's
 * line when such a member wrote it. Who wrote it is decided by the author the store records
 * (messageWords), never by the text. The user's, the agents' and Walnut's own messages stay plain, as
 * do the message's id, author, time and delivery fields (Walnut's). A person's topic panel reads the
 * routes, which stay plain; an agent's call (agentReadsFramed) reads these.
 */
import { frameOutsideData, outsideDataOf, type OutsideSource } from '../core/outside-content.js'
import { messageWords, type Topic, type TopicMessage } from '../core/topics/topics-model.js'

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

/** The envelope's source for a person member's message, by the name it reads as. */
function mailSource(name: unknown): OutsideSource {
  return { source: 'topic message by mail', ...(typeof name === 'string' && name ? { attrs: { from: name } } : {}) }
}

/** The same, by the message's author id. */
function memberSource(topic: Pick<Topic, 'members'>, author: unknown): OutsideSource {
  return mailSource((Array.isArray(topic.members) ? topic.members : []).find((m) => m.id === author)?.name)
}

/** topic_read's answer: each outside message's text in its own envelope. */
export function framedTopicRead<T>(body: T): T {
  const b = rec(body)
  const topic = rec(b.topic) as unknown as Topic
  if (!Array.isArray(topic.messages) || !Array.isArray(topic.members)) return body
  const messages = topic.messages.map((m: TopicMessage) => (
    messageWords(topic, m) === 'outside' && typeof m.text === 'string'
      ? { ...m, text: frameOutsideData(memberSource(topic, m.author), m.text) }
      : m
  ))
  return { ...b, topic: { ...topic, messages } } as T
}

/** topic_list's answer: the last line of a topic in an envelope when a person member wrote it. */
export function framedTopicList<T>(body: T): T {
  const b = rec(body)
  if (!Array.isArray(b.topics)) return body
  const topics = b.topics.map((raw) => {
    const t = rec(raw)
    const last = rec(t.last)
    if (last.outside !== true || typeof last.text !== 'string') return raw
    return { ...t, last: { ...last, text: frameOutsideData(mailSource(last.author), last.text) } }
  })
  return { ...b, topics } as T
}

/**
 * A message's text shortened by `cut` for an op's shape: a framed text is cut inside its envelope and
 * framed again with the same source, so a shape never takes it out of the frame. `length` is the
 * text's own, for the shape's `chars`.
 */
export function cutTopicText(topic: Pick<Topic, 'members'>, m: Record<string, unknown>, cut: (text: string) => string): { text: unknown; length: number } {
  if (typeof m.text === 'string') return { text: cut(m.text), length: m.text.length }
  const inner = outsideDataOf(m.text)
  const text = typeof inner === 'string' ? inner : ''
  return { text: frameOutsideData(memberSource(topic, m.author), cut(text)), length: text.length }
}

/** topic_list's shape: the last line cut to `max`, inside its envelope when it has one. */
export function cutLastLine(last: Record<string, unknown>, cut: (text: string) => string): unknown {
  if (typeof last.text === 'string') return cut(last.text)
  const inner = outsideDataOf(last.text)
  return frameOutsideData(mailSource(last.author), cut(typeof inner === 'string' ? inner : ''))
}
