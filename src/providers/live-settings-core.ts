/**
 * A model or effort change applied to a live session by its host's own daemon
 * (`leader.settings`, docs/plan/walnut-control-plane.md "Model and effort while
 * the Mac is away"). The cloud companion asks while it leads this host. The
 * daemon writes the CLI's own `apply_flag_settings` control_request into the
 * session's stdin, the same line the server writes when it answers, and waits
 * for the CLI's control_response in the session's stream.
 *
 * The CLI ACKs any value, so the value is checked here first: a model id shape
 * (the companion already matched it against the catalog) and a known effort.
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

export function createLiveSettings(deps: LiveSettingsDeps) {
  // A CLI --model value: an alias ('sonnet[1m]'), a catalog value, or a provider
  // id. The charset and length the server's resolveModelSwitchValue allows.
  const MODEL_RE = /^[A-Za-z0-9._:/[\]-]{1,256}$/
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
  const ACK_TIMEOUT_MS = 10_000
  const waiters = new Map<string, { sid: string; resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>()

  function settle(requestId: string, ok: boolean): void {
    const w = waiters.get(requestId)
    if (!w) return
    waiters.delete(requestId)
    clearTimeout(w.timer)
    w.resolve(ok)
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

    const requestId = 'lds-' + deps.now().toString(36) + '-' + deps.randomHex(4)
    const acked = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => settle(requestId, false), timeoutMs ?? ACK_TIMEOUT_MS)
      waiters.set(requestId, { sid, resolve, timer })
    })
    const line = JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'apply_flag_settings', settings } })
    const wrote = await deps.writeLine(sid, line).catch(() => 'failed' as const)
    if (wrote !== 'ok') {
      settle(requestId, false)
      // No CLI to tell now: the server keeps the values for the next spawn.
      deps.log('info', 'leader.settings: no live CLI, kept for the next spawn', { sid, reason: wrote, ...kept })
      return { ok: true, appliedLive: false, reason: wrote, ...kept }
    }
    const ok = await acked
    deps.log(ok ? 'info' : 'warn', ok ? 'leader.settings: applied live' : 'leader.settings: the CLI did not answer', { sid, requestId, ...kept })
    return { ok: true, appliedLive: ok, ...(ok ? {} : { reason: 'no_answer' }), ...kept }
  }

  /** A control_response line in a session's stream: settles a change this daemon sent. */
  function noteResponse(sid: string, parsed: Record<string, unknown>): void {
    const resp = parsed.response as Record<string, unknown> | undefined
    const requestId = resp && typeof resp.request_id === 'string' ? resp.request_id : ''
    const w = requestId ? waiters.get(requestId) : undefined
    if (!w || w.sid !== sid) return
    settle(requestId, resp?.subtype !== 'error')
  }

  return { apply, noteResponse, pending: () => waiters.size }
}

export type LiveSettings = ReturnType<typeof createLiveSettings>
