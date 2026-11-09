/**
 * Main's or a lead's Brief, the Markdown document its session edits itself any time
 * (src/core/sessions/brief-write.ts).
 *
 *   GET /api/v1/tasks/:id/brief  { task_id, title, brief: {text, at} | null, chars, limit, fresh, sections, rules }
 *   GET /api/v1/tasks/:id/brief?compact=1  { compact, brief: {at, chars}, fresh (each move with the letter's line),
 *        sections (only those a move touched), issues?, rules (a session's first read only) }  (brief-compact.ts)
 *   PUT /api/v1/tasks/:id/brief  { content } | { edits: [{ old, new }] }  ->  { brief, issues (lines to fix) }
 *
 * `brief.text_sources` says who wrote each part of the text (brief-source.ts). The writer of a PUT
 * is the request's caller (`x-walnut-caller-sid`), never anything its body says.
 *
 * `fresh` says what moved since it was written (brief-fresh.ts); `sections` are the team's open
 * work by section from the live statuses, the lists the letter is written from, and `rules` how to
 * write it (brief.ts briefRules). Any session may
 * write it, as may a person (2026-10-27, the user: "all human action can be done by agent also").
 */
import { Router, type Request, type Response } from 'express'
import { role } from '../../core/server-role.js'
import { BRIEF_MAX_CHARS } from '../../core/user-status.js'
import { briefFreshness, freshnessWords, liveWords } from '../../core/sessions/brief-fresh.js'
import { briefRules, briefSectionLines } from '../../core/sessions/brief.js'
import { briefOwnChars, briefWalnutLines } from '../../core/sessions/brief-structure.js'
import { briefVpLines, formatBriefIssues } from '../../core/sessions/brief-rules.js'
import { BriefWriteError, writeNodeBrief, type BriefEdit } from '../../core/sessions/brief-write.js'
import { compactBrief, noteRulesGiven, rulesDue } from '../../core/sessions/brief-compact.js'
import { briefSourcesOf, type BriefWriter } from '../../core/sessions/brief-source.js'
import { resolveBoardCaller } from '../../core/boards/board-team.js'
import { listTasks } from '../../core/task-manager.js'
import { getSessionByClaudeId } from '../../core/session-tracker.js'
import { log } from '../../logging/index.js'
import { body, header, param, resolveTask, RouteError } from './board-v1.js'
import { sendV1Error as sendError } from './v1-control-relay.js'
import { sendLinkFailure } from '../middleware/link-failure-answer.js'

export const briefV1Router = Router()

function route(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      if (err instanceof RouteError) return sendError(res, err.status, err.code, err.message, err.extra)
      if (err instanceof BriefWriteError) return sendError(res, err.status, err.code, err.message, err.extra)
      if (sendLinkFailure(req, res, err)) return
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
  const freshRaw = briefFreshness(task, tasks)
  const fresh = freshRaw ? { ...freshRaw, words: freshnessWords(freshRaw) } : null
  const node = task.org_role === 'main' || task.org_role === 'lead'
  const sections = node ? briefSectionLines(task, tasks) : null
  const lang = await uiLanguage()
  const issues = task.brief?.issues?.length ? formatBriefIssues(task.brief.issues) : undefined
  const ruleOpts = {
    hadBrief: !!task.brief, ownId: task.id, main: task.org_role === 'main', vps: briefVpLines(task, tasks),
    ...(issues ? { issues } : {}), ...(lang ? { language: lang } : {}),
  }
  // Who reads, as of its last compaction: a summary drops the rules it was given, so a session
  // past a compaction is a new reader of them (SessionRecord.lastCompactUuid).
  const callerSid = header(req, 'x-walnut-caller-sid')
  const sid = callerSid
    ? `${callerSid}#${(await getSessionByClaudeId(callerSid).catch(() => null))?.lastCompactUuid ?? ''}`
    : undefined
  // The rules' own wording (no live lists, no rule breaks, which compact sends on their own):
  // what a session that read them once already holds.
  const wording = sections ? briefRules({ ...ruleOpts, issues: undefined }) : ''
  // compact: what moved and the sections it touched; a node with no letter yet reads it all.
  if (wantsCompact(req.query.compact) && task.brief && sections) {
    const due = rulesDue(sid, task.id, wording)
    if (due) noteRulesGiven(sid, task.id, wording)
    res.json({
      task_id: task.id, title: task.title, limit: BRIEF_MAX_CHARS,
      ...compactBrief(task.brief, fresh, sections, (id) => {
        // A task past the lists' cap: its line in the lists' own form.
        const t = tasks.find((x) => x.id === id)
        return t ? `- <task-ref id="${t.id}" label="${t.title.replace(/\s+/g, ' ').trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}"/>: ${liveWords(t)}` : undefined
      }),
      ...(issues ? { issues } : {}),
      ...(due ? { rules: briefRules({ ...ruleOpts, sections }) } : {}),
    })
    return
  }
  if (sections) noteRulesGiven(sid, task.id, wording)
  res.json({
    task_id: task.id, title: task.title, brief: task.brief ? briefOut(task.brief) : null,
    chars: task.brief?.text.length ?? 0, own_chars: briefOwnChars(task.brief?.text ?? '', briefWalnutLines(task.brief, task, tasks)), limit: BRIEF_MAX_CHARS,
    fresh,
    sections,
    rules: sections ? briefRules({ ...ruleOpts, sections }) : null,
  })
}))

