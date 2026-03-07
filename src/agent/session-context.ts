/**
 * Build a bounded context block for Claude Code sessions.
 *
 * When Walnut starts a `claude -p` session via start_session, this module
 * assembles task metadata, description, summary, note, prior
 * session summaries, and project memory into a system prompt (~3000 tokens max).
 *
 * Every section is wrapped in try/catch — missing data is simply omitted.
 */

import fs from 'node:fs'
import path from 'node:path'
import { SESSIONS_DIR } from '../constants.js'
import { estimateTokens } from '../core/daily-log.js'
import { log } from '../logging/index.js'

// ── Budget constants (tokens) ──

const TASK_META_BUDGET = 100
const DESCRIPTION_BUDGET = 300
const SUMMARY_BUDGET = 200
const NOTE_BUDGET = 500
const CONVERSATION_LOG_BUDGET = 300
const SESSION_BUDGET = 600
const PROJECT_MEMORY_BUDGET = 1500

const MAX_SESSIONS = 3

export interface SessionContext {
  systemPrompt: string
}

/**
 * Assemble a bounded context block from the task's metadata, description,
 * summary, note, prior session summaries, and project memory.
 *
 * Returns `{ systemPrompt }` — an empty string if the task doesn't exist
 * or all sections fail.
 */
export async function buildSessionContext(taskId: string): Promise<SessionContext> {
  const sections: string[] = []

  // ── Task metadata ──
  try {
    const { getTask } = await import('../core/task-manager.js')
    const task = await getTask(taskId)

    const meta = [
      `Task: ${task.title}`,
      `Phase: ${task.phase}`,
      `Status: ${task.status}`,
      `Priority: ${task.priority}`,
      `Category: ${task.category}`,
      task.project && task.project !== task.category ? `Project: ${task.project}` : null,
      task.sprint ? `Sprint: ${task.sprint}` : null,
      task.due_date ? `Due: ${task.due_date}` : null,
    ]
      .filter(Boolean)
      .join('\n')

    sections.push(truncateToTokenBudget(`<task>\n${meta}\n</task>`, TASK_META_BUDGET))

    // Subtasks removed (now child tasks in the plugin system)

    // ── Description ──
    if (task.description) {
      try {
        sections.push(
          truncateToTokenBudget(`<description>\n${task.description}\n</description>`, DESCRIPTION_BUDGET),
        )
      } catch {
        // non-critical
      }
    }

    // ── Summary ──
    if (task.summary) {
      try {
        sections.push(
          truncateToTokenBudget(`<summary>\n${task.summary}\n</summary>`, SUMMARY_BUDGET),
        )
      } catch {
        // non-critical
      }
    }

    // ── Note ──
    if (task.note) {
      try {
        sections.push(
          truncateToTokenBudget(`<note>\n${task.note}\n</note>`, NOTE_BUDGET),
        )
      } catch {
        // non-critical
      }
    }

    // ── Conversation log (tail-truncated: recent entries matter most) ──
    if (task.conversation_log) {
      try {
        // Take the tail (most recent entries) before token-budget truncation
        const logTail = task.conversation_log.length > 2000
          ? task.conversation_log.slice(-2000)
          : task.conversation_log
        sections.push(
          truncateToTokenBudget(`<conversation_log>\n${logTail}\n</conversation_log>`, CONVERSATION_LOG_BUDGET),
        )
      } catch {
        // non-critical
      }
    }

    // ── Previous session summaries ──
    try {
      const { getSessionsForTask } = await import('../core/session-tracker.js')
      const sessions = await getSessionsForTask(taskId)

      if (sessions.length > 0) {
        const recent = sessions
          .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
          .slice(0, MAX_SESSIONS)

        const sessionLines = recent.map((s) => {
          const parts = [
            `Session ${s.claudeSessionId.slice(0, 8)}`,
            `process=${s.process_status}, work=${s.work_status}`,
            `started=${s.startedAt}`,
            s.title ? `title="${s.title}"` : null,
          ]
            .filter(Boolean)
            .join(', ')
          return `- ${parts}`
        })

        let summaryBlock = sessionLines.join('\n')

        // Read session summary markdown files from memory/sessions/
        try {
          const files = fs.readdirSync(SESSIONS_DIR).filter(
            (f: string) => f.endsWith('.md'),
          )
          for (const session of recent) {
            for (const file of files) {
              const content = fs.readFileSync(
                path.join(SESSIONS_DIR, file),
                'utf-8',
              )
              if (content.includes(session.claudeSessionId)) {
                const summaryMatch = content.match(
                  /## Summary\n([\s\S]*?)(?=\n## |\n*$)/,
                )
                if (summaryMatch) {
                  summaryBlock += `\n  Summary: ${summaryMatch[1].trim().slice(0, 300)}`
                }
                break
              }
            }
          }
        } catch {
          // Session summary files are optional
        }

        sections.push(
          truncateToTokenBudget(
            `<previous_sessions>\n${summaryBlock}\n</previous_sessions>`,
            SESSION_BUDGET,
          ),
        )
      }
    } catch {
      // non-critical
    }

    // ── Project memory excerpt ──
    try {
      const { getProjectMemory } = await import('../core/project-memory.js')
      const projectPath = `${task.category.toLowerCase()}/${task.project.toLowerCase()}`
      const memResult = getProjectMemory(projectPath)

      if (memResult) {
        sections.push(
          truncateToTokenBudget(
            `<project_memory>\n${memResult.content}\n</project_memory>`,
            PROJECT_MEMORY_BUDGET,
          ),
        )
      } else if (task.project !== task.category) {
        // Try category-level memory if project-specific doesn't exist
        const catResult = getProjectMemory(task.category.toLowerCase())
        if (catResult) {
          sections.push(
            truncateToTokenBudget(
              `<project_memory>\n${catResult.content}\n</project_memory>`,
              PROJECT_MEMORY_BUDGET,
            ),
          )
        }
      }
    } catch {
      // non-critical
    }
  } catch (err) {
    log.session.warn('buildSessionContext: failed to load task', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // Always include the server safety warning, even when there are no task-specific
  // sections. Sessions may still run exec commands that could affect the server.
  const serverWarning = [
    '<server_safety>',
    'IMPORTANT: Port 3456 is the user\'s PRODUCTION Walnut server. NEVER kill, restart, or interfere with it.',
    '',
    'For development and testing, ALWAYS use `walnut web --ephemeral` which:',
    '- Copies data to a temp dir, starts a FULL server on a random port (identical to production)',
    '- Prints JSON to stdout: {"pid":12345,"port":54321,"tmpDir":"/tmp/walnut-..."}',
    '- Self-destructs after 10 min of no HTTP requests (idle timeout)',
    '- Supports N concurrent instances — each agent gets its own server',
    '',
    'Usage:',
    '  result=$(walnut web --ephemeral)   # returns JSON immediately',
    '  port=$(echo "$result" | jq -r .port)',
    '  curl http://localhost:$port/api/tasks',
    '  kill $(echo "$result" | jq -r .pid)  # server cleans up its own tmpdir',
    '</server_safety>',
  ].join('\n')

  const systemPrompt = sections.length > 0
    ? `You are working on a task in Walnut. Here is the context:\n\n${sections.join('\n\n')}\n\n${serverWarning}`
    : serverWarning

  return { systemPrompt }
}

/**
 * Truncate text to fit within a token budget.
 * If the text exceeds the budget, it is cut at word boundaries with a trailing "[...]".
 */
function truncateToTokenBudget(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text

  const words = text.split(/\s+/)
  const result: string[] = []
  let tokens = 0
  const reserveTokens = 3 // for "[...]"

  for (const word of words) {
    const newTokens = tokens + 1.3
    if (newTokens > budget - reserveTokens) {
      result.push('[...]')
      break
    }
    result.push(word)
    tokens = newTokens
  }

  return result.join(' ')
}
