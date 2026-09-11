/**
 * Context Inspector route — what the model was actually given.
 * GET /api/context returns the LAUNCH CONFIG of the session behind a conversation.
 *
 * A chat turn runs in a long-lived `claude` CLI session, so there is no per-turn
 * prompt assembly on Walnut's side to show. The honest view is that session's
 * launch config: the exact `--append-system-prompt` block it was spawned with,
 * plus model/effort/cwd and MCP mounts. The CLI's own default prompt (identity,
 * env/date, tool guidance, gitStatus) sits above the persona and is NOT shown or
 * counted here; tools, skills discovery, and compaction are owned by the CLI.
 *
 * WHICH conversation: `?sessionId=` names a session directly — what an Ask Walnut
 * conversation IS, so this is the form the web console uses. The older
 * `?agentId=`/`?conversationId=` pair resolves a console-agent lane instead and
 * still works; with neither, the agent's active conversation answers.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { validateAgentId, validateConversationId, WALNUT_HOME } from '../../constants.js'
import { getConfig } from '../../core/config-manager.js'
import { engineCaps } from '../../core/agents/engine-registry.js'
import { estimateTokens } from '../../core/daily-log.js'

export const contextInspectorRouter = Router()

/**
 * What a NAMED session with no recorded launch profile gets instead of a prompt.
 *
 * The alternative was worse than useless: the route used to synthesize the current
 * Personal AI persona and present it as "the block this session was launched
 * with", so an old session (or one started before profiles were recorded) showed a
 * prompt it had never seen, with a token count to match.
 */
const NO_PROFILE_NOTE = 'No launch profile was recorded for this session, so Walnut cannot show the prompt it was launched with. Sessions started before Walnut recorded launch profiles, and sessions started outside Walnut, have none. A new session records one at spawn.'

