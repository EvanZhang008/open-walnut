/**
 * Engines route — the coding-agent engine catalog the web UI renders its engine
 * toggle, model picker and local-only locks from.
 *
 * NOT /api/providers: `/api/config/providers` already means "AI credential
 * status" (bedrock/anthropic keys). This endpoint answers a different question,
 * "which session engines exist and can this host run them".
 *
 * Everything except `availability` is static registry data, so a probe that is
 * slow or throws degrades the availability block only — the catalog still
 * renders. The probe carries its own deadline (see engine-probe.probeEngines),
 * which is what makes it safe on the request path.
 */

import { Router, type Request, type Response } from 'express'
import { ENGINE_REGISTRY, DEFAULT_ENGINE, engineCaps, type EngineCapabilities } from '../../core/agents/engine-registry.js'
import type { SessionEngine } from '../../core/types.js'
import { probeEngines, type EngineAvailability } from '../../core/agents/engine-probe.js'
import {
  EngineSettingsError,
  readEngineSettings,
  validateCwd,
  writeEngineSettings,
  type EngineSettingsContext,
  type EngineSettingsPatch,
  type SettingsFileTransport,
} from '../../core/agents/engine-settings-service.js'
import { DaemonFileReader, DaemonNeedsUpgradeError } from '../../core/daemon-file-reader.js'
import { getConfig } from '../../core/config-manager.js'
import { log } from '../../logging/index.js'

export const enginesRouter = Router()

/** Availability used when the probe itself failed: honest, and never a hard error. */
const PROBE_UNKNOWN: EngineAvailability = { installed: false, version: null, reason: 'availability check unavailable' }

function toCatalogEntry(caps: EngineCapabilities, availability: EngineAvailability) {
  return {
    id: caps.id,
    displayName: caps.displayName,
    runtimeKind: caps.runtimeKind,
    isDefault: caps.id === DEFAULT_ENGINE,
    // Every ACP engine runs on another host through that host's daemon
    // (providers/acp-host-artifacts.ts), except one whose adapter command is this
    // machine's config. Whether a host has the CLI: GET /availability?host=.
    localOnly: caps.acpAdapter?.source === 'config',
    capabilities: {
      rewind: caps.rewind !== 'unsupported',
      fork: caps.fork,
      modelCatalog: caps.modelCatalog,
      modeControl: caps.modeControl,
      idProvisioning: caps.idProvisioning,
      // Whether GET/PATCH /api/engines/:id/settings answers for this engine.
      settings: caps.settings !== undefined,
      // Whether GET/POST /api/engines/:id/claude-code-import answers (Settings, Sessions).
      claudeCodeImport: caps.claudeCodeImport === true,
    },
    availability,
  }
}

// GET /api/engines — full catalog + per-engine availability.
enginesRouter.get('/', async (_req: Request, res: Response) => {
  let availability = new Map<string, EngineAvailability>()
  try {
    availability = await probeEngines()
  } catch (err) {
    // A catalog without availability is still useful; a 500 blanks the UI's
    // engine toggle entirely.
    log.web.warn('engine availability probe failed', { error: err instanceof Error ? err.message : String(err) })
  }
  const engines = [...ENGINE_REGISTRY.values()].map((caps) => toCatalogEntry(caps, availability.get(caps.id) ?? PROBE_UNKNOWN))
  res.json({ engines })
})

// GET /api/engines/availability?host=<key> — which engines that host can run
// (core/agents/host-engines.ts): an engine missing there is greyed out in the
// picker. Answers within the host probe's deadline; an engine the host did not
// report in time is absent (unknown), never "not installed".
enginesRouter.get('/availability', async (req: Request, res: Response) => {
  const host = typeof req.query.host === 'string' && req.query.host ? req.query.host : '__local__'
  try {
    const { hostEnginesAvailability } = await import('../../core/agents/host-engines.js')
    res.json({ host, engines: await hostEnginesAvailability(host, { dial: false }) })
  } catch (err) {
    log.web.warn('host engine availability failed', { host, error: err instanceof Error ? err.message : String(err) })
    res.json({ host, engines: {} })
  }
})

