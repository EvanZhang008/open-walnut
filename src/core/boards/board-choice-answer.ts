/**
 * Answer a Board choice and tell its Board's task: the one way a choice is answered, from the
 * Board's route (a person's click, an agent's PUT) and from a lead's task_send answers_ask in the
 * user's place (sessions/ask-answer.ts). The user's answer goes as the user; an agent's as a
 * message from that agent's session (peer provenance).
 */
import { picturesHeader } from '../answer-pictures.js'
import { getBoard } from './board-store.js'
import { markChoiceDelivery, setBoardChoice } from './board-items.js'
import { buildChoicePrompt, deliverBoardText, type BoardDelivery } from './board-delivery.js'
import { boardWriterStamp, type BoardCaller } from './board-team.js'

export type ChoiceDelivery = BoardDelivery | { state: 'skipped'; reason: 'unchanged' | 'cleared' | 'self' }

export async function answerBoardChoice(
  boardTaskId: string,
  choiceId: string,
  input: { option?: string; text?: string; images?: string[] },
  caller: BoardCaller,
  opts: { overrideUser?: boolean } = {},
): Promise<{ choice: Awaited<ReturnType<typeof setBoardChoice>>['choice']; delivery: ChoiceDelivery }> {
  const result = await setBoardChoice(boardTaskId, choiceId, input, {
    writer: await boardWriterStamp(caller), overrideUser: opts.overrideUser,
    ...(caller.kind === 'task' || (caller.kind === 'agent' && caller.untracked) ? { sessionId: caller.sessionId } : {}),
  })
  let delivery: ChoiceDelivery
  if (!result.choice) delivery = { state: 'skipped', reason: 'cleared' }
  // The same answer again: nothing to say, unless its last delivery did not go out.
  else if (!result.changed && !result.choice.undelivered) delivery = { state: 'skipped', reason: 'unchanged' }
  // The board task's own session answering its own choice: it knows already.
  else if (caller.kind === 'task' && caller.taskId === boardTaskId) delivery = { state: 'skipped', reason: 'self' }
  else {
    const board = await getBoard(boardTaskId)
    const text = await picturesHeader(result.choice.images) + await buildChoicePrompt(board?.html ?? '', choiceId, result.choice)
    delivery = await deliverBoardText(boardTaskId, text, { choice: choiceId, option: result.choice.option },
      caller.kind === 'human' ? undefined : { callerSid: caller.sessionId })
    result.choice = await markChoiceDelivery(boardTaskId, choiceId, result.choice, delivery.state !== 'stored')
  }
  return { choice: result.choice, delivery }
}
