/**
 * The user's own words in a task's chat, filed as his chat send files them (user-asks.ts), for a test
 * that answers an ask only he approves in his place: answers_ask checks user_words against this record
 * (sessions/user-spoke.ts verifyUsersWords). Filing directly wakes no CLI.
 */
import { getTask } from '../../src/core/task-manager.js'
import { prepareUserAskCapture } from '../../src/core/sessions/user-asks.js'

export async function userWrote(taskId: string, words: string): Promise<void> {
  // After the ask's own time, even on a fast clock.
  await new Promise((r) => setTimeout(r, 5))
  const capture = await prepareUserAskCapture({ task: await getTask(taskId), message: words, inChat: true })
  if (!capture) throw new Error(`userWrote: ${taskId} files no user words`)
  await capture.commit()
}
