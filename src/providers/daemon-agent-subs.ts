/**
 * A team's agents on this host: subscribing a socket to an agent's own transcripts (polled, the
 * lines pushed as `agent` events), and writing to a team member's inbox.
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), at the place this code
 * had in its body; its dispatcher answers subscribe-agent / unsubscribe-agent / write-inbox
 * through what it returns, and its socket close and cleanup end the subscriptions (agentSubs).
 * The code is the runtime's as it was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import path from 'node:path'
import { agentReadSize, takeAgentLines } from './agent-file-chunk.js'
import type { AgentSub } from './daemon-session-types.js'
import type { DaemonReplies, DaemonSendEvent } from './daemon-module-deps.js'

export interface DaemonAgentSubsDeps<W extends object> extends DaemonReplies<W> {
  HOME_DIR: string
  STREAMS_DIR: string
  /** A daemon program of its own (false: a runtime inside a server's process, which reads in bounded ticks). */
  LISTEN: boolean
  AGENT_POLL_INTERVAL_MS: number
  AGENT_REDISCOVER_INTERVAL_MS: number
  /** The live subscriptions, by `sid:agent` (the runtime's, which its cleanup ends). */
  agentSubs: Map<string, AgentSub<W>>
  /** The runtime's timers. */
  setInterval: typeof globalThis.setInterval
  clearInterval: typeof globalThis.clearInterval
  sendEvent: DaemonSendEvent<W>
}

export function createDaemonAgentSubs<W extends object>(deps: DaemonAgentSubsDeps<W>) {
  const { HOME_DIR, STREAMS_DIR, LISTEN, AGENT_POLL_INTERVAL_MS, AGENT_REDISCOVER_INTERVAL_MS, agentSubs, setInterval, clearInterval, sendEvent, sendOk, sendError } = deps

  // ── Subscribe to subagent ──
  function cmdSubscribeAgent(ws: W, id: number, cmd: Record<string, unknown>) {
    const { sid, agent, team, offsets } = cmd as {
      sid: string; agent: string; team?: string; offsets?: Record<string, number>
    }
    if (!sid || !agent) return sendError(ws, id, 'subscribe-agent: missing sid or agent')

    const subKey = sid + ':' + agent

    // Unsubscribe existing
    const existing = agentSubs.get(subKey)
    if (existing) {
      if (existing.timer) clearInterval(existing.timer)
      if (existing.rediscoverTimer) clearInterval(existing.rediscoverTimer)
      agentSubs.delete(subKey)
    }

    const sub: AgentSub<W> = {
      files: new Map(),
      timer: null,
      rediscoverTimer: null,
      ws,
      sid,
      agent,
      team,
    }

    // Discover agent JSONL files
    function discoverFiles() {
      try {
        // Look in session subagents dir
        const sessionDir = path.join(STREAMS_DIR, sid, 'subagents')
        try {
          const files = fs.readdirSync(sessionDir)
          for (const f of files) {
            if (!f.endsWith('.jsonl')) continue
            // Match by agent name in filename
            if (f.toLowerCase().includes(agent.toLowerCase()) || f.includes(agent)) {
              const fullPath = path.join(sessionDir, f)
              if (!sub.files.has(fullPath)) {
                const startOffset = (offsets && offsets[f]) || 0
                sub.files.set(fullPath, { offset: startOffset })
              }
            }
          }
        } catch {}
      } catch {}
    }

    // Poll for new data
    /** In process: the most one agent-file poll reads in a tick (pollData). */
    const AGENT_POLL_MAX_BYTES = 1024 * 1024
    function pollData() {
      for (const [filePath, fileState] of sub.files) {
        try {
          const stat = fs.statSync(filePath)
          // Inside a server's process one tick reads at most AGENT_POLL_MAX_BYTES, whole lines only
          // (agent-file-chunk.ts): a large backlog never holds every route at once. A daemon program
          // reads it all, as it always did.
          const bytes = agentReadSize(fileState, stat.size, LISTEN ? null : AGENT_POLL_MAX_BYTES)
          if (bytes > 0) {
            const fd = fs.openSync(filePath, 'r')
            const buf = Buffer.alloc(bytes)
            fs.readSync(fd, buf, 0, bytes, fileState.offset)
            fs.closeSync(fd)
            const lines = takeAgentLines(fileState, buf, stat.size)
            if (lines.length > 0) {
              sendEvent(ws, 'agent', {
                sid,
                agent,
                file: path.basename(filePath),
                lines,
              })
            }
          }
        } catch {}
      }
    }

    // Initial discovery + data send
    discoverFiles()
    pollData()

    // Start polling
    sub.timer = setInterval(pollData, AGENT_POLL_INTERVAL_MS)
    sub.rediscoverTimer = setInterval(discoverFiles, AGENT_REDISCOVER_INTERVAL_MS)

    agentSubs.set(subKey, sub)
    sendOk(ws, id, { subscribed: true, files: [...sub.files.keys()] })
  }

  // ── Unsubscribe from subagent ──
  function cmdUnsubscribeAgent(ws: W, id: number, cmd: Record<string, unknown>) {
    const { sid, agent } = cmd as { sid: string; agent: string }
    const subKey = sid + ':' + agent
    const sub = agentSubs.get(subKey)
    if (sub) {
      if (sub.timer) clearInterval(sub.timer)
      if (sub.rediscoverTimer) clearInterval(sub.rediscoverTimer)
      agentSubs.delete(subKey)
    }
    sendOk(ws, id, { unsubscribed: true })
  }

  // ── Write to team inbox ──
  function cmdWriteInbox(ws: W, id: number, cmd: Record<string, unknown>) {
    const { team, agent, from, text, summary } = cmd as {
      team: string; agent: string; from?: string; text: string; summary?: string
    }
    if (!team || !agent || !text) return sendError(ws, id, 'write-inbox: missing fields')

    const inboxPath = path.join(HOME_DIR, '.claude', 'teams', team, 'inboxes', agent + '.json')

    try {
      fs.mkdirSync(path.dirname(inboxPath), { recursive: true })

      let inbox: unknown[] = []
      try { inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf-8')) } catch {}
      if (!Array.isArray(inbox)) inbox = []

      inbox.push({
        from: from || 'walnut',
        text,
        summary: summary || text.slice(0, 100),
        timestamp: new Date().toISOString(),
        read: false,
      })

      fs.writeFileSync(inboxPath, JSON.stringify(inbox, null, 2))
      sendOk(ws, id, { written: true })
    } catch (err: unknown) {
      sendError(ws, id, 'write-inbox failed: ' + (err as Error).message)
    }
  }

  return { cmdSubscribeAgent, cmdUnsubscribeAgent, cmdWriteInbox }
}
