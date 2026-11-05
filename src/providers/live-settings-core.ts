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
  | { ok: true; line: string; allow: boolean; duplicate?: undefined }
  /** The same prompt answered here before (a retry after a lost answer): nothing to write. */
  | { ok: true; duplicate: true; allow: boolean }
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
  /**
   * Prompts answered here, by session and request id, so an answer asked again after
   * its reply was lost (a replica's retry) is told it was answered, not "not found".
   * A request id names one prompt, so an old entry never answers a new prompt.
   */
  const answered = new Map<string, boolean>()
  const ANSWERED_CAP = 200
  function noteAnswered(sid: string, requestId: string, allow: boolean): void {
    const key = `${sid}\n${requestId}`
    answered.delete(key)
    answered.set(key, allow)
    while (answered.size > ANSWERED_CAP) answered.delete(answered.keys().next().value as string)
  }

  /**
   * A Claude prompt's choice as the server maps it (src/providers/claude-permission-options.ts
   * claudeChoiceResponse; tests/providers/live-settings-permission-choices.test.ts keeps the two
   * equal): Allow and Deny, or the CLI's own suggested rules sent back for the session or where it
   * suggested keeping them. Null: the request never offered that option.
   */
  function claudeChoice(request: Record<string, unknown>, optionId: string): { allow: boolean; updates: Array<Record<string, unknown>> | null } | null {
    if (optionId === 'allow_once') return { allow: true, updates: null }
    if (optionId === 'reject_once') return { allow: false, updates: null }
    const tool = request.tool_name
    if (typeof tool !== 'string' || !tool || tool === 'AskUserQuestion' || tool === 'ExitPlanMode' || request.suppress_always_allow_rule === true) return null
    const updates: Array<Record<string, unknown>> = []
    for (const s of Array.isArray(request.permission_suggestions) ? request.permission_suggestions : []) {
      if (!s || typeof s !== 'object') continue
      const u = s as Record<string, unknown>
      const destination = typeof u.destination === 'string' ? u.destination : 'session'
      if (u.type === 'addRules') {
        if (u.behavior !== 'allow' || !Array.isArray(u.rules)) continue
        const rules = (u.rules as unknown[]).filter((r): r is { toolName: string; ruleContent?: string } => !!r && typeof r === 'object'
          && typeof (r as { toolName?: unknown }).toolName === 'string' && (r as { toolName: string }).toolName.length > 0
          && ((r as { ruleContent?: unknown }).ruleContent === undefined || typeof (r as { ruleContent?: unknown }).ruleContent === 'string')
          // A "*" in a Bash rule is the CLI's wildcard (only a trailing ":*" is meant as one): drop it.
          && !((r as { toolName: string }).toolName === 'Bash' && typeof (r as { ruleContent?: unknown }).ruleContent === 'string'
            && ((r as { ruleContent: string }).ruleContent).replace(/(?: |:)\*$/, '').includes('*')))
          .map((r) => (r.ruleContent !== undefined ? { toolName: r.toolName, ruleContent: r.ruleContent } : { toolName: r.toolName }))
        if (rules.length) updates.push({ type: 'addRules', rules, behavior: 'allow', destination })
      } else if (u.type === 'addDirectories') {
        const directories = Array.isArray(u.directories) ? (u.directories as unknown[]).filter((d): d is string => typeof d === 'string' && d.length > 0) : []
        if (directories.length) updates.push({ type: 'addDirectories', directories, destination })
      } else if (u.type === 'setMode' && u.mode === 'acceptEdits') {
        // A command's yes never switches the session's edit mode (claude-permission-options.ts requestSuggestions).
        if (tool !== 'Bash') updates.push({ type: 'setMode', mode: 'acceptEdits', destination })
      }
    }
    // A command with a "*" of its own offers no Bash rule at all: the CLI reads every "*" as its wildcard.
    const command = typeof (request.input as { command?: unknown } | undefined)?.command === 'string' ? (request.input as { command: string }).command : undefined
    if (command !== undefined && command.includes('*')) {
      for (let i = updates.length - 1; i >= 0; i--) {
        const u = updates[i]
        if (u.type !== 'addRules') continue
        const rules = (u.rules as Array<{ toolName: string }>).filter((r) => r.toolName !== 'Bash')
        if (rules.length) updates[i] = { ...u, rules }
        else updates.splice(i, 1)
      }
    }
    if (!updates.length) return null
    if (optionId === 'allow_session') return { allow: true, updates: updates.map((u) => ({ ...u, destination: 'session' })) }
    if (optionId === 'allow_always') {
      // Offered only when a rule is kept in a file; it sends every rule its label names, each
      // where the CLI suggested keeping it (a folder kept to this session stays so).
      const kept = updates.filter((u) => u.type !== 'setMode' && ['localSettings', 'projectSettings', 'userSettings'].includes(u.destination as string))
      // A saved exact command over 200 characters is a one-off: not offered (claude-permission-options.ts LONG_EXACT_RULE).
      const oneOff = command !== undefined && command.length > 200 && kept.every((u) => u.type === 'addRules'
        && (u.rules as Array<{ toolName: string; ruleContent?: string }>).every((r) => r.toolName === 'Bash' && r.ruleContent === command))
      return kept.length && !oneOff ? { allow: true, updates: updates.filter((u) => u.type !== 'setMode') } : null
    }
    return null
  }

  function permissionAnswer(pending: PendingPrompt | null, raw: { requestId?: unknown; allow?: unknown; message?: unknown; answers?: unknown; optionId?: unknown }, sid?: string): PermissionAnswer {
    if (typeof raw.requestId !== 'string' || !raw.requestId || typeof raw.allow !== 'boolean') {
      return { ok: false, error: 'requestId (string) and allow (boolean) are required', code: 'bad_request' }
    }
    if (raw.message !== undefined && typeof raw.message !== 'string') return { ok: false, error: 'message must be a string', code: 'bad_request' }
    if (raw.optionId !== undefined && typeof raw.optionId !== 'string') return { ok: false, error: 'optionId must be a string', code: 'bad_request' }
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
      const before = sid ? answered.get(`${sid}\n${raw.requestId}`) : undefined
      if (before !== undefined) return { ok: true, duplicate: true, allow: before }
      return { ok: false, error: 'Permission request not found or already resolved', code: 'not_found' }
    }
    const choice = typeof raw.optionId === 'string' ? claudeChoice(pending.request, raw.optionId) : null
    if (typeof raw.optionId === 'string' && !choice) return { ok: false, error: `This request does not offer option ${raw.optionId}`, code: 'bad_request' }
    if (choice && choice.allow !== raw.allow) return { ok: false, error: `allow must be ${choice.allow} for option ${raw.optionId}`, code: 'bad_request' }
    const input = (pending.request.input && typeof pending.request.input === 'object' ? pending.request.input : {}) as Record<string, unknown>
    const result = raw.allow
      ? {
        behavior: 'allow', updatedInput: answers ? { ...input, answers } : input,
        ...(choice?.updates ? { updatedPermissions: choice.updates, decisionClassification: 'user_permanent' } : {}),
      }
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

  return { apply, setMode, permissionAnswer, noteAnswered, noteResponse, pending: () => waiters.size, modes: () => ({ ...MODES }) }
}

export type LiveSettings = ReturnType<typeof createLiveSettings>
