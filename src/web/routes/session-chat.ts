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
import { sessionRunner } from '../../providers/claude-code-session.js'
import { readTeamConfig, findTeammateJsonlPaths, writeToInbox, extractTeamsFromLeadJsonl, findSubagentJsonlByPrompt, getLeadSessionJsonlPath, findAllSubagentJsonlsForAgent } from '../../core/team-reader.js'
import { ActiveTabPoller, readFullFile, parseJsonlLines } from '../../providers/subagent-poller.js'
import { broadcastEvent } from '../ws/handler.js'

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
          const remoteDir = `/tmp/open-walnut-images/${crypto.randomBytes(8).toString('hex')}`
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

  // ── Team RPCs ──

  registerMethod('session:team-info', async (payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('session:team-info requires an object payload')
    }
    const data = payload as Record<string, unknown>
    if (typeof data.sessionId !== 'string') {
      throw new Error('session:team-info requires sessionId (string)')
    }
    const sessionId = data.sessionId
    const teamName = typeof data.teamName === 'string' ? data.teamName : undefined

    if (!teamName) {
      return { teamName: null, members: [] }
    }

    // Try reading team config from disk first
    const config = readTeamConfig(teamName)
    if (config) {
      const members = config.members.map(m => ({
        name: m.name,
        agentType: m.agentType,
        model: m.model,
        isLead: m.agentId === config.leadAgentId,
        backendType: m.backendType,
      }))
      return { teamName, members }
    }

    // Fallback: config deleted by TeamDelete — extract from lead session JSONL
    const record = await getSessionByClaudeId(sessionId)
    if (!record?.cwd) {
      return { teamName, members: [] }
    }

    const leadJsonlPath = getLeadSessionJsonlPath(sessionId, record.cwd)
    const teams = extractTeamsFromLeadJsonl(leadJsonlPath)
    const agents = teams.get(teamName)

    if (!agents || agents.length === 0) {
      return { teamName, members: [] }
    }

    const members = agents.map(a => ({
      name: a.name,
      agentType: a.agentType,
      model: a.model,
      isLead: false,
      backendType: undefined,
    }))

    log.web.info('team-info fallback: extracted from lead JSONL', { teamName, memberCount: members.length })
    return { teamName, members }
  })

  registerMethod('session:team-agent-subscribe', async (payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('session:team-agent-subscribe requires an object payload')
    }
    const data = payload as Record<string, unknown>

    if (typeof data.sessionId !== 'string' || typeof data.agentName !== 'string' || typeof data.teamName !== 'string') {
      throw new Error('session:team-agent-subscribe requires sessionId, agentName, teamName (all strings)')
    }
    const sessionId = data.sessionId
    const agentName = data.agentName
    const teamName = data.teamName

    // Get session record for cwd
    const record = await getSessionByClaudeId(sessionId)
    const cwd = record?.cwd

    let jsonlPath: string | null = null

    // Try 1: Read team config from disk and find JSONL via config-based matching
    const config = readTeamConfig(teamName)
    if (config && cwd) {
      const jsonlPaths = findTeammateJsonlPaths(config, sessionId, cwd)
      jsonlPath = jsonlPaths.get(agentName) ?? null
    }

    // Try 2: Config deleted by TeamDelete — extract prompts from lead JSONL and match
    if (!jsonlPath && cwd) {
      const leadJsonlPath = getLeadSessionJsonlPath(sessionId, cwd)
      const teams = extractTeamsFromLeadJsonl(leadJsonlPath)
      const agents = teams.get(teamName)
      const agent = agents?.find(a => a.name === agentName)

      if (agent?.fullPrompt) {
        jsonlPath = findSubagentJsonlByPrompt(sessionId, cwd, agent.fullPrompt)
        if (jsonlPath) {
          log.web.info('team-agent-subscribe fallback: found JSONL via prompt matching', {
            teamName, agentName, path: jsonlPath.slice(-60),
          })
        }
      }
    }

    if (!jsonlPath) {
      return { events: [], error: 'JSONL file not found for agent' }
    }

    // Find ALL JSONL files for this agent (main conversation + inbox responses + shutdown).
    // cwd is guaranteed non-null here (both Try 1 and Try 2 require it to set jsonlPath).
    const allJsonlPaths = findAllSubagentJsonlsForAgent(sessionId, cwd!, agentName, jsonlPath)

    // Read and merge events from all files chronologically (file-level ordering)
    const allEvents: ReturnType<typeof parseJsonlLines> = [];
    for (const p of allJsonlPaths) {
      const { lines } = readFullFile(p);
      const parsed = parseJsonlLines(lines);
      allEvents.push(...parsed);
    }

    log.web.debug('team-agent-subscribe: loaded JSONL files', {
      agentName, fileCount: allJsonlPaths.length, eventCount: allEvents.length,
    })

    // Start multi-file polling for this agent
    const session = sessionRunner.findByClaudeId(sessionId)
    if (session) {
      startTeamAgentPolling(sessionId, agentName, {
        allPaths: allJsonlPaths,
        mainJsonlPath: jsonlPath,
        cwd: cwd!,
        remote: !!record?.host,
      })
    }

    return { events: allEvents }
  })

  registerMethod('session:team-agent-unsubscribe', async (payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('session:team-agent-unsubscribe requires an object payload')
    }
    const data = payload as Record<string, unknown>

    if (typeof data.sessionId !== 'string') {
      throw new Error('session:team-agent-unsubscribe requires sessionId (string)')
    }

    stopTeamAgentPolling(data.sessionId)
    return { ok: true }
  })

  registerMethod('session:team-send', async (payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('session:team-send requires an object payload')
    }
    const data = payload as Record<string, unknown>

    if (typeof data.teamName !== 'string' || typeof data.agentName !== 'string' || typeof data.message !== 'string') {
      throw new Error('session:team-send requires teamName, agentName, message (all strings)')
    }
    const teamName = data.teamName
    const agentName = data.agentName
    const message = data.message

    await writeToInbox(teamName, agentName, message)

    log.web.info('team message sent to inbox', { teamName, agentName, messageLength: message.length })
    return { ok: true }
  })
}

// ── Team Agent Polling Management ──
// One poller per session — tracks which agent tab is active.

const teamPollers = new Map<string, ActiveTabPoller>()

function startTeamAgentPolling(sessionId: string, agentName: string, opts: {
  allPaths: string[];
  mainJsonlPath: string | null;
  cwd: string;
  remote: boolean;
}): void {
  let poller = teamPollers.get(sessionId)
  if (!poller) {
    poller = new ActiveTabPoller((agent, events) => {
      // Broadcast events to frontend
      broadcastEvent('session:team-agent-delta', {
        sessionId,
        agentName: agent,
        events,
      })
    })
    teamPollers.set(sessionId, poller)
  }

  // Subscribe with multi-file tracking and discovery context
  poller.subscribe(agentName, {
    filePaths: opts.allPaths,
    remote: opts.remote,
    discovery: opts.remote ? undefined : {
      sessionId,
      cwd: opts.cwd,
      agentName,
      mainJsonlPath: opts.mainJsonlPath,
    },
  })
}

function stopTeamAgentPolling(sessionId: string): void {
  const poller = teamPollers.get(sessionId)
  if (poller) {
    poller.destroy()
    teamPollers.delete(sessionId)
  }
}

/** Cleanup pollers when session ends. Called from server.ts session:result handler. */
export function cleanupTeamPoller(sessionId: string): void {
  const poller = teamPollers.get(sessionId)
  if (poller) {
    poller.destroy()
    teamPollers.delete(sessionId)
  }
}
