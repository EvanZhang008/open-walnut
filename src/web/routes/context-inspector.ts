/**
 * Context Inspector route — exposes the full agent context for debugging.
 * GET /api/context returns every section the agent sees each turn.
 *
 * ENGINE-AWARE: the sections depend on which engine answers the turn.
 *   - walnut-agent (in-process loop): the full prompt assembly this file has
 *     always shown (role, skills index, memory, 52 tool schemas, apiMessages).
 *   - claude-code (butler lane): the turn runs in a `claude` CLI session, so
 *     none of that assembly is fed to the model. The honest view is the lane's
 *     LAUNCH CONFIG — the exact `--system-prompt`, model/effort/cwd, MCP
 *     mounts — plus the last turn's exact input-token count. Tools, skills
 *     discovery, and compaction are owned by the CLI itself.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { validateAgentId, validateConversationId, WALNUT_HOME } from '../../constants.js'
import { getConfig, resolveAgentEngineProvider } from '../../core/config-manager.js'
import { DEFAULT_MODEL } from '../../agent/model.js'
import { DEFAULT_MAX_TOKENS } from '../../agent/providers/defaults.js'
import { buildRoleSection, buildSystemPrompt, buildTaskProjectsSection, getNotesContext } from '../../agent/context.js'
import { buildSkillsPrompt } from '../../core/skill-loader.js'
import { getCompactionSummary, getModelContext } from '../../core/chat-history.js'
import { getMemoryFile } from '../../core/memory-file.js'
import { getBoundedMemory, promptScope } from '../../core/bounded-memory.js'
import { getDailyLogsWithinBudget, estimateTokens, estimateMessagesTokens, estimateFullPayload } from '../../core/daily-log.js'
import { getToolSchemas } from '../../agent/tools.js'

export const contextInspectorRouter = Router()

const DAILY_LOG_HALF_BUDGET = 5000

// GET /api/context?agentId=general
contextInspectorRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawAgentId = (req.query.agentId as string) || undefined
    const agentId = rawAgentId ? validateAgentId(rawAgentId) : undefined
    const rawConvId = (req.query.conversationId as string) || undefined
    // Resolve the conversation at the boundary: an explicit id wins, otherwise
    // fall back to the agent's ACTIVE conversation. The inspector always reflects
    // a real conversation's context — never the deprecated legacy ghost file.
    let conversationId = rawConvId ? validateConversationId(rawConvId) : undefined
    if (!conversationId) {
      const { getActiveConversationId } = await import('../../core/conversations.js')
      conversationId = await getActiveConversationId(agentId ?? 'general')
    }
    const config = await getConfig()

    // ── Lane engine (claude-code): show the SESSION's real context, not the
    // in-process assembly (which is not what the model sees on this engine). ──
    const engine = resolveAgentEngineProvider(config)
    if (engine === 'claude-code') {
      const { butlerLaneKey, buildLaneMemoryContext, LANE_MEMORY_HEADER } = await import('../../core/sessions/butler-lane.js')
      const { getSessionByLane } = await import('../../core/session-tracker.js')
      const { butlerProfile, consoleAgentProfile } = await import('../../core/sessions/profiles.js')
      const { buildSessionSkillsPrompt } = await import('../../core/skill-loader.js')
      const { getLastTurnTokens } = await import('../../core/token-truth.js')

      const effectiveAgentId = agentId ?? 'general'
      const lane = butlerLaneKey(effectiveAgentId, conversationId)
      const record = await getSessionByLane(lane)
      // No lane yet (first message not sent) → show what the NEXT spawn will feed.
      // general = butler persona; other console agents = their own persona in the
      // same session wrapper (mirrors butler-lane.resolveLane).
      let fallbackProfile
      if (!record?.profile) {
        const skillsIdx = await buildSessionSkillsPrompt().catch(() => '')
        if (effectiveAgentId === 'general') {
          fallbackProfile = butlerProfile(
            config.user.name ?? 'the user',
            skillsIdx,
            await buildLaneMemoryContext().catch(() => ''),
          )
        } else {
          const { getConsoleAgent } = await import('../../core/agent-registry.js')
          const agentDef = await getConsoleAgent(effectiveAgentId)
          if (!agentDef) {
            res.status(404).json({ error: `Console agent '${effectiveAgentId}' not found` })
            return
          }
          const { loadContextSources } = await import('../../agent/context-sources.js')
          const contextBlock = await loadContextSources(agentDef, {}).catch(() => '')
          fallbackProfile = consoleAgentProfile(agentDef, skillsIdx, contextBlock)
        }
      }
      const profile = record?.profile ?? fallbackProfile!
      const systemPrompt = profile.systemPrompt ?? ''
      const mcpServers = profile.mcpServers ?? {}
      const lastTurnTokens = getLastTurnTokens(conversationId) ?? 0

      const modelConfig = {
        model: record?.model ?? record?.cliModel ?? 'claude default',
        max_tokens: 0,
        region: `${record?.host ?? 'local'} · cwd ${record?.cwd ?? WALNUT_HOME}`,
      }
      const engineNote = [
        '## Engine: Claude Code session',
        '',
        'Main-AI turns run in a long-lived `claude` CLI session, not the in-process loop. The prompt below is the EXACT `--system-prompt` the session was launched with (full replace) — Walnut injects the persona, standing memory, and its skills index into it, engine-neutrally. Tools and context compaction are owned by the session CLI itself, exactly like a coding session.',
        '',
        record
          ? `- Session: \`${record.claudeSessionId}\` (${record.process_status}${record.effectiveEffort || record.effort ? `, effort ${record.effectiveEffort ?? record.effort}` : ''})`
          : '- Session: not started yet — this is what the first message will launch.',
        `- Last turn exact input tokens: ${lastTurnTokens > 0 ? `~${lastTurnTokens.toLocaleString()}` : 'unknown (no turn yet)'}`,
        Object.keys(mcpServers).length > 0
          ? `- MCP mounts: ${Object.entries(mcpServers).map(([k, v]) => `\`${k}\` (${(v as { command?: string }).command ?? '?'})`).join(', ')} — blocked by machine policy on some hosts; the persona falls back to the HTTP API.`
          : '- MCP mounts: none',
        '- Compaction: the CLI auto-compacts its own transcript near the context limit (no Walnut-side compaction on this engine).',
        `- Tools: the CLI's native tool set (Bash, Read, Edit, …)${Object.keys(mcpServers).length > 0 ? ' + MCP tools when the mount is allowed' : ''} — the in-process tool schemas are NOT sent.`,
      ].join('\n')

      // The skills index and the standing-memory block both ride INSIDE the
      // system prompt — split them out so their sections show the real injected
      // content (order in the prompt: persona → memory → skills).
      const skillsMarker = '## Walnut skills (mandatory)'
      const skillsIdx = systemPrompt.lastIndexOf(skillsMarker)
      const skillsContent = skillsIdx >= 0 ? systemPrompt.slice(skillsIdx) : ''
      const memoryIdx = systemPrompt.lastIndexOf(LANE_MEMORY_HEADER)
      const memoryContent = memoryIdx >= 0
        ? systemPrompt.slice(memoryIdx, skillsIdx > memoryIdx ? skillsIdx : undefined).trim()
        : ''

      const promptTokens = estimateTokens(systemPrompt)
      res.json({
        engine: 'claude-code',
        sections: {
          modelConfig: { content: modelConfig, tokens: 0 },
          roleAndRules: { content: engineNote + '\n\n---\n\n' + systemPrompt, tokens: promptTokens },
          skills: { content: skillsContent, tokens: estimateTokens(skillsContent) },
          compactionSummary: { content: '(Owned by the Claude Code CLI — it auto-compacts its own transcript.)', tokens: 0 },
          taskProjects: { content: '(Not injected — the session reads tasks live via MCP/HTTP when asked.)', tokens: 0 },
          userProfile: { content: '(Injected inside Global Memory below — see the standing-memory block.)', tokens: 0 },
          globalMemory: { content: memoryContent, tokens: estimateTokens(memoryContent) },
          notesContext: { content: '(Injected inside Global Memory above — home directory guide section.)', tokens: 0 },
          dailyLogs: { content: '(On demand — memory/daily/<date>.md files the session Reads when asked, not injected per turn.)', tokens: 0 },
          tools: { content: [], tokens: 0, count: 0 },
          apiMessages: { content: [], tokens: 0, count: 0 },
        },
        // Memory + skills are substrings of the system prompt — promptTokens
        // already covers everything injected.
        totalTokens: promptTokens,
      })
      return
    }

    // Non-General console agent — simplified context view
    if (agentId && agentId !== 'general') {
      const { getConsoleAgent } = await import('../../core/agent-registry.js')
      const { buildSubagentToolSet } = await import('../../agent/subagent-context.js')
      const { loadContextSources } = await import('../../agent/context-sources.js')
      const agentDef = await getConsoleAgent(agentId)
      if (!agentDef) {
        res.status(404).json({ error: `Console agent '${agentId}' not found` })
        return
      }

      const systemPrompt = agentDef.system_prompt ?? `You are ${agentDef.name}.`
      const contextXml = await loadContextSources(agentDef, {})
      const fullSystem = contextXml ? systemPrompt + '\n\n' + contextXml : systemPrompt
      const agentTools = await buildSubagentToolSet(agentDef)
      const apiMessages = await getModelContext(agentId, conversationId)
      const compactionContent = await getCompactionSummary(agentId, conversationId).catch(() => null) ?? ''
      // Separate memory/daily for agent vs main, shown as distinct sections
      const ownMemory = getMemoryFile(agentId)?.content ?? ''
      const mainMemory = getMemoryFile(undefined)?.content ?? ''
      const ownDaily = getDailyLogsWithinBudget(DAILY_LOG_HALF_BUDGET, agentId)
      const mainDaily = getDailyLogsWithinBudget(DAILY_LOG_HALF_BUDGET, undefined)

      const systemTokens = estimateTokens(fullSystem)
      const toolsTokens = estimateTokens(JSON.stringify(agentTools))
      const messagesTokens = estimateMessagesTokens(apiMessages)
      const compactionTokens = estimateTokens(compactionContent)
      const ownMemoryTokens = estimateTokens(ownMemory)
      const mainMemoryTokens = estimateTokens(mainMemory)
      const ownDailyTokens = estimateTokens(ownDaily)
      const mainDailyTokens = estimateTokens(mainDaily)
      const totalTokens = systemTokens + toolsTokens + messagesTokens

      res.json({
        sections: {
          modelConfig: {
            content: { model: config.agent?.main_model ?? DEFAULT_MODEL, agent: agentDef.name },
            tokens: 0,
          },
          roleAndRules: {
            content: fullSystem,
            tokens: systemTokens,
          },
          skills: { content: '', tokens: 0 },
          compactionSummary: { content: compactionContent, tokens: compactionTokens },
          taskProjects: { content: '', tokens: 0 },
          agentMemory: { content: ownMemory || '(no agent memory yet)', tokens: ownMemoryTokens },
          mainAgentMemory: { content: mainMemory || '(no main memory)', tokens: mainMemoryTokens },
          agentDailyLogs: { content: ownDaily || '(no agent daily logs)', tokens: ownDailyTokens },
          mainAgentDailyLogs: { content: mainDaily || '(no main daily logs)', tokens: mainDailyTokens },
          userProfile: { content: '', tokens: 0 },
          globalMemory: { content: '', tokens: 0 },
          notesContext: { content: '', tokens: 0 },
          dailyLogs: { content: '', tokens: 0 },
          tools: { content: agentTools, tokens: toolsTokens, count: agentTools.length },
          apiMessages: { content: apiMessages, tokens: messagesTokens, count: apiMessages.length },
        },
        totalTokens,
      })
      return
    }

    // General agent — full context view
    const name = config.user.name ?? 'the user'

    // Gather each section independently — memory sections use the SAME bounded
    // renderers as buildMemoryContext() so the inspector mirrors the real prompt.
    const roleContent = buildRoleSection(name)
    const skillsContent = await buildSkillsPrompt() ?? ''
    const compactionContent = await getCompactionSummary(undefined, conversationId).catch(() => null) ?? ''
    // Same freeze scope buildSystemPromptSplit() derives, so these per-section
    // views show the FROZEN block the live turn is actually injecting rather than
    // a fresher live read — otherwise the inspector would contradict the total it
    // computes from buildSystemPrompt() below. No pin ⇒ live read.
    const memoryScope = promptScope(agentId, conversationId)
    const globalMemory = getBoundedMemory().renderForPrompt(memoryScope) ?? ''
    const userProfile = getBoundedMemory(undefined, 'user').renderForPrompt(memoryScope) ?? ''
    const dailyLogs = getDailyLogsWithinBudget(Math.floor(20000 / 2))
    const toolSchemas = getToolSchemas()
    const apiMessages = await getModelContext(undefined, conversationId)

    // Projects overview (single grouping layer)
    const taskProjectsText = await buildTaskProjectsSection()

    // Recent-task ledger (same render the prompt injects — task-ledger.ts)
    const { buildTaskLedger } = await import('../../core/task-ledger.js')
    const recentTasksText = await buildTaskLedger()

    // Token estimates per section
    const roleTokens = estimateTokens(roleContent)
    const skillsTokens = estimateTokens(skillsContent)
    const compactionTokens = estimateTokens(compactionContent)
    const taskProjectsTokens = estimateTokens(taskProjectsText)
    const globalMemoryTokens = estimateTokens(globalMemory)
    const userProfileTokens = estimateTokens(userProfile)
    const dailyLogsTokens = estimateTokens(dailyLogs)
    const toolsText = JSON.stringify(toolSchemas)
    const toolsTokens = estimateTokens(toolsText)

    // Use robust estimation for messages to handle images correctly
    // (by pixel dimensions, not base64 size which can inflate by 500x)
    const messagesTokens = estimateMessagesTokens(apiMessages)

    // Model config — API call parameters (model/max_tokens/region), shown for
    // debugging only. It is NOT part of the prompt, so it costs 0 tokens.
    const modelConfig = {
      model: config.agent?.main_model ?? config.agent?.model ?? DEFAULT_MODEL,
      max_tokens: config.agent?.maxTokens ?? DEFAULT_MAX_TOKENS,
      region: config.agent?.region ?? config.provider?.bedrock_region ?? 'us-west-2',
    }

    // Use the actual buildSystemPrompt() for the total, consistent with
    // needsCompaction() and /api/chat/stats. The per-section breakdowns above
    // are informational for the UI; the total must match the real payload.
    const actualSystemPrompt = await buildSystemPrompt(undefined, conversationId)
    const payloadEstimate = estimateFullPayload({ system: actualSystemPrompt, tools: toolSchemas, messages: apiMessages })
    const totalTokens = payloadEstimate.total

    res.json({
      sections: {
        modelConfig: {
          content: modelConfig,
          tokens: 0,
        },
        roleAndRules: {
          content: roleContent,
          tokens: roleTokens,
        },
        skills: {
          content: skillsContent,
          tokens: skillsTokens,
        },
        compactionSummary: {
          content: compactionContent,
          tokens: compactionTokens,
        },
        taskProjects: {
          content: taskProjectsText,
          tokens: taskProjectsTokens,
        },
        recentTasks: {
          content: recentTasksText,
          tokens: estimateTokens(recentTasksText),
        },
        userProfile: {
          content: userProfile,
          tokens: userProfileTokens,
        },
        globalMemory: {
          content: globalMemory,
          tokens: globalMemoryTokens,
        },
        notesContext: {
          content: getNotesContext(),
          tokens: estimateTokens(getNotesContext()),
        },
        dailyLogs: {
          content: dailyLogs,
          tokens: dailyLogsTokens,
        },
        tools: {
          content: toolSchemas,
          tokens: toolsTokens,
          count: toolSchemas.length,
        },
        apiMessages: {
          content: apiMessages,
          tokens: messagesTokens,
          count: apiMessages.length,
        },
      },
      totalTokens,
    })
  } catch (err) {
    next(err)
  }
})
