/**
 * `walnut.letters`: a plugin's side of the human inbox (packages/plugin-api/src/server.ts
 * LettersService). A letter with actions is an approval the person answers; one with no actions
 * reaches the inbox only when it is a report the person set up or asked for (`userAsked`), and
 * otherwise becomes a notice of the plugin in the notification center (human-inbox/
 * info-letter-rule.ts). Every letter is stamped host-side with the plugin's identity, and
 * `onAnswered` hears only this plugin's own letters.
 */
import { bus } from '../event-bus.js'
import type { HumanInboxAnsweredEvent } from '../event-types.js'
import { isFollower } from '../server-role.js'
import { toDisposable, type Disposable } from './disposable.js'
import { namespacedDedup } from './plugin-notifications.js'
import type { PluginLogger } from './plugin-context.js'

/**
 * Letters one plugin may send per minute.
 *
 * A letter is the loudest thing a plugin can do: it lands in the human inbox, it badges the
 * bell and it pushes to the phone. A loop that asks for approval per item would otherwise
 * turn one bug into a night of notifications, so the ceiling is low enough that a runaway is
 * refused with words the author can act on, and high enough that a real burst (a batch of
 * drafts approved one at a time) still gets through.
 */
const LETTERS_PER_MINUTE = 30
const LETTER_WINDOW_MS = 60_000

/** The letter kind for a plugin letter with no buttons: a document, not a decision. */
const INFORMATIONAL_LETTER_TYPE = 'info' as const

export interface PluginLetterInput {
  subject: string
  markdown?: string
  html?: string
  text?: string
  actions?: Array<{ id: string; label: string; description?: string }>
  items?: import('../../../packages/plugin-api/src/inbox-items.js').InboxLetterItem[]
  taskRefs?: string[]
  pin?: boolean
  /** A report the person set up or asked for: only then does a letter with no actions reach the inbox. */
  userAsked?: boolean
}

/**
 * Letter send times per plugin, in module scope rather than per api instance.
 *
 * A plugin reload builds a fresh api bag, so a counter living on that bag would let a
 * reload loop send without limit. Keyed by plugin id, the window survives the reload.
 */
const letterSendTimes = new Map<string, number[]>()

function chargeLetterQuota(pluginId: string): void {
  const now = Date.now()
  const recent = (letterSendTimes.get(pluginId) ?? []).filter((at) => now - at < LETTER_WINDOW_MS)
  if (recent.length >= LETTERS_PER_MINUTE) {
    letterSendTimes.set(pluginId, recent)
    throw new Error(
      `The plugin "${pluginId}" has already sent ${LETTERS_PER_MINUTE} letters in the last minute, `
      + 'which is the limit. A letter badges the bell and pushes to the phone, so a loop that sends '
      + 'one per item would bury the human. Roll the batch up into one letter, or wait out the minute.',
    )
  }
  recent.push(now)
  letterSendTimes.set(pluginId, recent)
}

/** Test-only: forget every plugin's letter window, so one test's burst is not the next one's. */
export function _resetPluginLetterQuotaForTesting(): void {
  letterSendTimes.clear()
}

export interface PluginLettersOptions {
  pluginId: string
  pluginName?: string
  own: <T extends Disposable>(registration: T) => T
  assertLive: (registration: string) => void
  logger: PluginLogger
  notifyError: (message: string, detail?: unknown) => Promise<void>
  /** A fresh bus subscriber id for one `onAnswered`. */
  subscriber: () => string
}