// GET /api/engines/:id/models — the engine's provider-advertised model catalog
// for DRAFT surfaces (no session exists yet to ask). One-shot adapter probe
// behind a cache; the probe module owns the deadline, so this route can never
// hang past it. Claude is a deliberate 404: its catalog rides the host-level
// model-catalog pipeline, not ACP.
enginesRouter.get('/:id/models', async (req: Request, res: Response) => {
  const id = String(req.params.id) as SessionEngine
  const caps = ENGINE_REGISTRY.get(id)
  if (!caps || caps.runtimeKind !== 'acp') {
    res.status(404).json({ error: `no provider model catalog for engine '${id}'` })
    return
  }
  // Draft folder: opencode/goose resolve provider+model config per project,
  // so the probe must run where the launch will (nonexistent dir → $HOME).
  const rawCwd = req.query.cwd
  const cwd = typeof rawCwd === 'string' && rawCwd.trim() && rawCwd.length <= 1024
    ? rawCwd.trim()
    : undefined
  // ?refresh=1 — the picker's "Retry": a cached failure (45s TTL) must not
  // outlive the operator's fix, so a retry click re-probes immediately.
  const refresh = req.query.refresh === '1'
  try {
    const { getEngineModelCatalog } = await import('../../providers/engine-model-probe.js')
    const catalog = await getEngineModelCatalog(id, { cwd, refresh })
    res.json(catalog)
  } catch (err) {
    // Honest degrade: "couldn't list" with the adapter's own words (missing
    // credentials, not installed) beats an empty list pretending to be one.
    const message = err instanceof Error ? err.message : String(err)
    log.web.warn('engine model catalog probe failed', { engine: id, error: message })
    res.status(502).json({ error: message, engine: id })
  }
})

// ── Engine settings: the engine's OWN config files on a host ──
//
// GET  /api/engines/:id/settings?host=&cwd=&sessionId=&scope=   → EngineSettingsView
// PATCH /api/engines/:id/settings?host=&cwd=&sessionId=&scope=  {set, unset} → EngineSettingsView + changed
//
// `sessionId` names a Walnut session: its host and working directory become the
// defaults (a composer asks about the session it sits in). `cwd` unlocks the
// project layers; `scope` ('default' | 'project') picks where a write goes.
//
// The daemon on the host does the file I/O (host-local work belongs to the
// daemon); the service owns parsing and the read-modify-write. This route only
// validates the host, wires the transport and maps errors to honest statuses.

/** Every daemon round trip here is one small file, but a remote connect can stall; the route answers 504, never hangs. */
const ENGINE_SETTINGS_DEADLINE_MS = 20_000

const LOCAL_HOST = '__local__'

async function resolveHostParam(raw: unknown): Promise<string | null> {
  const host = typeof raw === 'string' && raw.trim() ? raw.trim() : LOCAL_HOST
  if (host === LOCAL_HOST) return host
  const config = await getConfig()
  // Own keys only: `hosts['__proto__']` and `hosts['toString']` are truthy too.
  return Object.hasOwn(config.hosts ?? {}, host) ? host : null
}

type SettingsTarget = { host: string; ctx: EngineSettingsContext }

/**
 * Host + working directory + scope for one request. A `sessionId` supplies the
 * session's own host and cwd, so the composer never has to know either; explicit
 * `host` / `cwd` params still win (a Settings page that picks a host by hand).
 * Returns the 400 text instead of a target when a param is unusable.
 */
async function resolveSettingsTarget(query: Request['query']): Promise<SettingsTarget | { error: string }> {
  let sessionHost: string | undefined
  let sessionCwd: string | undefined
  const sessionId = typeof query.sessionId === 'string' ? query.sessionId.trim().slice(0, 200) : ''
  if (sessionId) {
    const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
    const session = await getSessionByClaudeId(sessionId)
    if (!session) return { error: `unknown session '${sessionId}'` }
    sessionHost = session.host || undefined
    sessionCwd = session.cwd || undefined
  }
  const hostRaw = typeof query.host === 'string' && query.host.trim() ? query.host.trim() : sessionHost
  const host = await resolveHostParam(hostRaw)
  if (!host) return { error: `unknown host '${String(hostRaw)}'` }
  const cwdRaw = typeof query.cwd === 'string' && query.cwd.trim() ? query.cwd.trim() : sessionCwd
  let cwd: string | undefined
  if (cwdRaw !== undefined) {
    const valid = validateCwd(cwdRaw)
    if (!valid) return { error: 'cwd must be an absolute path without ".." segments' }
    cwd = valid
  }
  const scopeRaw = typeof query.scope === 'string' && query.scope.trim() ? query.scope.trim() : 'default'
  if (scopeRaw !== 'default' && scopeRaw !== 'project') return { error: "scope must be 'default' or 'project'" }
  return { host, ctx: { ...(cwd ? { cwd } : {}), scope: scopeRaw } }
}

