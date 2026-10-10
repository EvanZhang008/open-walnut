/**
 * What the cloud companion changes on a live session through its host's own
 * daemon while it leads that host (docs/plan/walnut-control-plane.md "Model and
 * effort while the Mac is away", "Session controls while the Mac is away"):
 *
 *   leader.settings  model or effort: the CLI's `apply_flag_settings` line
 *   leader.control   mode: `set_permission_mode`, whose answer echoes the mode;
 *                    a permission answer: the control_response the server
 *                    writes for a pending can_use_tool
 *
 * The daemon writes the same line the server writes when it answers, and waits
 * for the CLI's control_response in the session's stream. The CLI ACKs any
 * flag value, so values are checked here first: a model id shape (the
 * companion already matched it against the catalog), a known effort, a known
 * mode, a permission answer of the shape the server takes.
 *
 * Text-injected into the source twin by fn.toString() (daemon-source.ts): no
 * imports, and nothing from module scope.
 */

export interface LiveSettingsDeps {
  /** Write one raw line to the session's stdin: 'ok' once the whole line went out. */
  writeLine: (sid: string, line: string) => Promise<'ok' | 'not_found' | 'dead' | 'failed'>
  randomHex: (bytes: number) => string
  now: () => number
  log: (level: 'info' | 'warn', msg: string, fields?: Record<string, unknown>) => void
}

export type LiveSettingsResult =
  | { ok: true; appliedLive: boolean; reason?: string; cliModel?: string; effort?: string }
  | { ok: false; error: string }

export type LiveModeResult =
  | { ok: true; appliedLive: boolean; reason?: string; mode: string }
  | { ok: false; error: string }

/** A can_use_tool the CLI is waiting on, as the daemon keeps it (pendingCtrl). */
export interface PendingPrompt { reqId: string; request: Record<string, unknown> }

export type PermissionAnswer =
  | { ok: true; line: string; allow: boolean }
  | { ok: false; error: string; code: 'bad_request' | 'not_found' }

