/**
 * General push notifications: scheduled-job notices, background agent replies,
 * session results and errors, and triage chat updates.
 *
 * Subscribes to the event bus and pushes when:
 * - No WebSocket clients are connected (user not actively viewing)
 * - The event matches a push-worthy condition
 *
 * Delivery goes through core/push/deliver.ts, the same path letters take: each
 * token reaches the service that minted it (APNs for the native app, Expo only
 * for a legacy Expo token). This file used to post every event to Expo for every
 * token, so an iPhone's APNs token and the notification text reached Expo, a
 * third party, on every push.
 *
 * Unwired today: no producer on a running server emits any of these events to
 * this subscriber, so none of the branches below ever sends. Background replies
 * (AGENT_RESPONSE) reach the console over WebSocket only; session results and
 * errors (SESSION_RESULT, SESSION_ERROR) go to the main AI and the session
 * runner; triage chat (CHAT_HISTORY_UPDATED) goes to the web UI; and nothing
 * emits CRON_NOTIFICATION since forensic incidents stopped pushing (they are
 * developer diagnostics, read through /api/incidents). The branches stay so a
 * producer can opt in. Wiring one is a product decision, because it makes the
 * phone buzz for that event. Letters push through core/push/letter-push.ts.
 */

import { bus, eventData, EventNames } from './event-bus.js'
import { CLOUD_MODE } from '../constants.js'
import { getConfig } from './config-manager.js'
import { clientCount } from '../web/ws/handler.js'
import { log } from '../logging/index.js'
import { getQuiet, logQuietSkipOnce, quietSuppresses } from './quiet/quiet-state.js'
import { deliverPush } from './push/deliver.js'

/**
 * Send a push notification if no WebSocket clients are connected.
 */
async function maybePush(title: string, body: string, data?: Record<string, unknown>): Promise<void> {
  // The PRIMARY owns push: it holds the token registry (config.yaml never syncs)
  // and the APNs key, and a replica relays `/api/push/*` to it (core/push/relay.ts).
  // A cloud box's own `push_tokens` rows are therefore not its to send from —
  // any it still carries are orphans from before that relay existed.
  if (CLOUD_MODE) return
  // Quiet mode (do not disturb): none of these pushes is a permission ask, so a
  // live hold silences all of them. Logged once per hold, not per event.
  const quiet = await getQuiet()
  if (quietSuppresses(quiet)) {
    logQuietSkipOnce('push', quiet)
    return
  }
  // Skip if there are active WebSocket clients (user is viewing)
  if (clientCount() > 0) {
    log.web.debug('push: skipped (WS clients connected)', { title, clients: clientCount() })
    return
  }

  const tokens = (await getConfig()).push_tokens ?? []
  if (tokens.length === 0) return

  const out = await deliverPush(tokens, { title, body, ...(data ? { data } : {}) })
  log.web.info('push: delivery', {
    title, apns: out.apns, expo: out.expo, sent: out.sent, failed: out.failed,
    ...(out.reason ? { reason: out.reason } : {}),
    ...(out.unpaired > 0 ? { unpairedSkipped: out.unpaired } : {}),
  })
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
          // The user stopped this turn from the composer — they are looking at it.
          if (data.interrupted) break
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

        // HUMAN_INBOX_LETTER is deliberately NOT handled here. Letters are
        // addressed TO the human, so `maybePush`'s "any browser WS is open"
        // gate was wrong for them: a Mac console tab left open suppressed every
        // letter push, which is why letters never reached the phone. They now go
        // through core/push/letter-push.ts, which decides per DEVICE from that
        // device's own foreground state and the user's chosen mode. Adding a
        // case back here would double every letter banner.

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