export function createPluginLetters(o: PluginLettersOptions) {
  const { pluginId } = o
  return {
    /**
     * Whether a step the plugin would ask about waits for the person now: the person's one
     * Approvals switch (Settings, `config.approvals.ask_me`, off by default). `false`: do the step
     * now and record it where the person reads it afterwards; send no approval letter.
     */
    async asksPerson(): Promise<boolean> {
      const { asksPerson } = await import('../approvals/ask-me.js')
      return asksPerson()
    },
    /**
     * Whether an outward text looks personal or sensitive (promotion, pay, health and the rest:
     * core/outbound/sensitive-hold.ts): the step then waits for the person even with the switch
     * off, and the reason leads the letter. Null: nothing found.
     */
    async sensitiveHold(text: string): Promise<{ reason: string } | null> {
      const { sensitiveHold } = await import('../outbound/sensitive-hold.js')
      return sensitiveHold(typeof text === 'string' ? text : '')
    },
    async recordUnasked(input: { what: string; detail?: string }): Promise<void> {
      const what = typeof input?.what === 'string' ? input.what.trim() : ''
      if (!what) return
      const { recordUnasked } = await import('../approvals/ask-me.js')
      await recordUnasked('pluginStep', {
        what: what.slice(0, 300),
        ...(typeof input.detail === 'string' && input.detail ? { detail: input.detail.slice(0, 4000) } : {}),
        requester: { host: (await import('node:os')).hostname() || 'this computer', process: `plugin ${pluginId}`, local: true },
      })
    },
    async send(input: PluginLetterInput): Promise<{ letterId: string; outcome: 'letter' | 'notice'; noticeId?: string }> {
      chargeLetterQuota(pluginId)
      // A letter with no buttons that the person did not ask for (a new-message count, a digest
      // nobody set up) is a notice of this plugin, not a letter (human-inbox/info-letter-rule.ts).
      // The call still resolves, so a plugin written before the rule keeps working.
      if (!input.actions?.length && input.userAsked !== true) {
        const { noticeSubjectKey, sendInfoNotice } = await import('../human-inbox/info-letter-rule.js')
        const subject = typeof input.subject === 'string' ? input.subject : ''
        if (!subject.trim()) throw new TypeError('A letter needs a subject')
        const notice = await sendInfoNotice(
          { subject, text: input.text, markdown: input.markdown, html: input.html, taskRefs: input.taskRefs },
          { dedupKey: namespacedDedup(pluginId, `letter:${noticeSubjectKey(subject)}`), emitSource: `plugin/${pluginId}`, why: 'a plugin letter with no actions' },
        )
        return { letterId: '', outcome: 'notice', noticeId: notice.id }
      }
      const { sendLetter } = await import('../human-inbox/store.js')
      const letter = await sendLetter({
        subject: input.subject,
        // Buttons are what makes it a decision. Without them it is a document, and the store
        // refuses `action_required` with no actions precisely so a dead end cannot ship.
        type: input.actions?.length ? 'action_required' : INFORMATIONAL_LETTER_TYPE,
        ...(input.markdown !== undefined ? { markdown: input.markdown } : {}),
        ...(input.html !== undefined ? { html: input.html } : {}),
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.actions?.length ? { actions: input.actions.map((one) => ({ ...one })) } : {}),
        ...(input.items !== undefined ? { items: input.items } : {}),
        ...(input.taskRefs ? { taskRefs: [...input.taskRefs] } : {}),
        ...(input.pin !== undefined ? { pin: input.pin } : {}),
        ...(input.userAsked === true ? { userAsked: true } : {}),
        // `local` matches the sender the inbox already uses for a caller with no session: a
        // plugin runs inside THIS server process, which is the box the human is looking at.
        sender: { sessionId: 'external', host: 'local', pluginId, pluginName: o.pluginName },
      })
      return { letterId: letter.id, outcome: 'letter' }
    },
    async reply(letterId: string, input: { markdown?: string; html?: string; text?: string; items?: import('../../../packages/plugin-api/src/inbox-items.js').InboxLetterItem[] }): Promise<void> {
      const { agentReply } = await import('../human-inbox/store.js')
      // A thread turn always carries plain text (that is what the thread renders), so a rich
      // reply that omitted it would be refused by the store. Derived rather than rejected.
      const text = input.text?.trim() || (input.markdown ?? input.html ?? '').trim()
      // The turn's writer is the plugin's own stamp, as its letters carry: it ran in this server process.
      await agentReply(letterId, {
        text,
        ...(input.items !== undefined ? { items: input.items } : {}),
        ...(input.markdown !== undefined ? { markdown: input.markdown } : {}),
        ...(input.html !== undefined ? { html: input.html } : {}),
      }, { sender: { sessionId: 'external', host: 'local', pluginId } })
    },
    async withdraw(letterId: string, input: { note: string }): Promise<void> {
      const { withdrawLetterAndAnnounce } = await import('../human-inbox/letter-ops.js')
      await withdrawLetterAndAnnounce(letterId, input)
    },
    async get(letterId: string): Promise<{
      letterId: string
      subject: string
      actions: Array<{ id: string; label: string; description?: string }>
      answered?: { actionId: string; label: string; freeText?: string; at: number }
    } | null> {
      const { getLetter } = await import('../human-inbox/store.js')
      // `inlineMaxBytes: 0` keeps a 100MB media body off this path: the caller asked about the
      // letter's STATE, and reading the document to answer that would be the expensive bug.
      // A follower's letters are the Mac's copy, as its inbox list shows them (the box's own
      // changes on top), never the folder git sync wrote beside it (human-inbox/replica-state.ts).
      const letter = isFollower()
        ? await (await import('../human-inbox/replica-state.js')).mirrorRecord(letterId)
        : await getLetter(letterId, { inlineMaxBytes: 0 })
      if (!letter) return null
      return {
        letterId: letter.id,
        subject: letter.subject,
        actions: (letter.actions ?? []).map((one) => ({ ...one })),
        ...(letter.answered ? { answered: { ...letter.answered } } : {}),
      }
    },
    onAnswered(handler: (event: HumanInboxAnsweredEvent) => void | Promise<void>) {
      o.assertLive('letters.onAnswered')
      const subscriber = o.subscriber()
      bus.subscribe(subscriber, async (event) => {
        const payload = event.data as HumanInboxAnsweredEvent | undefined
        // ONLY this plugin's own letters. Without the filter a plugin would be handed every
        // session's approval and every other plugin's, and an approval ledger keyed on a
        // letter id it never issued is a bug waiting for a collision.
        if (!payload?.letterId || payload.pluginId !== pluginId) return
        try { await handler(payload) }
        catch (error) {
          o.logger.error('Plugin letter answer handler failed', {
            letterId: payload.letterId,
            error: error instanceof Error ? error.message : String(error),
          })
          await o.notifyError(`Letter answer handler failed for ${payload.letterId}`, error)
        }
      }, { global: true, interest: ['human-inbox:answered'] })
      return o.own(toDisposable(() => bus.unsubscribe(subscriber)))
    },
  }
}
