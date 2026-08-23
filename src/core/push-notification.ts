/**
 * Push notification service using Expo Push API.
 *
 * Subscribes to the event bus and sends push notifications when:
 * - No WebSocket clients are connected (user not actively viewing)
 * - The event matches a push-worthy condition
 *
 * Uses expo-server-sdk to send via Expo's push service → APNs/FCM.
 */

import { bus, eventData, EventNames } from './event-bus.js'
import { getConfig } from './config-manager.js'
import { clientCount } from '../web/ws/handler.js'
import { log } from '../logging/index.js'
import type { PushTokenEntry } from './types.js'

// Expo push message format (inline — no need for expo-server-sdk dependency for MVP)
interface ExpoPushMessage {
  to: string
  title: string
  body: string
  data?: Record<string, unknown>
  sound?: 'default' | null
  badge?: number
  priority?: 'default' | 'normal' | 'high'
}

interface ExpoPushTicket {
  status: 'ok' | 'error'
  id?: string
  message?: string
  details?: { error?: string }
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

/**
 * Send push notifications via Expo Push API.
 */
async function sendPushNotifications(messages: ExpoPushMessage[]): Promise<void> {
  if (messages.length === 0) return

  try {
    const resp = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(messages),
    })

    if (!resp.ok) {
      log.web.warn('push: Expo API error', { status: resp.status })
      return
    }

