/**
 * Plan execution utilities — reading plan files and building the execution message.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getSessionByClaudeId } from '../core/session-tracker.js';
import { findSessionJsonlPath } from '../core/session-history.js';
import { CLAUDE_HOME } from '../constants.js';

/**
 * Read the plan file from a completed session that produced a plan.
 * Validates on planCompleted (not mode), since sessions can enter plan mode dynamically.
 * Tries: 1) SessionRecord.planFile, 2) JSONL slug → ~/.claude/plans/{slug}.md
 */
export async function readPlanFromSession(planSessionId: string): Promise<{ content: string; planFile: string } | { error: string }> {
  const record = await getSessionByClaudeId(planSessionId);
  if (!record) return { error: `Plan session not found: ${planSessionId}` };
  if (!record.planCompleted) return { error: `Session ${planSessionId} has not completed a plan (planCompleted is false). Wait for the session to finish and call ExitPlanMode.` };

  // Strategy 1: planFile from session record
  if (record.planFile) {
    try {
      const content = await fsp.readFile(record.planFile, 'utf-8');
      if (content.trim()) return { content, planFile: record.planFile };
    } catch {
      // File might not exist, fall through
    }
  }

  // Strategy 2: Read JSONL to find slug → ~/.claude/plans/{slug}.md
  try {
    const jsonlPath = findSessionJsonlPath(planSessionId, record.cwd);
    if (jsonlPath) {
      const content = await fsp.readFile(jsonlPath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.slug) {
            const planPath = path.join(CLAUDE_HOME, 'plans', `${parsed.slug}.md`);
            try {
              const planContent = await fsp.readFile(planPath, 'utf-8');
              if (planContent.trim()) return { content: planContent, planFile: planPath };
            } catch {
              // Plan file doesn't exist at this path
            }
            break;
          }
        } catch {
          // Skip unparseable lines
        }
      }
    }
  } catch {
    // JSONL reading failed
  }

  return { error: `Could not find plan file for session ${planSessionId}. The session may not have written a plan, or the plan file was deleted.` };
}

/**
 * Build the plan execution message with both plan content and file path reference.
 * Content is included inline so the session sees the full plan immediately (no need to read the file).
 * The file path is a durable reference — identical content lives at that path. After compaction,
 * the session preserves the path and re-reads the plan from disk to restore full context.
 */
export function buildPlanExecutionMessage(planFilePath: string, planContent: string, userPrompt?: string): string {
  const instruction = userPrompt
    ?? `Execute the plan below. Read it carefully first, then implement each step.`;

  const compactionRef = [
    `Plan file: ${planFilePath} (the full plan content is included below — identical to the file, no need to read it again).`,
    'IMPORTANT: If your context is ever compacted or summarized, you MUST preserve this plan file path and re-read it from disk to restore the full plan.',
  ].join('\n');

  return [
    instruction,
    '',
    compactionRef,
    '',
    '---',
    '',
    planContent,
  ].join('\n');
}