// GET /api/context?agentId=general
contextInspectorRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawAgentId = (req.query.agentId as string) || undefined
    const agentId = rawAgentId ? validateAgentId(rawAgentId) : undefined
    // A named session (Ask Walnut). READ FIRST, before anything that could write:
    // not validated against a pattern, because it is only ever used as an exact key
    // into the session store, which answers null for anything it doesn't know.
    // Length-capped so a junk query can't turn into a large scan key.
    const rawSessionId = (req.query.sessionId as string) || undefined
    const sessionId = rawSessionId ? rawSessionId.slice(0, 200) : undefined
    const rawConvId = (req.query.conversationId as string) || undefined
    // Resolve the conversation at the boundary: an explicit id wins, otherwise
    // fall back to the agent's ACTIVE conversation.
    //
    // ONLY on the lane path. `getActiveConversationId` CREATES a conversation when
    // the agent has none, and a read-only inspector GET must not write state for a
    // request that never looks at it: a named session answers entirely from its own
    // record.
    let conversationId = rawConvId ? validateConversationId(rawConvId) : undefined
    if (!conversationId && !sessionId) {
      const { getActiveConversationId } = await import('../../core/conversations.js')
      conversationId = await getActiveConversationId(agentId ?? 'general')
    }
    const config = await getConfig()

    const { personalAiLaneKey, LANE_MEMORY_HEADER } = await import('../../core/sessions/personal-ai-lane.js')
    const { getSessionByClaudeId, getSessionByLane } = await import('../../core/session-tracker.js')
    const { getLastTurnTokens } = await import('../../core/token-truth.js')

    const effectiveAgentId = agentId ?? 'general'
    // A named session is authoritative: read ITS record. A session id the store
    // doesn't know is an error, not a reason to describe something else — the panel
    // would otherwise show a different conversation's launch config as if it were
    // this one's.
    // `conversationId` is resolved above for the lane path ONLY, so it is spelled
    // out here rather than asserted.
    const record = sessionId
      ? await getSessionByClaudeId(sessionId)
      : conversationId
        ? await getSessionByLane(personalAiLaneKey(effectiveAgentId, conversationId))
        : null
    if (sessionId && !record) {
      res.status(404).json({ error: `Session '${sessionId}' not found` })
      return
    }
    // No lane yet (first message not sent) → show what the NEXT spawn will feed.
    // buildLaneProfile is the one builder every lane and Ask Walnut launch uses, so
    // this cannot drift from what a mint would actually pass.
    //
    // NEVER for a NAMED session: synthesizing the persona there answered "this is
    // what the session was launched with" for a prompt that session never saw. A
    // record with no recorded profile says so instead (see NO_PROFILE_NOTE).
    let fallbackProfile
    if (!record?.profile && !sessionId) {
      const { buildLaneProfile } = await import('../../core/sessions/personal-ai-lane.js')
      try {
        fallbackProfile = (await buildLaneProfile(config, effectiveAgentId)).profile
      } catch (err) {
        // The only expected failure is an agent id the registry does not know.
        res.status(404).json({
          error: err instanceof Error ? err.message : `Agent '${effectiveAgentId}' not found`,
        })
        return
      }
    }
    // `undefined` is legal: a named session whose record carries no profile.
    const profile = record?.profile ?? fallbackProfile
    const systemPrompt = profile?.systemPrompt ?? ''
    const mcpServers = profile?.mcpServers ?? {}
    // Which engine actually answers this session. Only the native runtime (the
    // long-running `claude` CLI over FIFO) is launched with Walnut's assembled
    // `--append-system-prompt`; an ACP engine owns its own prompt, so the notes
    // below must not claim Walnut assembled it.
    const caps = engineCaps(record?.engine)
    const recordEngine = caps.id
    const isClaudeCode = caps.runtimeKind === 'native'
    // The exact-input-token ledger is keyed by CONVERSATION (recorded off lane
    // turns), so a named session has no entry — say so rather than printing a 0
    // that reads like "no tokens used". The session's own composer model pill shows
    // its live context %.
    const lastTurnTokens = sessionId || !conversationId
      ? undefined
      : (getLastTurnTokens(conversationId) ?? 0)

    const modelConfig = {
      model: record?.model ?? record?.cliModel ?? 'claude default',
      region: `${record?.host ?? 'local'} · cwd ${record?.cwd ?? WALNUT_HOME}`,
    }
    const engineNote = [
      isClaudeCode
        ? '## Engine: Claude Code session'
        : `## Engine: ${recordEngine} session (NOT Claude Code)`,
      '',
      isClaudeCode
        ? 'This conversation runs in a long-lived `claude` CLI session. The prompt below is the EXACT `--append-system-prompt` block the session was launched with — Walnut injects the persona, standing memory, and its skills index into it, engine-neutrally, ON TOP of the CLI\'s own default prompt (identity, tool guidance, env info with today\'s date, gitStatus). That default prompt is in the model\'s context too but is NOT shown or counted below, so the token numbers here understate the session total. Tools and context compaction are owned by the session CLI itself, exactly like a coding session.'
        : `This session runs on the \`${recordEngine}\` engine, so the Claude Code notes do not apply to it. What follows is the launch profile Walnut recorded for it, as recorded — that engine's own default prompt, tool set, and context handling are owned entirely by its CLI and are neither shown nor counted here.`,
      '',
      record
        ? `- Session: \`${record.claudeSessionId}\` (${record.process_status}${record.effectiveEffort || record.effort ? `, effort ${record.effectiveEffort ?? record.effort}` : ''})`
        : '- Session: not started yet — this is what the first message will launch.',
      lastTurnTokens === undefined
        ? '- Last turn exact input tokens: not tracked per session — the composer\'s model pill shows this session\'s live context %.'
        : `- Last turn exact input tokens: ${lastTurnTokens > 0 ? `~${lastTurnTokens.toLocaleString()}` : 'unknown (no turn yet)'}`,
      Object.keys(mcpServers).length > 0
        ? `- MCP mounts: ${Object.entries(mcpServers).map(([k, v]) => {
            // Real per-server verdict from the CLI's init event when we have it
            // (recorded by the session runner), instead of the old blanket
            // "blocked on some hosts" guess. 'blocked' = refused by machine policy.
            const st = record?.mcpMountStatus?.[k]
            return `\`${k}\` (${(v as { command?: string }).command ?? '?'})${st ? ` — ${st}` : ''}`
          }).join(', ')}${
            record?.mcpMountStatus
              // 'pending' = handshake still finishing; the tools do arrive, so it
              // is not a degraded mount (see the init handler's note).
              ? Object.values(record.mcpMountStatus).every((s) => s === 'connected' || s === 'pending')
                ? ''
                : ' · a non-connected mount means its tools are NOT available this session; use the `walnut` CLI over Bash instead (see the walnut skill).'
              : ' · mount health unknown until the session starts.'
          }`
        : '- MCP mounts: none',
      '- Compaction: the CLI auto-compacts its own transcript near the context limit (no Walnut-side compaction on this engine).',
      `- Tools: the CLI's native tool set (Bash, Read, Edit, …)${Object.keys(mcpServers).length > 0 ? ' + MCP tools when the mount is allowed' : ''}.`,
      ...(profile ? [] : [`- ${NO_PROFILE_NOTE}`]),
    ].join('\n')

    // The skills index and the standing-memory block both ride INSIDE the system
    // prompt — split them out so their sections show the real injected content
    // (order in the prompt: persona → memory → skills).
    const skillsMarker = '## Walnut skills (mandatory)'
    const skillsIdx = systemPrompt.lastIndexOf(skillsMarker)
    const skillsContent = skillsIdx >= 0 ? systemPrompt.slice(skillsIdx) : ''
    const memoryIdx = systemPrompt.lastIndexOf(LANE_MEMORY_HEADER)
    const memoryContent = memoryIdx >= 0
      ? systemPrompt.slice(memoryIdx, skillsIdx > memoryIdx ? skillsIdx : undefined).trim()
      : ''

    const promptTokens = estimateTokens(systemPrompt)
    // Only sections with a real source are emitted. A tool list, a message
    // transcript, and a compaction summary all live inside the CLI, so a zeroed
    // section here would read as "the model got none of that" rather than "Walnut
    // is not the one holding it".
    res.json({
      // From the RECORD, not hardcoded: a session on another engine used to be
      // reported as claude-code, and the panel then badged it "Claude Code engine".
      engine: isClaudeCode ? 'claude-code' : recordEngine,
      sections: {
        modelConfig: { content: modelConfig, tokens: 0 },
        roleAndRules: {
          content: engineNote + '\n\n---\n\n' + (systemPrompt || NO_PROFILE_NOTE),
          tokens: promptTokens,
        },
        skills: { content: skillsContent, tokens: estimateTokens(skillsContent) },
        globalMemory: { content: memoryContent, tokens: estimateTokens(memoryContent) },
      },
      // Memory + skills are substrings of the system prompt — promptTokens already
      // covers everything injected.
      totalTokens: promptTokens,
    })
  } catch (err) {
    next(err)
  }
})
