/**
 * Session-chat route — bridges WebSocket RPC to the event bus for
 * Claude Code session lifecycle (start, send, queue management).
 *
 * Thin layer: validates payload and emits to the bus or calls queue functions.
 * SessionRunner (subscribed to the bus) handles the actual session management.
 */

import crypto from 'node:crypto'
import { registerMethod } from '../ws/handler.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { getSessionByClaudeId, updateSessionRecord } from '../../core/session-tracker.js'
import { enqueueMessage, editMessage, deleteMessage, getQueue } from '../../core/session-message-queue.js'
import { sessionStreamBuffer } from '../session-stream-buffer.js'
import { saveImageToDisk } from './images.js'
import { transferImagesForRemoteSession } from '../../providers/session-io.js'
import type { SshTarget } from '../../providers/session-io.js'
import { log } from '../../logging/index.js'

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_SESSION_IMAGES = 5
const MAX_IMAGE_BASE64_LENGTH = 14_000_000 // ~10MB binary

/**
 * Register session-chat RPC methods on the WebSocket handler.
 */
export function registerSessionChatRpc(): void {
  registerMethod('session:start', async (payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('session:start requires an object payload')
    }
    const data = payload as Record<string, unknown>

    if (typeof data.message !== 'string') {
      throw new Error('session:start requires message (string)')
    }

    log.web.info('session start via RPC', { taskId: data.taskId, host: data.host, cwd: data.cwd, mode: data.mode })
    bus.emit(EventNames.SESSION_START, {
      taskId: typeof data.taskId === 'string' ? data.taskId : '',
      message: data.message,
      cwd: typeof data.cwd === 'string' ? data.cwd : undefined,
      project: typeof data.project === 'string' ? data.project : undefined,
      mode: typeof data.mode === 'string' ? data.mode : undefined,
      model: typeof data.model === 'string' ? data.model : undefined,
      host: typeof data.host === 'string' ? data.host : undefined,
    }, ['session-runner'], { source: 'web-ui' })
  })

  registerMethod('session:send', async (payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('session:send requires an object payload')
    }
    const data = payload as Record<string, unknown>

    if (typeof data.sessionId !== 'string' || typeof data.message !== 'string') {
      throw new Error('session:send requires sessionId (string) and message (string)')
    }

    // Process images: save to disk and embed file paths in the message
    let augmentedMessage = data.message as string

    if (Array.isArray(data.images) && data.images.length > 0) {
      const validImages = (data.images as Array<{ data?: unknown; mediaType?: unknown }>)
        .filter(img =>
          typeof img.data === 'string'
          && typeof img.mediaType === 'string'
          && ALLOWED_MIME.has(img.mediaType)
          && (img.data as string).length <= MAX_IMAGE_BASE64_LENGTH
        )
        .slice(0, MAX_SESSION_IMAGES)

      if (validImages.length > 0) {
        const savedPaths: string[] = []
        for (const img of validImages) {
          try {
            const { filePath } = await saveImageToDisk(img.data as string, img.mediaType as string)
            savedPaths.push(filePath)
          } catch (err) {
            log.web.warn('Failed to save session image', { error: (err as Error).message })
          }
        }

        if (savedPaths.length > 0) {
          const pathList = savedPaths.map(p => `- ${p}`).join('\n')
          augmentedMessage = `[Images attached — use the Read tool to view them]\n${pathList}\n\n${data.message}`
        }
      }
    }

    // Check if this is an embedded session — route to SubagentRunner instead of CLI queue
    const record = await getSessionByClaudeId(data.sessionId)

    // For remote sessions: transfer locally-saved images to the remote host via SCP
    // and rewrite paths so the remote Claude can Read them.
    if (record?.host && augmentedMessage !== data.message) {
      try {
        const { getConfig } = await import('../../core/config-manager.js')
        const config = await getConfig()
        const hostDef = config.hosts?.[record.host]
        const hostname = hostDef?.hostname ?? (hostDef as Record<string, unknown> | undefined)?.ssh as string | undefined
        if (hostname) {
          const sshTarget: SshTarget = { hostname, user: hostDef?.user, port: hostDef?.port }
          const remoteDir = `/tmp/walnut-images/${crypto.randomBytes(8).toString('hex')}`
          augmentedMessage = await transferImagesForRemoteSession(augmentedMessage, sshTarget, remoteDir)
        }
      } catch (err) {
        log.web.warn('session:send image transfer to remote failed — sending with local paths', {
          sessionId: data.sessionId, host: record.host,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (record?.provider === 'embedded') {
      const messageId = `emb-${Date.now()}`

      bus.emit(EventNames.SUBAGENT_SEND, {
        runId: data.sessionId,
        message: augmentedMessage,
      }, ['subagent-runner'], { source: 'web-ui' })

      // Notify main-ai (which forwards to web-ui) that the message was queued
      bus.emit(EventNames.SESSION_MESSAGE_QUEUED, {
        sessionId: data.sessionId,
        messageId,
        message: data.message as string,
        source: 'ui',
      }, ['main-ai'], { source: 'web-ui' })

      return { messageId }
    }

    // Validate and normalize model value (allowlist check)
    const ALLOWED_MODELS = new Set(['opus', 'opus-1m', 'sonnet', 'sonnet-1m', 'haiku'])
    const model = typeof data.model === 'string' && ALLOWED_MODELS.has(data.model) ? data.model : undefined

    // Save pendingModel/pendingMode to the session record BEFORE enqueuing the message.
    // This prevents a race where processNext (triggered by a prior turn's result handler)
    // dequeues the message before handleSend has a chance to save the pending model.
    if (model || typeof data.mode === 'string') {
      const pendingUpdates: Record<string, unknown> = {}
      if (model) pendingUpdates.pendingModel = model
      if (typeof data.mode === 'string') pendingUpdates.pendingMode = data.mode
      await updateSessionRecord(data.sessionId, pendingUpdates)
      log.web.info('session:send RPC saved pending model/mode', { sessionId: data.sessionId, model, mode: data.mode })
    }

    // Enqueue the (potentially augmented) message — this is the source of truth.
    // The bus event below is just a wake-up signal; SessionRunner reads from the queue.
    log.web.info('session message via RPC', { sessionId: data.sessionId, taskId: record?.taskId, messageLength: augmentedMessage.length })
    const msg = await enqueueMessage(data.sessionId, augmentedMessage)

    bus.emit(EventNames.SESSION_SEND, {
      sessionId: data.sessionId,
      taskId: record?.taskId,
      message: data.message as string,
      mode: typeof data.mode === 'string' ? data.mode : undefined,
      model,
      interrupt: data.interrupt === true ? true : undefined,
    }, ['session-runner'], { source: 'web-ui' })

    // Notify main-ai (which forwards to web-ui) that a message was queued
    bus.emit(EventNames.SESSION_MESSAGE_QUEUED, {
      sessionId: data.sessionId,
      messageId: msg.id,
      message: data.message as string,
      source: 'ui',
    }, ['main-ai'], { source: 'web-ui' })

    return { messageId: msg.id }
  })

  registerMethod('session:edit-queued', async (payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('session:edit-queued requires an object payload')
    }
    const data = payload as Record<string, unknown>

    if (typeof data.sessionId !== 'string' || typeof data.messageId !== 'string' || typeof data.text !== 'string') {
      throw new Error('session:edit-queued requires sessionId, messageId, and text (all strings)')
    }

    const ok = await editMessage(data.sessionId, data.messageId, data.text)
    if (!ok) throw new Error('Message not editable (already processing or not found)')
    return { ok: true }
  })

  registerMethod('session:delete-queued', async (payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('session:delete-queued requires an object payload')
    }
    const data = payload as Record<string, unknown>

    if (typeof data.sessionId !== 'string' || typeof data.messageId !== 'string') {
      throw new Error('session:delete-queued requires sessionId and messageId (both strings)')
    }

    const ok = await deleteMessage(data.sessionId, data.messageId)
    if (!ok) throw new Error('Message not deletable (already processing or not found)')
    return { ok: true }
  })

  registerMethod('session:get-queue', async (payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('session:get-queue requires an object payload')
    }
    const data = payload as Record<string, unknown>

    if (typeof data.sessionId !== 'string') {
      throw new Error('session:get-queue requires sessionId (string)')
    }

    return { messages: await getQueue(data.sessionId) }
  })

  registerMethod('session:stream-subscribe', (payload: unknown, _ws) => {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('session:stream-subscribe requires an object payload')
    }
    const data = payload as Record<string, unknown>

    if (typeof data.sessionId !== 'string') {
      throw new Error('session:stream-subscribe requires sessionId (string)')
    }

    return sessionStreamBuffer.getSnapshot(data.sessionId)
  })
}