function daemonTransport(host: string): SettingsFileTransport {
  const reader = new DaemonFileReader(host)
  return {
    read: (p, maxBytes) => reader.readFileBytes(p, maxBytes),
    writeAtomic: (p, text, expectSha256) => reader.writeFileAtomic(p, text, expectSha256),
    ensureGitExcluded: (cwd, p) => reader.ensureGitExcluded(cwd, p),
    // The local daemon inherits this process's environment, so overrides such
    // as DISABLE_AUTOUPDATER can be reported truthfully. A remote host's
    // environment is not visible from here; the view says so (envChecked:false).
    ...(host === LOCAL_HOST ? { env: process.env } : {}),
  }
}

class EngineSettingsTimeout extends Error {}

function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EngineSettingsTimeout(`${what} did not answer within ${Math.round(ms / 1000)}s`)), ms)
    p.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
  })
}

/**
 * Every failure names its `outcome` so the client can tell "your change was
 * refused" (safe to put the control back) from "the file may have changed
 * anyway" (a deadline that fired after the daemon renamed the file, a read-back
 * that failed after a successful write). Reverting a control on the second kind
 * shows the opposite of what is on disk.
 */
function answerEngineSettingsError(res: Response, err: unknown, ctx: Record<string, unknown>): void {
  if (err instanceof EngineSettingsError) {
    res.status(err.status).json({ error: err.message, outcome: err.outcome })
    return
  }
  if (err instanceof DaemonNeedsUpgradeError) {
    res.status(501).json({ error: err.message, code: 'daemon_needs_upgrade', outcome: 'not-written' })
    return
  }
  if (err instanceof EngineSettingsTimeout) {
    res.status(504).json({ error: err.message, code: 'host_unreachable', outcome: 'unknown' })
    return
  }
  const message = err instanceof Error ? err.message : String(err)
  log.web.warn('engine settings request failed', { ...ctx, error: message })
  res.status(502).json({ error: message, outcome: 'unknown' })
}

// A draft previews the same host/project default the native launch will read.
// A classifier-refusal recovery waits for the CLI confirmation before changing
// the durable mode. The ordinary picker keeps its existing next-turn contract.
enginesRouter.post('/:id/recover-permission', async (req: Request, res: Response) => {
  const caps = ENGINE_REGISTRY.get(String(req.params.id) as SessionEngine)
  if (caps?.modeControl !== 'claude-modes') { res.status(400).json({ error: 'This engine has no Auto permission mode' }); return }
  const sid = typeof req.body?.sessionId === 'string' ? req.body.sessionId : ''
  const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
  const record = await getSessionByClaudeId(sid)
  if (!record) { res.status(404).json({ error: 'Session not found' }); return }
  if (engineCaps(record.engine).modeControl !== 'claude-modes' || record.mode !== 'auto' || !record.autoPermissionDenial) {
    res.status(409).json({ error: 'This session has no Auto classifier refusal to recover' }); return
  }
  try {
    const { sessionRunner } = await import('../../providers/claude-code-session.js')
    const applied = await withDeadline(sessionRunner.changePermissionMode(sid, 'default'), 20000, 'The permission mode change')
    if (applied === 'not-live') throw new Error('The live session is unavailable. Start it again, then switch its mode.')
    const { persistSessionModeChange } = await import('../../core/sessions/session-lifecycle.js')
    const session = await persistSessionModeChange(record, sid, 'default')
    res.json({ session })
  } catch (err) { res.status(409).json({ error: err instanceof Error ? err.message : String(err) }) }
})

enginesRouter.get('/:id/launch-mode', async (req: Request, res: Response) => {
  const caps = ENGINE_REGISTRY.get(String(req.params.id) as SessionEngine)
  if (caps?.modeControl !== 'claude-modes') { res.json({ mode: 'default', source: 'engine' }); return }
  const target = await resolveSettingsTarget(req.query)
  if ('error' in target) { res.status(400).json({ error: target.error }); return }
  const { resolveClaudeLaunchMode } = await import('../../providers/claude-launch-mode.js')
  res.json(await resolveClaudeLaunchMode(target.host, target.ctx.cwd))
})

