/**
 * POST /api/test/task-fixture/hand-back {taskId, lastWords?, sessionId?}: the Playwright fixture's way to make a
 * task look handed back by its session, with the words its last turn ended with. Walnut reads those
 * from the session's transcript (src/core/sessions/last-words.ts), and the fixture's mock CLI keeps
 * none, so a spec that shows them (the side panel's ask rows) seeds them here: the task gets a
 * session id when it has none, NEED_ACTION and `last_words` read after that move, and the status
 * sync derives its status from them as it does for a real hand-back. Mounted ONLY when WALNUT_TEST_TASK_FIXTURE=1 on
 * an ephemeral, non-cloud server (taskFixtureRouteAllowed: the fixture server,
 * tests/e2e/browser/test-server.ts).
 */
import { Router } from 'express'

export function taskFixtureRouteAllowed(opts: { env: Record<string, string | undefined>; ephemeral: boolean; cloudMode: boolean }): boolean {
  return opts.env.WALNUT_TEST_TASK_FIXTURE === '1' && opts.ephemeral && !opts.cloudMode
}

export const testTaskFixtureRouter = Router()

testTaskFixtureRouter.post('/hand-back', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { taskId?: unknown; lastWords?: unknown; sessionId?: unknown }
    // `sessionId`: the conversation it is handed back from (a lane session whose chat lives in chat
    // history, say), with or without words Walnut read of it.
    const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : ''
    const words = typeof body.lastWords === 'string' ? body.lastWords.trim() : ''
    if (typeof body.taskId !== 'string' || !body.taskId || (!words && !sessionId)) {
      res.status(400).json({ error: 'taskId and lastWords (or sessionId): the task, and the words its last turn ended with' })
      return
    }
    const { getTask, updateTaskRaw } = await import('../../core/task-manager.js')
    const at = new Date().toISOString()
    // A task with a session keeps it (its conversation still opens); one without gets a stand-in id.
    const sid = sessionId || (await getTask(body.taskId)).session_id || `fixture-${body.taskId}`
    await updateTaskRaw(body.taskId, {
      session_id: sid,
      phase: 'NEED_ACTION',
      phase_changed_at: at,
      ...(words ? { last_words: { text: (body.lastWords as string).slice(0, 2000), at, session_id: sid } } : {}),
    }, { emitEvent: true, push: false, source: 'test-fixture' })
    // The conversation's session record names this task back, as a lane promoted to an ask does
    // (lane-ask-link.ts): its panel then reads and marks this task, not the ask the boot pass filed
    // for the chat. Give it a session no other spec opens.
    if (sessionId) {
      const { getSessionByClaudeId, linkSessionToTask } = await import('../../core/session-tracker.js')
      const record = await getSessionByClaudeId(sessionId)
      if (record && record.taskId !== body.taskId) await linkSessionToTask(sessionId, body.taskId)
    }
    res.json({ ok: true, at })
  } catch (err) {
    next(err)
  }
})
