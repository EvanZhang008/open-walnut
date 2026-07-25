/**
 * Session-chat route — bridges WebSocket RPC to the event bus for
 * Claude Code session lifecycle (start, send, queue management).
 *
 * Thin layer: validates payload and emits to the bus or calls queue functions.
 * SessionRunner (subscribed to the bus) handles the actual session management.
 */

import { registerMethod } from '../ws/handler.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { VALID_SESSION_EFFORT_IDS, resolveModelSwitchValue } from '../../core/types.js'
import type { SessionEffort, SessionMode } from '../../core/types.js'
import { getSessionByClaudeId, updateSessionRecord } from '../../core/session-tracker.js'
import { sendMessageToSession, editMessage, deleteMessage, getQueue } from '../../core/session-message-queue.js'
import { sessionStreamBuffer } from '../session-stream-buffer.js'
import { saveImageToDisk } from './images.js'
import { log } from '../../logging/index.js'
import { sessionRunner } from '../../providers/claude-code-session.js'
import { readTeamConfig, findTeammateJsonlPaths, writeToInbox, extractTeamsFromLeadJsonl, findSubagentJsonlByPrompt, getLeadSessionJsonlPath, findAllSubagentJsonlsForAgent, readTeamConfigRemote, extractTeamsFromLeadJsonlRemote, readRemoteSubagentJsonls } from '../../core/team-reader.js'
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
      effort: typeof data.effort === 'string' && VALID_SESSION_EFFORT_IDS.has(data.effort)
        ? (data.effort as SessionEffort) : undefined,
      host: typeof data.host === 'string' ? data.host : undefined,
      engine: data.engine === 'codex' ? 'codex' : undefined,
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

    // Remote image transfer: RemoteSessionManager.prepareOutbound() uploads local images
    // and rewrites paths inside start() and writeMessage(). No manual transfer needed here.

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

    // Validate the model: a legacy picker alias (mapped through
    // SESSION_MODEL_CLI_MAP) or a catalog value from GET /:id/models (passed
    // through verbatim — the CLI is the authority). Shared validator with the
    // HTTP /model route; invalid values silently drop (RPC semantics, no 400).
    const cliModelResolved = typeof data.model === 'string' ? resolveModelSwitchValue(data.model) : null
    const model = cliModelResolved !== null ? (data.model as string) : undefined
    // NOTE: reasoning-effort is NOT changed here. Mid-session effort switches go
    // through POST /api/sessions/:id/effort → applyEffort() (apply_flag_settings
    // control_request, no respawn).

    // Model switch: SAME live mechanism as the /model route — apply_flag_settings
    // control_request (no respawn, running turn untouched) + persisted cliModel for
    // cold resume.
    if (model && cliModelResolved) {
      const cliModel = cliModelResolved
      await updateSessionRecord(data.sessionId, { cliModel })
      log.web.info('session:send RPC model switch (live apply)', { sessionId: data.sessionId, model, cliModel })
      const live = await sessionRunner.getOrAttachLiveSession(data.sessionId as string).catch(() => undefined)
      if (live) {
        live.applyModel(cliModel)
          .then(() => live.refreshAppliedSettings('model-change'))
          .catch((err) => log.web.warn('session:send live model apply failed — persisted for next spawn', {
            sessionId: data.sessionId, cliModel, error: err instanceof Error ? err.message : String(err),
          }))
      }
    }
    // Mode switch: confirm against a live CLI before persistence. A stopped
    // session stores the requested mode for its next cold resume.
    if (typeof data.mode === 'string') {
      const nextMode = data.mode as SessionMode
      const application = await sessionRunner.changePermissionMode(data.sessionId, nextMode)
      await updateSessionRecord(data.sessionId, { mode: nextMode })
      log.web.info('session:send RPC mode switch confirmed', {
        sessionId: data.sessionId, mode: nextMode, application,
      })
    }

    // Pure model switch (no message text): the live apply above did all the work —
    // nothing to enqueue, no turn to trigger. (The old path needed an empty-message
    // send to force a respawn; the new one doesn't respawn at all.)
    if (model && !(data.message as string).trim()) {
      return { messageId: `model-switch-${Date.now()}` }
    }

    // User-initiated send to a remote session = a deliberate retry. Forget any
    // cached connection failure (e.g. after the user ran mwinit) so processNext
    // reconnects fresh instead of fast-failing against the 60s failure cache.
    if (record?.host) {
      const { clearDaemonFailureCache } = await import('../../providers/daemon-connection.js')
      clearDaemonFailureCache(record.host)
    }

    // Enqueue and notify in one call. augmentedMessage may include image refs;
    // original data.message is used for bus events (UI display).
    // NOTE: model is NOT forwarded — it was already applied live above (and
    // persisted as cliModel for cold resume); SESSION_SEND carries no model field.
    log.web.info('session message via RPC', { sessionId: data.sessionId, taskId: record?.taskId, messageLength: augmentedMessage.length })
    const msg = await sendMessageToSession(data.sessionId, data.message as string, {
      source: 'ui',
      taskId: record?.taskId,
      mode: typeof data.mode === 'string' ? data.mode : undefined,
      interrupt: data.interrupt === true ? true : undefined,
      enqueueMessage: augmentedMessage,
    })

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

  registerMethod('session:stream-subscribe', async (payload: unknown, _ws) => {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('session:stream-subscribe requires an object payload')
    }
    const data = payload as Record<string, unknown>

    if (typeof data.sessionId !== 'string') {
      throw new Error('session:stream-subscribe requires sessionId (string)')
    }

    // READ-ONLY path. Must NOT mutate sessionStreamBuffer.
    //
    // Prior versions called markDone() here as "defensive cleanup" when the DB
    // record was terminal, to guard against stale isStreaming after server
    // restart. That write-side defense raced with the markStreaming triggered by
    // a fresh session:status-changed{running} during resume: the frontend
    // re-subscribes on every status change, and the RPC was reading a session
    // record that hadn't yet caught up to the new turn — clearing the just-
    // marked-streaming buffer within ~20ms and stalling the UI until refresh.
    //
    // Fix: do read-time correction only. If DB says terminal but buffer still
    // claims streaming, surface isStreaming=false to this caller WITHOUT
    // touching the shared buffer. The authoritative markDone is driven by
    // session:status-changed / session:result handlers in server.ts.
    const sid = data.sessionId
    const STALE_RUNNING_MS = 5 * 60 * 1000
    const snapshot = sessionStreamBuffer.getSnapshot(sid)
    let correctedIsStreaming = snapshot.isStreaming
    try {
      const record = await getSessionByClaudeId(sid)
      // Idle is the authoritative between-turn state, so a buffer that still
      // claims streaming is stale just like one paired with a terminal record.
      if (record && (record.process_status === 'idle' || record.process_status === 'stopped' || record.process_status === 'error')) {
        correctedIsStreaming = false
      } else if (record && record.process_status === 'running') {
        const lastChangeMs = record.last_status_change
          ? Date.parse(record.last_status_change)
          : 0
        if (lastChangeMs > 0 && Date.now() - lastChangeMs > STALE_RUNNING_MS) {
          log.web.warn('stale running on subscribe (read-only, no buffer mutation)', {
            sessionId: sid,
            staleMs: Date.now() - lastChangeMs,
          })
          correctedIsStreaming = false
        }
      }
    } catch (err) {
      // Non-fatal: if the DB lookup fails (e.g. transient storage error),
      // return the uncorrected buffer snapshot. Logged at debug to aid
      // troubleshooting without flooding warn-level output.
      log.web.debug('session:stream-subscribe db lookup failed (non-fatal)', {
        sessionId: sid,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    return { ...snapshot, isStreaming: correctedIsStreaming }
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

    const record = await getSessionByClaudeId(sessionId)
    const isRemote = !!record?.host

    // ── Remote session: read team config/JSONL from remote host ──
    if (isRemote && record.host) {
      // Read config and JSONL in parallel, then merge (same race condition fix as local)
      const [remoteConfig, remoteTeams] = await Promise.all([
        readTeamConfigRemote(teamName, record.host).catch(() => null),
        extractTeamsFromLeadJsonlRemote(sessionId, record.host).catch(() => new Map<string, import('../../core/team-reader.js').ExtractedTeamAgent[]>()),
      ])
      const remoteJsonlAgents = remoteTeams.get(teamName)

      if (remoteConfig) {
        const membersByName = new Map(remoteConfig.members.map(m => [m.name, {
          name: m.name,
          agentType: m.agentType,
          model: m.model,
          isLead: m.agentId === remoteConfig.leadAgentId,
          backendType: m.backendType,
        }]))

        // Merge JSONL agents missing from config
        if (remoteJsonlAgents) {
          for (const agent of remoteJsonlAgents) {
            if (!membersByName.has(agent.name)) {
              membersByName.set(agent.name, {
                name: agent.name,
                agentType: agent.agentType,
                model: agent.model,
                isLead: false,
                backendType: undefined,
              })
            }
          }
        }

        return { teamName, members: Array.from(membersByName.values()) }
      }

      // Fallback: config deleted — use JSONL-only extraction
      if (remoteJsonlAgents && remoteJsonlAgents.length > 0) {
        const members = remoteJsonlAgents.map(a => ({
          name: a.name,
          agentType: a.agentType,
          model: a.model,
          isLead: false,
          backendType: undefined,
        }))
        log.web.info('team-info remote fallback: extracted from lead JSONL', { teamName, host: record.host, memberCount: members.length })
        return { teamName, members }
      }

      return { teamName, members: [] }
    }

    // ── Local session: read from local filesystem ──

    // Read team config from disk (may be incomplete due to Claude Code race condition
    // when multiple agents are dispatched in parallel — concurrent read-modify-write
    // to config.json can lose earlier writes).
    const config = readTeamConfig(teamName)

    // Also extract agents from lead session JSONL — this is the authoritative source
    // because each Agent tool_use is recorded in the JSONL regardless of config races.
    let jsonlAgents: Map<string, { name: string; agentType: string; model: string }> | undefined
    if (record?.cwd) {
      const leadJsonlPath = getLeadSessionJsonlPath(sessionId, record.cwd)
      const teams = extractTeamsFromLeadJsonl(leadJsonlPath)
      const agents = teams.get(teamName)
      if (agents && agents.length > 0) {
        jsonlAgents = new Map(agents.map(a => [a.name, a]))
      }
    }

    if (config) {
      // Start with config members
      const membersByName = new Map(config.members.map(m => [m.name, {
        name: m.name,
        agentType: m.agentType,
        model: m.model,
        isLead: m.agentId === config.leadAgentId,
        backendType: m.backendType,
      }]))

      // Merge any agents found in JSONL but missing from config (race condition fix)
      if (jsonlAgents) {
        for (const [name, agent] of jsonlAgents) {
          if (!membersByName.has(name)) {
            membersByName.set(name, {
              name: agent.name,
              agentType: agent.agentType,
              model: agent.model,
              isLead: false,
              backendType: undefined,
            })
          }
        }
        if (membersByName.size > config.members.length) {
          log.web.info('team-info: merged JSONL agents missing from config (race condition)', {
            teamName, configCount: config.members.length, mergedCount: membersByName.size,
          })
        }
      }

      return { teamName, members: Array.from(membersByName.values()) }
    }

    // Fallback: config deleted by TeamDelete — use JSONL-only extraction
    if (jsonlAgents && jsonlAgents.size > 0) {
      const members = Array.from(jsonlAgents.values()).map(a => ({
        name: a.name,
        agentType: a.agentType,
        model: a.model,
        isLead: false,
        backendType: undefined,
      }))
      log.web.info('team-info fallback: extracted from lead JSONL', { teamName, memberCount: members.length })
      return { teamName, members }
    }

    return { teamName, members: [] }
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

    // Get session record for cwd and host
    const record = await getSessionByClaudeId(sessionId)
    const cwd = record?.cwd
    const isRemote = !!record?.host

    // ── Remote session: read subagent files via DaemonFileReader ──
    if (isRemote && record.host && cwd) {
      // Get team info (for prompt matching)
      let fullPrompt: string | undefined
      const remoteConfig = await readTeamConfigRemote(teamName, record.host)
      if (!remoteConfig) {
        // Config deleted — extract from lead JSONL
        const teams = await extractTeamsFromLeadJsonlRemote(sessionId, record.host)
        const agents = teams.get(teamName)
        const agent = agents?.find(a => a.name === agentName)
        fullPrompt = agent?.fullPrompt
      }

      // Read all subagent files from remote and match
      const { matched, all } = await readRemoteSubagentJsonls(
        sessionId, record.host, cwd, agentName, fullPrompt,
      )

      if (matched.size === 0) {
        log.web.info('team-agent-subscribe remote: no matched files', {
          agentName, host: record.host, totalFiles: all.size,
        })
        return { events: [], error: 'JSONL file not found for agent on remote host' }
      }

      // Parse all matched files into events
      const allEvents: ReturnType<typeof parseJsonlLines> = []
      for (const [filename, content] of matched) {
        const lines = content.split('\n').filter(Boolean)
        const parsed = parseJsonlLines(lines)
        allEvents.push(...parsed)
      }

      log.web.info('team-agent-subscribe remote: loaded', {
        agentName, host: record.host, matchedFiles: matched.size, eventCount: allEvents.length,
      })

      // Start remote polling for this agent
      startRemoteTeamAgentPolling(sessionId, agentName, {
        host: record.host,
        cwd,
        fullPrompt,
        lastEventCount: allEvents.length,
      })

      return { events: allEvents }
    }

    // ── Local session: read from local filesystem ──

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
    discovery: {
      sessionId,
      cwd: opts.cwd,
      agentName,
      mainJsonlPath: opts.mainJsonlPath,
    },
  })
}

function stopTeamAgentPolling(sessionId: string): void {
  // Same teardown as session end — unsubscribe must also drop remotePollerState
  // (it holds host/cwd/fullPrompt per session and would otherwise leak).
  cleanupTeamPoller(sessionId)
}

/** Cleanup pollers when session ends. Called from server.ts session:result handler. */
export function cleanupTeamPoller(sessionId: string): void {
  const poller = teamPollers.get(sessionId)
  if (poller) {
    poller.destroy()
    teamPollers.delete(sessionId)
  }
  const remoteTimer = remotePollers.get(sessionId)
  if (remoteTimer) {
    clearInterval(remoteTimer)
    remotePollers.delete(sessionId)
  }
  remotePollerState.delete(sessionId)
}

// ── Remote Team Agent Polling ──
// For remote sessions, periodically re-read subagent files via DaemonFileReader
// and push new events to the frontend.

const REMOTE_POLL_MS = 5000  // 5s interval for remote (more expensive than local)
const remotePollers = new Map<string, ReturnType<typeof setInterval>>()
/** Tracks event count per agent for diffing */
const remotePollerState = new Map<string, { agentName: string; lastEventCount: number; host: string; cwd: string; fullPrompt?: string }>()

function startRemoteTeamAgentPolling(sessionId: string, agentName: string, opts: {
  host: string;
  cwd: string;
  fullPrompt?: string;
  lastEventCount: number;
}): void {
  // Clear existing timer if switching agents
  const existing = remotePollers.get(sessionId)
  if (existing) clearInterval(existing)

  remotePollerState.set(sessionId, {
    agentName,
    lastEventCount: opts.lastEventCount,
    host: opts.host,
    cwd: opts.cwd,
    fullPrompt: opts.fullPrompt,
  })

  const timer = setInterval(async () => {
    const state = remotePollerState.get(sessionId)
    if (!state) return

    try {
      const { matched } = await readRemoteSubagentJsonls(
        sessionId, state.host, state.cwd, state.agentName, state.fullPrompt,
      )

      if (matched.size === 0) return

      // Parse all matched content
      const allEvents: ReturnType<typeof parseJsonlLines> = []
      for (const [, content] of matched) {
        const lines = content.split('\n').filter(Boolean)
        allEvents.push(...parseJsonlLines(lines))
      }

      // Only send delta (new events since last poll)
      if (allEvents.length > state.lastEventCount) {
        const newEvents = allEvents.slice(state.lastEventCount)
        state.lastEventCount = allEvents.length

        broadcastEvent('session:team-agent-delta', {
          sessionId,
          agentName: state.agentName,
          events: newEvents,
        })
      }
    } catch (err) {
      log.web.debug('remote team poll failed', {
        sessionId, agentName: state.agentName,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, REMOTE_POLL_MS)

  remotePollers.set(sessionId, timer)

  log.web.info('remote team agent polling started', {
    sessionId, agentName, host: opts.host, intervalMs: REMOTE_POLL_MS,
  })
}