enginesRouter.get('/:id/settings', async (req: Request, res: Response) => {
  const engine = String(req.params.id)
  const target = await resolveSettingsTarget(req.query)
  if ('error' in target) {
    res.status(400).json({ error: target.error, outcome: 'not-written' })
    return
  }
  const { host, ctx } = target
  try {
    const view = await withDeadline(readEngineSettings(engine, host, daemonTransport(host), ctx), ENGINE_SETTINGS_DEADLINE_MS, `the daemon on ${host}`)
    res.json(view)
  } catch (err) {
    answerEngineSettingsError(res, err, { engine, host, cwd: ctx.cwd, op: 'read' })
  }
})

enginesRouter.patch('/:id/settings', async (req: Request, res: Response) => {
  const engine = String(req.params.id)
  const target = await resolveSettingsTarget(req.query)
  if ('error' in target) {
    res.status(400).json({ error: target.error, outcome: 'not-written' })
    return
  }
  const { host, ctx } = target
  const body = (req.body ?? {}) as EngineSettingsPatch
  try {
    const view = await withDeadline(writeEngineSettings(engine, host, body, daemonTransport(host), ctx), ENGINE_SETTINGS_DEADLINE_MS, `the daemon on ${host}`)
    log.web.info('engine settings updated', { engine, host, cwd: ctx.cwd, scope: ctx.scope, changed: view.changed, gitExclude: view.gitExclude })
    res.json(view)
  } catch (err) {
    answerEngineSettingsError(res, err, { engine, host, cwd: ctx.cwd, scope: ctx.scope, op: 'write' })
  }
})

// ── Import from Claude Code (claude-code-import.ts) ──
//
// GET  /api/engines/:id/claude-code-import?host=   → ImportPreview: what the import brings, what cannot carry over
// POST /api/engines/:id/claude-code-import?host=   → { written, preview }
//
// The daemon on the host reads Claude Code's files and writes pi's; Claude Code's
// files are only read. A host that cannot be reached answers 504, never hangs.

/** A preview reads a few dozen small files in parallel rounds; the deadline covers a slow remote. */
const CLAUDE_IMPORT_DEADLINE_MS = 30_000

function importTransport(host: string): import('../../core/agents/claude-code-import.js').ImportTransport {
  const reader = new DaemonFileReader(host)
  return {
    readBytes: (p, maxBytes) => reader.readFileBytes(p, maxBytes),
    listDir: (p) => reader.listDirStrict(p),
    writeAtomic: (p, text, expectSha256) => reader.writeFileAtomic(p, text, expectSha256),
    ...(host === LOCAL_HOST ? { env: process.env } : {}),
  }
}

async function claudeImportTarget(req: Request, res: Response): Promise<{ engine: string; host: string } | null> {
  const engine = String(req.params.id)
  const caps = ENGINE_REGISTRY.get(engine as SessionEngine)
  if (!caps?.claudeCodeImport) {
    res.status(404).json({ error: `engine '${engine}' has no Claude Code import` })
    return null
  }
  const host = await resolveHostParam(req.query.host)
  if (!host) {
    res.status(400).json({ error: `unknown host '${String(req.query.host)}'` })
    return null
  }
  return { engine, host }
}

async function piInstallOn(host: string) {
  const { hostEngineAvailability } = await import('../../core/agents/host-engines.js')
  const { piInstallFrom } = await import('../../core/agents/claude-code-import.js')
  return piInstallFrom(await hostEngineAvailability(host, 'pi').catch(() => null))
}

