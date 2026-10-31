/**
 * Main's or a lead's Brief, the Markdown document its session edits itself any time
 * (src/core/sessions/brief-write.ts).
 *
 *   GET /api/v1/tasks/:id/brief  { task_id, title, brief: {text, at} | null, chars, limit, fresh, sections, rules }
 *   PUT /api/v1/tasks/:id/brief  { content } | { edits: [{ old, new }] }  ->  { brief, issues (lines to fix) }
 *
 * `fresh` says what moved since it was written (brief-fresh.ts); `sections` are the team's open
 * work by section from the live statuses, the lists the letter is written from, and `rules` how to
 * write it (brief.ts briefRules). Any session may
 * write it, as may a person (2026-10-27, the user: "all human action can be done by agent also").
 */
import { Router, type Request, type Response } from 'express'
import { role } from '../../core/server-role.js'
import { BRIEF_MAX_CHARS } from '../../core/user-status.js'
import { briefFreshness, freshnessWords } from '../../core/sessions/brief-fresh.js'
import { briefRules, briefSectionLines } from '../../core/sessions/brief.js'
import { briefVpLines, formatBriefIssues } from '../../core/sessions/brief-rules.js'
import { BriefWriteError, writeNodeBrief, type BriefEdit } from '../../core/sessions/brief-write.js'
import { listTasks } from '../../core/task-manager.js'
import { log } from '../../logging/index.js'
import { body, header, param, resolveTask, RouteError } from './board-v1.js'
import { sendV1Error as sendError } from './v1-control-relay.js'

export const briefV1Router = Router()

function route(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      if (err instanceof RouteError) return sendError(res, err.status, err.code, err.message, err.extra)
      if (err instanceof BriefWriteError) return sendError(res, err.status, err.code, err.message, err.extra)
      sendError(res, 500, 'internal', err instanceof Error ? err.message : String(err))
    })
  }
}

/** The user's reply language by name ("Chinese"), or undefined for English. */
async function uiLanguage(): Promise<string | undefined> {
  const { configuredUiLanguage, nonEnglishUiLanguage, uiLanguageName } = await import('../../core/ui-language.js')
  const lang = nonEnglishUiLanguage(await configuredUiLanguage().catch(() => undefined))
  return lang ? uiLanguageName(lang) : undefined
}

briefV1Router.get('/tasks/:id/brief', route(async (req, res) => {
  const task = await resolveTask(param(req.params.id))
  const tasks = await listTasks()
  const fresh = briefFreshness(task, tasks)
  const node = task.org_role === 'main' || task.org_role === 'lead'
  const sections = node ? briefSectionLines(task, tasks) : null
  const lang = await uiLanguage()
  res.json({
    task_id: task.id, title: task.title, brief: task.brief ? { text: task.brief.text, at: task.brief.at } : null,
    chars: task.brief?.text.length ?? 0, limit: BRIEF_MAX_CHARS,
    fresh: fresh ? { ...fresh, words: freshnessWords(fresh) } : null,
    sections,
    rules: sections ? briefRules({
      hadBrief: !!task.brief, ownId: task.id, main: task.org_role === 'main', vps: briefVpLines(task, tasks), sections,
      ...(task.brief?.issues?.length ? { issues: formatBriefIssues(task.brief.issues) } : {}), ...(lang ? { language: lang } : {}),
    }) : null,
  })
}))

briefV1Router.put('/tasks/:id/brief', route(async (req, res) => {
  if (role() === 'replica') throw new RouteError(501, 'not_supported_cloud', 'A Brief is written on the primary box')
  const task = await resolveTask(param(req.params.id))
  const b = body(req)
  const edits = Array.isArray(b.edits) ? (b.edits as BriefEdit[]) : undefined
  const content = typeof b.content === 'string' ? b.content : undefined
  if (content === undefined && !edits) throw new RouteError(400, 'bad_request', 'content (string) or edits ([{ old, new }]) is required')
  const lang = await uiLanguage()
  const out = await writeNodeBrief(task.id, { ...(content !== undefined ? { content } : {}), ...(edits ? { edits } : {}), ...(lang ? { language: lang } : {}) })
  const sid = header(req, 'x-walnut-caller-sid')
  log.task.info('brief written', { taskId: task.id, by: sid ? 'session' : 'human', chars: out.brief.text.length, issues: out.issues.length })
  res.json({ task_id: task.id, title: task.title, brief: { text: out.brief.text, at: out.brief.at }, issues: formatBriefIssues(out.issues), chars: out.brief.text.length, limit: BRIEF_MAX_CHARS })
}))