export function createLiveSettings(deps: LiveSettingsDeps) {
  // A CLI --model value: an alias ('sonnet[1m]'), a catalog value, or a provider
  // id. The charset and length the server's resolveModelSwitchValue allows.
  const MODEL_RE = /^[A-Za-z0-9._:/[\]-]{1,256}$/
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
  // Walnut's mode id -> the CLI's permission mode (core/types.ts SESSION_MODES;
  // a test keeps the two equal).
  const MODES: Record<string, string> = {
    plan: 'plan', default: 'default', dontAsk: 'dontAsk', accept: 'acceptEdits', auto: 'auto', bypass: 'bypassPermissions',
  }
  const ACK_TIMEOUT_MS = 10_000
  const waiters = new Map<string, { sid: string; resolve: (resp: Record<string, unknown> | null) => void; timer: ReturnType<typeof setTimeout> }>()

  function settle(requestId: string, resp: Record<string, unknown> | null): void {
    const w = waiters.get(requestId)
    if (!w) return
    waiters.delete(requestId)
    clearTimeout(w.timer)
    w.resolve(resp)
  }

  /**
   * Write one control_request and wait for the CLI's answer: its `response`
   * object, or null when it did not answer in time. `wrote` says why nothing
   * was sent (no live CLI).
   */
  async function ask(sid: string, prefix: string, request: Record<string, unknown>, timeoutMs?: number): Promise<{ wrote: 'ok' | 'not_found' | 'dead' | 'failed'; requestId: string; response: Record<string, unknown> | null }> {
    const requestId = prefix + deps.now().toString(36) + '-' + deps.randomHex(4)
    const answered = new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = setTimeout(() => settle(requestId, null), timeoutMs ?? ACK_TIMEOUT_MS)
      waiters.set(requestId, { sid, resolve, timer })
    })
    const line = JSON.stringify({ type: 'control_request', request_id: requestId, request })
    const wrote = await deps.writeLine(sid, line).catch(() => 'failed' as const)
    if (wrote !== 'ok') {
      settle(requestId, null)
      return { wrote, requestId, response: null }
    }
    return { wrote, requestId, response: await answered }
  }

  async function apply(sid: string, raw: { model?: unknown; effort?: unknown }, timeoutMs?: number): Promise<LiveSettingsResult> {
    const settings: Record<string, string> = {}
    if (raw.model !== undefined) {
      if (typeof raw.model !== 'string' || !MODEL_RE.test(raw.model)) return { ok: false, error: 'model must be a CLI model value' }
      settings.model = raw.model
    }
    if (raw.effort !== undefined) {
      if (typeof raw.effort !== 'string' || EFFORTS.indexOf(raw.effort) === -1) return { ok: false, error: 'effort must be one of ' + EFFORTS.join('/') }
      settings.effortLevel = raw.effort
    }
    if (!settings.model && !settings.effortLevel) return { ok: false, error: 'model or effort is required' }
    const kept = { ...(settings.model ? { cliModel: settings.model } : {}), ...(settings.effortLevel ? { effort: settings.effortLevel } : {}) }

    const r = await ask(sid, 'lds-', { subtype: 'apply_flag_settings', settings }, timeoutMs)
    if (r.wrote !== 'ok') {
      // No CLI to tell now: the server keeps the values for the next spawn.
      deps.log('info', 'leader.settings: no live CLI, kept for the next spawn', { sid, reason: r.wrote, ...kept })
      return { ok: true, appliedLive: false, reason: r.wrote, ...kept }
    }
    const ok = r.response !== null && r.response.subtype !== 'error'
    deps.log(ok ? 'info' : 'warn', ok ? 'leader.settings: applied live' : 'leader.settings: the CLI did not answer', { sid, requestId: r.requestId, ...kept })
    return { ok: true, appliedLive: ok, ...(ok ? {} : { reason: 'no_answer' }), ...kept }
  }

  /**
   * A permission mode for a live session: the CLI's set_permission_mode, whose
   * answer echoes the mode it now runs in. With no live CLI the mode is kept
   * for the next spawn (the server keeps it on the record).
   */
  async function setMode(sid: string, mode: unknown, timeoutMs?: number): Promise<LiveModeResult> {
    if (typeof mode !== 'string' || !Object.prototype.hasOwnProperty.call(MODES, mode)) {
      return { ok: false, error: 'mode must be one of ' + Object.keys(MODES).join('/') }
    }
    const cliMode = MODES[mode]
    const r = await ask(sid, 'ldm-', { subtype: 'set_permission_mode', mode: cliMode }, timeoutMs)
    if (r.wrote !== 'ok') {
      deps.log('info', 'leader.control: no live CLI, the mode is kept for the next spawn', { sid, reason: r.wrote, mode })
      return { ok: true, appliedLive: false, reason: r.wrote, mode }
    }
    if (r.response === null) {
      deps.log('warn', 'leader.control: the CLI did not answer the mode change', { sid, requestId: r.requestId, mode })
      return { ok: true, appliedLive: false, reason: 'no_answer', mode }
    }
    const inner = r.response.response as Record<string, unknown> | undefined
    const echoed = inner && typeof inner.mode === 'string' ? inner.mode : null
    if (r.response.subtype === 'error' || echoed !== cliMode) {
      const why = typeof r.response.error === 'string' ? r.response.error : 'it answered ' + String(echoed)
      deps.log('warn', 'leader.control: the CLI refused the mode', { sid, requestId: r.requestId, mode, why })
      return { ok: false, error: 'the session did not take the mode ' + mode + ' (' + why + ')' }
    }
    deps.log('info', 'leader.control: mode applied live', { sid, requestId: r.requestId, mode })
    return { ok: true, appliedLive: true, mode }
  }

  /**
   * The control_response line answering a pending can_use_tool, the same line
   * the server writes (claude-code-session.ts respondToControlRequest): allow
   * carries the tool input (with the user's answers for AskUserQuestion), deny
   * carries the message. Null pending, or another request id: nothing to answer.
   */
  function permissionAnswer(pending: PendingPrompt | null, raw: { requestId?: unknown; allow?: unknown; message?: unknown; answers?: unknown }): PermissionAnswer {
    if (typeof raw.requestId !== 'string' || !raw.requestId || typeof raw.allow !== 'boolean') {
      return { ok: false, error: 'requestId (string) and allow (boolean) are required', code: 'bad_request' }
    }
    if (raw.message !== undefined && typeof raw.message !== 'string') return { ok: false, error: 'message must be a string', code: 'bad_request' }
    let answers: Record<string, string> | null = null
    if (raw.answers !== undefined) {
      if (typeof raw.answers !== 'object' || raw.answers === null || Array.isArray(raw.answers)) {
        return { ok: false, error: 'answers must be an object mapping question to answer string', code: 'bad_request' }
      }
      const entries = Object.entries(raw.answers as Record<string, unknown>)
      for (const [, value] of entries) {
        if (typeof value !== 'string') return { ok: false, error: 'answers values must be strings', code: 'bad_request' }
      }
      if (entries.length > 0) answers = raw.answers as Record<string, string>
    }
    if (!pending || pending.reqId !== raw.requestId || pending.request.subtype !== 'can_use_tool') {
      return { ok: false, error: 'Permission request not found or already resolved', code: 'not_found' }
    }
    const input = (pending.request.input && typeof pending.request.input === 'object' ? pending.request.input : {}) as Record<string, unknown>
    const result = raw.allow
      ? { behavior: 'allow', updatedInput: answers ? { ...input, answers } : input }
      : { behavior: 'deny', message: typeof raw.message === 'string' ? raw.message : 'User denied permission' }
    const line = JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: pending.reqId, response: result } })
    return { ok: true, line, allow: raw.allow }
  }

  /** A control_response line in a session's stream: settles a request this daemon sent. */
  function noteResponse(sid: string, parsed: Record<string, unknown>): void {
    const resp = parsed.response as Record<string, unknown> | undefined
    const requestId = resp && typeof resp.request_id === 'string' ? resp.request_id : ''
    const w = requestId ? waiters.get(requestId) : undefined
    if (!w || w.sid !== sid) return
    settle(requestId, resp ?? null)
  }

  return { apply, setMode, permissionAnswer, noteResponse, pending: () => waiters.size, modes: () => ({ ...MODES }) }
}

export type LiveSettings = ReturnType<typeof createLiveSettings>