function answerImportError(res: Response, err: unknown, ctx: { op: 'preview' | 'apply' } & Record<string, unknown>, ImportError: new (...args: never[]) => Error & { status: number }): void {
  if (err instanceof ImportError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  if (err instanceof DaemonNeedsUpgradeError) {
    res.status(501).json({ error: err.message, code: 'daemon_needs_upgrade' })
    return
  }
  if (err instanceof EngineSettingsTimeout) {
    // A deadline does not cancel writes already sent: an import may still land after it.
    res.status(504).json(ctx.op === 'apply'
      ? { error: `${err.message} The import may still have been written: check again to see.`, code: 'host_unreachable', outcome: 'unknown' }
      : { error: err.message, code: 'host_unreachable' })
    return
  }
  const message = err instanceof Error ? err.message : String(err)
  log.web.warn('claude code import failed', { ...ctx, error: message })
  res.status(502).json({ error: message })
}

enginesRouter.get('/:id/claude-code-import', async (req: Request, res: Response) => {
  const target = await claudeImportTarget(req, res)
  if (!target) return
  const mod = await import('../../core/agents/claude-code-import.js')
  try {
    const pi = await piInstallOn(target.host)
    const preview = await withDeadline(mod.previewClaudeCodeImport(target.host, importTransport(target.host), pi), CLAUDE_IMPORT_DEADLINE_MS, `the daemon on ${target.host}`)
    res.json(preview)
  } catch (err) {
    answerImportError(res, err, { ...target, op: 'preview' }, mod.ClaudeCodeImportError)
  }
})

enginesRouter.post('/:id/claude-code-import', async (req: Request, res: Response) => {
  const target = await claudeImportTarget(req, res)
  if (!target) return
  const mod = await import('../../core/agents/claude-code-import.js')
  try {
    const pi = await piInstallOn(target.host)
    const result = await withDeadline(mod.applyClaudeCodeImport(target.host, importTransport(target.host), pi), CLAUDE_IMPORT_DEADLINE_MS, `the daemon on ${target.host}`)
    log.web.info('claude code import applied', { ...target, written: result.written })
    res.json(result)
  } catch (err) {
    answerImportError(res, err, { ...target, op: 'apply' }, mod.ClaudeCodeImportError)
  }
})

// GET /api/engines/fallback?host=<key>[&limit=1][&project=<name>] — would a new task that names no engine start on the
// fallback engine right now (core/agents/fallback-engine.ts)? The draft says so above its composer.
// `limit` is the default engine's limit in force on that host, `fallback` the decision, `skip` why
// a fallback that is set does not take new tasks now.
enginesRouter.get('/fallback', async (req: Request, res: Response) => {
  const raw = typeof req.query.host === 'string' && req.query.host ? req.query.host : undefined
  const host = raw && raw !== '__local__' && raw !== 'local' ? raw : undefined
  try {
    const config = await getConfig()
    const { resolveDefaultEngine } = await import('../../core/agents/default-engine.js')
    const { engineLimitNow, explainFallbackLaunch, fallbackDeps, fallbackSetting } = await import('../../core/agents/fallback-engine.js')
    // A project whose launch defaults name its engine: that engine is the default of its launches.
    const project = typeof req.query.project === 'string' && req.query.project.trim() ? req.query.project : undefined
    const { inheritedEnginePick, projectLaunchDefaultsOf } = await import('../../core/sessions/project-launch-defaults.js')
    const defaultEngine = project
      ? (await inheritedEnginePick(config, await projectLaunchDefaultsOf(project), host)).engine
      : resolveDefaultEngine(config, { host })
    const setting = fallbackSetting(config)
    // Nothing set and no one asked for the limit itself (only Settings does, ?limit=1): no reads.
    if (!setting && req.query.limit !== '1') { res.json({ host: host ?? '__local__', defaultEngine, setting: null, fallback: null }); return }
    const explained = setting ? await explainFallbackLaunch(config, defaultEngine, host, { quiet: true }) : null
    const decision = explained?.decision ?? null
    const limit = decision ? null : explained ? explained.limit : await engineLimitNow(defaultEngine, host, fallbackDeps())
    res.json({
      host: host ?? '__local__', defaultEngine, setting,
      fallback: decision ? { engine: decision.engine, ...(decision.model ? { model: decision.model } : {}), note: decision.note } : null,
      ...(limit ? { limit: { ...limit, ...(limit.resetsAt ? { resetsAt: new Date(limit.resetsAt).toISOString() } : {}) } } : {}),
      // Why a fallback that is set does not take new tasks now (Settings says so under the row).
      ...(explained?.skip ? { skip: explained.skip } : {}),
    })
  } catch (err) {
    log.web.warn('fallback engine read failed', { host, error: err instanceof Error ? err.message : String(err) })
    res.json({ host: host ?? '__local__', fallback: null })
  }
})

// POST /api/engines/fallback/dismiss {taskId} — the user closed a task's "started on the fallback
// engine" note (the session panel's banner): it is taken off the task.
enginesRouter.post('/fallback/dismiss', async (req: Request, res: Response) => {
  const taskId = typeof (req.body as { taskId?: unknown } | undefined)?.taskId === 'string' ? (req.body as { taskId: string }).taskId : ''
  if (!taskId) { res.status(400).json({ error: 'taskId is required' }); return }
  try {
    const { updateTaskRaw } = await import('../../core/task-manager.js')
    const out = await updateTaskRaw(taskId, (t) => (t.engine_fallback ? { engine_fallback: null } : null), { source: 'engine-fallback-dismiss', emitEvent: true })
    res.json({ ok: true, changed: out.changed })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(/No task|not found/i.test(message) ? 404 : 500).json({ error: message })
  }
})
