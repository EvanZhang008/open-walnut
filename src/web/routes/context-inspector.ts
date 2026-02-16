/**
 * Context Inspector route — exposes the full agent context for debugging.
 * GET /api/context returns every section the agent sees each turn.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getConfig } from '../../core/config-manager.js'
import { buildRoleSection, buildSystemPrompt, buildTaskCategoriesSection } from '../../agent/context.js'
import { buildSkillsPrompt } from '../../core/skill-loader.js'
import { getCompactionSummary, getModelContext } from '../../core/chat-history.js'
import { getMemoryFile } from '../../core/memory-file.js'
import { getAllProjectSummaries } from '../../core/project-memory.js'
import { getDailyLogsWithinBudget, estimateTokens, estimateMessagesTokens, estimateFullPayload } from '../../core/daily-log.js'
import { getToolSchemas } from '../../agent/tools.js'

export const contextInspectorRouter = Router()

// GET /api/context
contextInspectorRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await getConfig()
    const name = config.user.name ?? 'the user'

    // Gather each section independently
    const roleContent = buildRoleSection(name)
    const skillsContent = await buildSkillsPrompt() ?? ''
    const compactionContent = await getCompactionSummary().catch(() => null) ?? ''
    const globalMemory = getMemoryFile() ?? ''
    const projectSummaries = getAllProjectSummaries()
    const dailyLogs = getDailyLogsWithinBudget(Math.floor(20000 / 2))
    const toolSchemas = getToolSchemas()
    const apiMessages = await getModelContext()

    // Task categories & projects overview
    const taskCategoriesText = buildTaskCategoriesSection()

    // Format project summaries as text (same as buildMemoryContext)
    const projectSummariesText = projectSummaries.length > 0
      ? projectSummaries.map((s) => `- **${s.name}** (${s.path}): ${s.description}`).join('\n')
      : '(No projects yet.)'

    // Token estimates per section
    const roleTokens = estimateTokens(roleContent)
    const skillsTokens = estimateTokens(skillsContent)
    const compactionTokens = estimateTokens(compactionContent)
    const taskCategoriesTokens = estimateTokens(taskCategoriesText)
    const globalMemoryTokens = estimateTokens(globalMemory)
    const projectSummariesTokens = estimateTokens(projectSummariesText)
    const dailyLogsTokens = estimateTokens(dailyLogs)
    const toolsText = JSON.stringify(toolSchemas)
    const toolsTokens = estimateTokens(toolsText)

    // Use robust estimation for messages to handle images correctly
    // (by pixel dimensions, not base64 size which can inflate by 500x)
    const messagesTokens = estimateMessagesTokens(apiMessages)

    // Model config
    const provider = config.provider as Record<string, unknown> | undefined
    const modelConfig = {
      model: (provider?.model as string) ?? 'claude-opus-4-6',
      max_tokens: 16384,
      region: (provider?.region as string) ?? 'us-east-1',
    }
    const modelConfigText = JSON.stringify(modelConfig)
    const modelConfigTokens = estimateTokens(modelConfigText)

    // Use the actual buildSystemPrompt() for the total, consistent with
    // needsCompaction() and /api/chat/stats. The per-section breakdowns above
    // are informational for the UI; the total must match the real payload.
    const actualSystemPrompt = await buildSystemPrompt()
    const payloadEstimate = estimateFullPayload({ system: actualSystemPrompt, tools: toolSchemas, messages: apiMessages })

    // totalTokens uses the payload estimate for consistency, plus model config overhead
    const totalTokens = payloadEstimate.total + modelConfigTokens

    res.json({
      sections: {
        modelConfig: {
          content: modelConfig,
          tokens: modelConfigTokens,
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
        taskCategories: {
          content: taskCategoriesText,
          tokens: taskCategoriesTokens,
        },
        globalMemory: {
          content: globalMemory,
          tokens: globalMemoryTokens,
        },
        projectSummaries: {
          content: projectSummariesText,
          tokens: projectSummariesTokens,
          count: projectSummaries.length,
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