    const result = (await resp.json()) as { data: ExpoPushTicket[] }
    for (const ticket of result.data) {
      if (ticket.status === 'error') {
        log.web.warn('push: ticket error', {
          message: ticket.message,
          error: ticket.details?.error,
        })
        // DeviceNotRegistered → remove the token
        if (ticket.details?.error === 'DeviceNotRegistered') {
          // token cleanup handled by the caller checking tickets
        }
      }
    }
  } catch (err) {
    log.web.error('push: send failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Build push messages for all registered tokens.
 */
async function buildMessages(title: string, body: string, data?: Record<string, unknown>): Promise<ExpoPushMessage[]> {
  const config = await getConfig()
  const tokens = config.push_tokens ?? []

  if (tokens.length === 0) return []

  return tokens.map((t: PushTokenEntry) => ({
    to: t.token,
    title,
    body: body.slice(0, 200), // truncate body
    data,
    sound: 'default' as const,
    priority: 'high' as const,
  }))
}

/**
 * Send a push notification if no WebSocket clients are connected.
 */
async function maybePush(title: string, body: string, data?: Record<string, unknown>): Promise<void> {
  // Skip if there are active WebSocket clients (user is viewing)
  if (clientCount() > 0) {
    log.web.debug('push: skipped (WS clients connected)', { title, clients: clientCount() })
    return
  }

  const messages = await buildMessages(title, body, data)
  if (messages.length === 0) return

  log.web.info('push: sending', { title, tokenCount: messages.length })
  await sendPushNotifications(messages)
}

/**
 * (agentId, conversationId) when this session is a Personal AI chat lane, else null.
 *
 * A lane-bound session answers a Personal AI CHAT turn, so its result/error must read
 * as the Personal AI talking — not as "some session finished". The event payload
 * carries no lane, so it's read off the record (one cheap indexed sqlite read).
 * Failure-safe by design: a record-read throw resolves null, which falls the
 * caller back to the generic session copy rather than dropping the push.
 */
async function laneIdsFor(
  sessionId: string | undefined,
): Promise<{ agentId: string; conversationId: string } | null> {
  if (!sessionId) return null
  try {
    const { getSessionByClaudeId } = await import('./session-tracker.js')
    const { parseLaneKey } = await import('./sessions/personal-ai-lane.js')
    const record = await getSessionByClaudeId(sessionId)
    return parseLaneKey(record?.lane)
  } catch (err) {
    log.web.warn('push: lane lookup failed, using generic copy', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Initialize push notification service — subscribe to event bus.
 */
export function initPushNotifications(): void {
  bus.subscribe('push-notifications', async (event) => {
    try {
      switch (event.name) {
        case EventNames.AGENT_RESPONSE: {
          const data = eventData<typeof EventNames.AGENT_RESPONSE>(event)
          // Only push for non-interactive agent responses (cron, heartbeat, triage)
          const source = data.source
          if (source && ['cron', 'heartbeat', 'triage'].includes(source)) {
            const text = data.text ? data.text.slice(0, 150) : 'New response'
            await maybePush('Walnut', text, { type: 'agent_response', source })
          }
          break
        }

        case EventNames.SESSION_RESULT: {
          const data = eventData<typeof EventNames.SESSION_RESULT>(event)
          const sessionId = data.sessionId
          const lane = await laneIdsFor(sessionId)
          if (lane) {
            // A lane-bound session IS the Personal AI answering a chat turn, not an
            // external coding session — "Session 3f2a1b0c finished" would be
            // meaningless to the user. Push the reply itself, from Walnut.
            await maybePush(
              'Walnut',
              data.result ? data.result.slice(0, 150) : 'New response',
              { type: 'session_result', sessionId, agentId: lane.agentId, conversationId: lane.conversationId }
            )
            break
          }
          await maybePush(
            'Session Complete',
            `Session ${sessionId?.slice(0, 8) ?? ''} finished`,
            { type: 'session_result', sessionId }
          )
          break
        }

        case EventNames.SESSION_ERROR: {
          const data = eventData<typeof EventNames.SESSION_ERROR>(event)
          // delivery_failed fires once per failed send attempt — pushing each one
          // would spam the user's devices during an SSH outage. The in-app chat
          // notification (deduped) covers it.
          if (data.errorKind === 'delivery_failed') break
          const error = data.error
          const lane = await laneIdsFor(data.sessionId)
          if (lane) {
            await maybePush(
              'Walnut',
              `The main AI hit an error: ${error?.slice(0, 150) ?? 'unknown error'}`,
              { type: 'session_error', sessionId: data.sessionId, agentId: lane.agentId, conversationId: lane.conversationId }
            )
            break
          }
          await maybePush(
            'Session Error',
            error?.slice(0, 150) ?? 'A session encountered an error',
            { type: 'session_error' }
          )
          break
        }

        case EventNames.CRON_NOTIFICATION: {
          const data = eventData<typeof EventNames.CRON_NOTIFICATION>(event)
          const d = data as Record<string, unknown>
          const jobName = d.jobName as string | undefined ?? 'Job'
          const text = d.text as string | undefined ?? 'Completed'
          await maybePush(`Scheduled: ${jobName}`, text.slice(0, 150), { type: 'cron' })
          break
        }

        case EventNames.HUMAN_INBOX_LETTER: {
          const data = eventData<typeof EventNames.HUMAN_INBOX_LETTER>(event)
          // Envelope only: `textPreview` is the letter's short plain-text preview
          // (<= 300 chars, capped at write time), never the document body — the
          // body stays behind GET /api/v1/human-inbox/:id.
          const prefix = data.kind === 'reply' ? 'Reply: ' : 'New letter: '
          // Subjects are capped at 200 in the store; a lock-screen title has room
          // for far less, so trim it here rather than letting the OS elide it.
          const title = `${prefix}${data.subject}`.slice(0, 100)
          await maybePush(title, data.textPreview || 'Open Walnut to read it', {
            type: 'human_inbox_letter',
            letterId: data.letterId,
            letterType: data.type,
            kind: data.kind,
          })
          break
        }

        case EventNames.CHAT_HISTORY_UPDATED: {
          const data = eventData<typeof EventNames.CHAT_HISTORY_UPDATED>(event)
          // source lives on the entry, not the top-level payload — reading the
          // top-level d.source (always undefined) meant triage pushes never fired.
          if (data.entry?.source === 'triage') {
            const text = data.entry.content || 'The agent finished — open the task to read it'
            await maybePush('Unread task update', text.slice(0, 150), { type: 'triage' })
          }
          break
        }
      }
    } catch (err) {
      log.web.error('push: event handler error', {
        event: event.name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  log.web.info('push notification service initialized')
}
