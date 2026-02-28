/**
 * Plan execution utilities — reading plan files and building the execution message.
 *
 * Supports both local and remote (SSH) sessions transparently via createFileReader().
 * Remote sessions store plan files on the remote host — the reader handles SSH access.
 */
import path from 'node:path';
import { getSessionByClaudeId } from '../core/session-tracker.js';
import { findSessionJsonlPath, extractPlanContent } from '../core/session-history.js';
import { createFileReader, readSessionJsonlContent } from '../core/session-file-reader.js';
import { CLAUDE_HOME } from '../constants.js';

/**
 * Read the plan file from a completed session that produced a plan.
 * Validates on planCompleted (not mode), since sessions can enter plan mode dynamically.
 *
 * Strategies (tried in order):
 *   1) SessionRecord.planFile — read via local fs or SSH depending on host
 *   2) JSONL slug → ~/.claude/plans/{slug}.md — read via local fs or SSH
 *   3) extractPlanContent() — parse plan from JSONL tool_use blocks (already remote-aware)
 */
export async function readPlanFromSession(planSessionId: string): Promise<{ content: string; planFile: string } | { error: string }> {
  const record = await getSessionByClaudeId(planSessionId);
  if (!record) return { error: `Plan session not found: ${planSessionId}` };
  if (!record.planCompleted) return { error: `Session ${planSessionId} has not completed a plan (planCompleted is false). Wait for the session to finish and call ExitPlanMode.` };

  // Transparent reader: LocalFileReader for local sessions, RemoteFileReader (SSH) for remote
  const reader = createFileReader(record.host);

  // Strategy 1: planFile from session record
  if (record.planFile) {
    const content = await reader.readFile(record.planFile);
    if (content?.trim()) return { content, planFile: record.planFile };
  }

  // Strategy 2: Read JSONL to find slug → ~/.claude/plans/{slug}.md
  try {
    // For local sessions, use findSessionJsonlPath (fast fs lookup)
    // For remote sessions, use readSessionJsonlContent (SSH)
    let jsonlContent: string | null = null;

    if (!record.host) {
      const jsonlPath = findSessionJsonlPath(planSessionId, record.cwd);
      if (jsonlPath) {
        jsonlContent = await reader.readFile(jsonlPath);
      }
    } else {
      const result = await readSessionJsonlContent(planSessionId, record.cwd, record.host, record.outputFile);
      if (result) jsonlContent = result.content;
    }

    if (jsonlContent) {
      const lines = jsonlContent.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.slug) {
            // Remote: tilde-based path (SSH expands ~); Local: absolute via CLAUDE_HOME
            const planPath = record.host
              ? `~/.claude/plans/${parsed.slug}.md`
              : path.join(CLAUDE_HOME, 'plans', `${parsed.slug}.md`);
            const planContent = await reader.readFile(planPath);
            if (planContent?.trim()) return { content: planContent, planFile: planPath };
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

  // Strategy 3: Extract plan content from JSONL tool_use blocks (Write to plans/ or ExitPlanMode)
  // extractPlanContent() already supports remote sessions via readSessionJsonlContent()
  try {
    const extracted = await extractPlanContent(planSessionId, record.cwd, record.host);
    if (extracted?.trim()) {
      const planFile = record.planFile ?? `(extracted from session ${planSessionId} JSONL)`;
      return { content: extracted, planFile };
    }
  } catch {
    // Extraction failed
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
