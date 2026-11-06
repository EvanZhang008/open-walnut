/**
 * POST /api/test/task-fixture/hand-back {taskId, lastWords}: the Playwright fixture's way to make a
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
    const body = (req.body ?? {}) as { taskId?: unknown; lastWords?: unknown }
    if (typeof body.taskId !== 'string' || !body.taskId || typeof body.lastWords !== 'string' || !body.lastWords.trim()) {
      res.status(400).json({ error: 'taskId and lastWords: the task, and the words its last turn ended with' })
      return
    }
    const { getTask, updateTaskRaw } = await import('../../core/task-manager.js')
    const at = new Date().toISOString()
    // A task with a session keeps it (its conversation still opens); one without gets a stand-in id.
    const sid = (await getTask(body.taskId)).session_id || `fixture-${body.taskId}`
    await updateTaskRaw(body.taskId, {
      session_id: sid,
      phase: 'NEED_ACTION',
      phase_changed_at: at,
      last_words: { text: body.lastWords.slice(0, 2000), at, session_id: sid },
    }, { emitEvent: true, push: false, source: 'test-fixture' })
    res.json({ ok: true, at })
  } catch (err) {
    next(err)
  }
})
