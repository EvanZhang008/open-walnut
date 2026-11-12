/**
 * Everything a session of this task can read of its default instructions: its prompt, with
 * each block a cap cut (src/core/sessions/prompt-blocks.ts) whole again, as the head in the
 * prompt and the rest in its memory folder hold it together (prompt-blocks.test.ts proves the
 * two make the whole). For tests that a rule reaches a role, wherever its cap put it.
 */
import { composeInstructions, type InstructionTask } from '../../src/core/sessions/session-context.js'

export function nodeReads(task: InstructionTask): string {
  return composeInstructions(task, { taskLine: '', taskDir: '', fleet: '' }, { uncapped: true }).text()
}