/** Who writes, from the request alone: no caller session is a person (the primary); a session Walnut
 *  knows is kept with its task when it has one; a header naming no known session is an unknown agent. */
async function briefWriter(callerSid: string | undefined): Promise<BriefWriter> {
  const sid = callerSid?.trim()
  if (!sid) return { by: 'human' }
  const caller = await resolveBoardCaller(sid).catch(() => null)
  if (caller?.kind === 'task') return { by: `task:${caller.taskId}`, sessionId: caller.sessionId }
  // Only a real session record names a machine; an unplaced header is just a string.
  if (caller?.kind === 'agent' && caller.untracked && caller.sessionId) return { by: 'agent', sessionId: caller.sessionId }
  return { by: 'agent' }
}

/** The letter as a reader gets it: its text, when, and who wrote each part (unknown on an older letter). */
function briefOut(brief: { text: string; at: string; text_sources?: unknown }): { text: string; at: string; text_sources: ReturnType<typeof briefSourcesOf> } {
  return { text: brief.text, at: brief.at, text_sources: briefSourcesOf(brief) }
}

function wantsCompact(q: unknown): boolean {
  return q === '1' || q === 'true'
}

briefV1Router.put('/tasks/:id/brief', route(async (req, res) => {
  if (role() === 'replica') throw new RouteError(501, 'not_supported_cloud', 'A Brief is written on the primary box')
  const task = await resolveTask(param(req.params.id))
  const b = body(req)
  const edits = Array.isArray(b.edits) ? (b.edits as BriefEdit[]) : undefined
  const content = typeof b.content === 'string' ? b.content : undefined
  if (content === undefined && !edits) throw new RouteError(400, 'bad_request', 'content (string) or edits ([{ old, new }]) is required')
  const lang = await uiLanguage()
  const callerSid = header(req, 'x-walnut-caller-sid')
  const out = await writeNodeBrief(task.id, { ...(content !== undefined ? { content } : {}), ...(edits ? { edits } : {}), ...(lang ? { language: lang } : {}) }, await briefWriter(callerSid))
  // Who reads, as of its last compaction: a summary drops the rules it was given, so a session
  // past a compaction is a new reader of them (SessionRecord.lastCompactUuid).
  const sid = callerSid
    ? `${callerSid}#${(await getSessionByClaudeId(callerSid).catch(() => null))?.lastCompactUuid ?? ''}`
    : undefined
  log.task.info('brief written', { taskId: task.id, by: sid ? 'session' : 'human', chars: out.brief.text.length, issues: out.issues.length })
  res.json({ task_id: task.id, title: task.title, brief: briefOut(out.brief), issues: formatBriefIssues(out.issues), chars: out.brief.text.length, own_chars: briefOwnChars(out.brief.text, out.brief.added), limit: BRIEF_MAX_CHARS })
}))
