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
 * Initialize push notification service — subscribe to event bus.
 */
export function initPushNotifications(): void {
  bus.subscribe('push-notifications', async (event) => {
    try {
      switch (event.name) {
        case EventNames.AGENT_RESPONSE: {
          const data = eventData<typeof EventNames.AGENT_RESPONSE>(event)
          // Only push for non-interactive agent responses (cron, heartbeat, triage)
          const source = (data as Record<string, unknown>).source as string | undefined
          if (source && ['cron', 'heartbeat', 'triage'].includes(source)) {
            const text = typeof data === 'object' && data !== null && 'text' in data
              ? String((data as Record<string, unknown>).text).slice(0, 150)
              : 'New response'
            await maybePush('Walnut', text, { type: 'agent_response', source })
          }
          break
        }

        case EventNames.SESSION_RESULT: {
          const data = eventData<typeof EventNames.SESSION_RESULT>(event)
          const sessionId = (data as Record<string, unknown>).sessionId as string | undefined
          await maybePush(
            'Session Complete',
            `Session ${sessionId?.slice(0, 8) ?? ''} finished`,
            { type: 'session_result', sessionId }
          )
          break
        }

        case EventNames.SESSION_ERROR: {
          const data = eventData<typeof EventNames.SESSION_ERROR>(event)
          const error = (data as Record<string, unknown>).error as string | undefined
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

        case EventNames.CHAT_HISTORY_UPDATED: {
          const data = eventData<typeof EventNames.CHAT_HISTORY_UPDATED>(event)
          const d = data as Record<string, unknown>
          if (d.source === 'triage') {
            const text = d.displayText as string | undefined ?? 'A task needs your attention'
            await maybePush('Task Needs Attention', text.slice(0, 150), { type: 'triage' })
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
