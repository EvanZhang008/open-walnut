/**
 * What of the Mac's config.yaml a host replica may hold (docs/plan/walnut-replica-servers-impl.md,
 * section 4 and WP5, the `config` copy kind). An ALLOWLIST, never a denylist:
 *
 *   CONFIG_COPY_ALLOWLIST  every top-level key that is copied, with the sub-keys
 *                          that are copied (`true` = the whole value). A sub-key
 *                          not named is dropped, so a field added to an allowed
 *                          section later is not copied until someone names it.
 *   CONFIG_COPY_DROPPED    every top-level key that is NOT copied, with why. A
 *                          ratchet (tests/core/replication/config-allowlist.test.ts)
 *                          fails when the Config interface gains a key that is in
 *                          neither list, and a key in neither list is dropped.
 *
 * Then the secret check: a row (one top-level key) holding anything secret-shaped
 * after the allowlist (a field named like a secret, a value shaped like one, a
 * masked string a client view showed) is refused whole, on the Mac before it is
 * sent and again on the host before it is written. A masked string is never
 * written: it would stand in for a secret the copy does not have.
 */

import { isMaskedSecret, holdsEditedMask, isSecretKey } from '../config-secret-shape.js'
import { SECRET_FIELDS } from '../config-redact.js'
import { redactSensitiveText } from '../../logging/redact.js'

/**
 * `true`: the whole value, only for a value that cannot grow a field (a scalar,
 * a list or a map of scalars). A record: only these sub-keys. `{'*': spec}`:
 * every entry of a map keyed by a name. `{'[]': spec}`: every record of a list
 * (a scalar in it is kept as it is). The ratchet walks each section's fields in
 * src/core/types.ts: a field is named here or in CONFIG_COPY_DROPPED_FIELDS.
 */
export type AllowSpec = true | { readonly [key: string]: AllowSpec }

const ALLOW: Record<string, AllowSpec> = {
  version: true,
  user: { name: true },
  // The org's name and the user's role on the chart: a replica's Org page shows the same names.
  org: { name: true, founder_title: true },
  defaults: { priority: true, platform: true, project: true, engine: true },
  provider: { type: true, model: true, bedrock_region: true },
  agent: {
    // region and maxTokens are read by nothing now, but an older leader still sends them in
    // this row, and a row with a field outside the spec is refused whole (configRowAdmissible).
    region: true, maxTokens: true, session_effort: true, main_model: true, fast_model: true, quick_parse: true,
    available_models: { '[]': { id: true, provider: true, model_id: true, label: true, context_window: true, max_tokens: true } },
    triage: { debounce_minutes: true, notify_mode: true },
  },
  ordering: {
    projects: true,
    separators: { '[]': { id: true, tier: true, mode: true, label: true, after: true, before: true, afterProject: true, beforeProject: true, project: true } },
  },
  // The host list the Routines executors and the Remote Hosts view name: no server settings, no build env.
  hosts: { '*': { label: true, hostname: true, user: true, port: true, enabled: true, discovered: true } },
  session_limits: { '*': true },
  session: {
    cron_policy: true, output_mode: true, acp_walnut_mcp: true, idle_timeout_minutes: true, max_idle: true,
    permission_prompt: true, auto_approve_bypass: true, enabled_modes: true, stream_partial_messages: true, premount_walnut_mcp: true,
    turn_snapshots: { enabled: true, keep: true },
    turn_retry: { enabled: true, budget_hours: true, max_attempts: true, backoff_seconds: true, backoff_max_seconds: true },
  },
  external_session_import: { excluded_cwds: { '*': true }, auto_complete_after_days: true },
  tag_display: { '*': true },
  tag_links: { '*': true },
  link_tags: { '*': true },
  ui: { session_panels: true, show_priority: true, show_walnut_additions: true },
  time: {
    outside: { enabled: true },
    screentime: { enabled: true, include_this_mac: true },
    work_hours: { start: true, end: true, days: true },
    calls: { enabled: true, apps: true, sites: true },
    meetings: { ignore: true },
  },
  audio: { exclude_apps: true, refresh_interval_sec: true, delete_after_transcription: true, retention_days: true },
  stt: { engine: true, secondary_engine: true, language: true },
  // Terms are the user's words ("token" is one), so the names are not read as field names.
  stt_corrections: { '*': true },
  keep_awake: { enabled: true, battery_floor_pct: true, offline_grace_minutes: true, linger_minutes: true },
  updates: { auto: true },
}
export const CONFIG_COPY_ALLOWLIST: Readonly<Record<string, AllowSpec>> = Object.freeze(ALLOW)

export const CONFIG_COPY_DROPPED: Readonly<Record<string, string>> = Object.freeze({
  providers: 'provider credentials and request headers',
  engines: 'engine environments hold API keys',
  usage: 'proxy log paths on the Mac',
  plugins: 'plugin settings and credentials never leave the Mac',
  plugin_sources: 'plugin install sources',
  plugin_ai: 'plugin AI switches and budgets apply where the plugin runs, on the Mac',
  plugin_jobs: 'where plugin jobs run is chosen on the Mac, which sends each machine its own jobs',
  calendar: 'calendar accounts and credentials',
  favorites: 'copied by the prefs kind',
  session_server: 'the Mac server process settings',
  hosts_warmup: 'ssh warmup on the Mac',
  local_capabilities: 'the Mac\'s own capability tags, read where its fleet card is built, on the Mac',
  ssh_login_files: 'ssh files on the Mac',
  ssh_login_hint: 'the ssh sign-in letter is sent on the Mac',
  triage: 'inbox triage runs on the Mac',
  placement_weights: 'placement by load decides on the Mac',
  backup: 'backup targets of the Mac',
  search: 'embedding endpoints and keys; the search copy carries its own',
  git_versioning: 'data backups of the Mac',
  session_hooks: 'hook actions run on the Mac',
  hooks: 'hook actions run on the Mac and may carry credentials',
  self_repair: 'the repair loop of the Mac',
  jev: 'an API key',
  api_keys: 'pairing credentials',
  push_tokens: 'push device tokens',
  push: 'push signing key settings',
  cloud_bridge: 'bridge credentials',
  expose: 'the tunnel settings of the Mac',
  cloud: 'companion credentials',
  sync: 'git sync remote and credentials',
})

/**
 * Every field of an allowlisted section that is NOT copied, with why, by the
 * section's path (`*` a map entry, `[]` a list record). The ratchet fails on a
 * field of a section in neither the section's spec nor this list.
 */
export const CONFIG_COPY_DROPPED_FIELDS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  provider: { bedrock_bearer_token: 'a credential' },
  agent: {
    agents: 'agent definitions (prompts, tools) run on the Mac',
    session_organize: 'a background job of the Mac',
    language: 'the agent reply language of turns on the Mac',
    main_provider: 'names a provider entry, which is not copied',
  },
  // Read only by the leader's send path. Named in the copy, an older replica would refuse the whole session row.
  session: {
    reply_language: 'the reply-language line the Mac adds to each message it delivers',
    hints: 'the message hints the Mac composes into each message it delivers (core/hints/)',
  },
  'agent.available_models.[]': { compat: 'request quirks for calls the Mac makes', cost: 'pricing of usage on the Mac' },
  'hosts.*': {
    shell_setup: 'a shell command line that may carry tokens',
    capabilities: 'capability tags read by the fleet cards and host selectors, built on the Mac',
    autofix: 'repair runs from the Mac',
    cloud_box: 'the companion link of the Mac',
    keep: 'what the Mac pushes to that host',
    server: 'that host server settings and build env',
    server_program: 'which program the Mac starts there',
    place: 'placement by load decides on the Mac',
  },
  stt: {
    sherpa_model_dir: 'a model path on the Mac', sherpa_model_type: 'a model of the Mac',
    openai_api_key: 'a credential', openai_base_url: 'a speech endpoint of the Mac', openai_model: 'a speech model of the Mac',
    whisper_cpp_path: 'a binary path on the Mac', whisper_cpp_model: 'a model path on the Mac',
    whisper_cpp_vad_model: 'a model path on the Mac', whisper_cpp_prompt: 'a prompt for speech on the Mac',
    whisper_server_path: 'a binary path on the Mac', whisper_server_model: 'a model path on the Mac',
    whisper_server_vad_model: 'a model path on the Mac', whisper_server_prompt: 'a prompt for speech on the Mac',
    whisper_server_port: 'a port on the Mac', whisper_server_idle_ttl_minutes: 'a speech server of the Mac',
    mlx_python_path: 'a binary path on the Mac', mlx_model: 'a model of the Mac', mlx_port: 'a port on the Mac',
    mlx_idle_ttl_minutes: 'a speech server of the Mac', cleanup_model: 'a model of the Mac', cleanup_port: 'a port on the Mac',
    prewarm_on_start: 'a speech server of the Mac', qwen_size: 'a speech model of the Mac',
    keep_recordings: 'each server sizes its own recordings to its own disk',
    auto_context: 'each server reads its own task titles (and an older replica would refuse an stt row naming it)',
  },
})

/** Maps keyed by a name someone chose (a host alias, a tag, a path): the name is not judged, what is inside it is. */
const NAME_KEYED = new Set(['hosts', 'session_limits', 'tag_display', 'tag_links', 'link_tags', 'external_session_import.excluded_cwds', 'stt_corrections'])

/** Field names that hold a credential and that the shape rule does not name. */
const EXTRA_SECRET_KEYS = new Set(['credential_process', 'credentials', 'authorization', 'cookie', 'cookies'])

/** Token shapes the log redactor does not look for. */
const TOKEN_SHAPES = /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|ASIA[A-Z0-9]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/

/** A long opaque run of mixed-case letters and digits: a key or a token, not a word, a path or a hash. */
function opaqueToken(v: string): boolean {
  const s = v.trim()
  return /^[A-Za-z0-9+/_=-]{40,}$/.test(s) && /[0-9]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s)
}

export type SecretReason = 'secret_key' | 'secret_value' | 'masked'

/** Why a string may not be copied, or null. A mask stands in for a secret this copy does not have. */
export function secretShapedValue(v: string): SecretReason | null {
  if (isMaskedSecret(v) || holdsEditedMask(v)) return 'masked'
  if (redactSensitiveText(v) !== v || TOKEN_SHAPES.test(v) || opaqueToken(v)) return 'secret_value'
  return null
}

export function secretKeyName(key: string): boolean {
  return SECRET_FIELDS.has(key) || EXTRA_SECRET_KEYS.has(key.toLowerCase()) || isSecretKey(key)
}

export interface SecretFinding { path: string; reason: SecretReason }

/** Every secret-shaped place in `value` (a row of `topKey`). Paths only, never a value. */
export function findSecrets(value: unknown, topKey: string): SecretFinding[] {
  const out: SecretFinding[] = []
  const walk = (v: unknown, path: string[]): void => {
    if (typeof v === 'string') {
      const reason = secretShapedValue(v)
      if (reason) out.push({ path: path.join('.'), reason })
      return
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, [...path, String(i)])); return }
    if (!v || typeof v !== 'object') return
    const named = NAME_KEYED.has(path.join('.'))
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!named && secretKeyName(k) && x !== null && x !== undefined && x !== '') out.push({ path: [...path, k].join('.'), reason: 'secret_key' })
      walk(x, [...path, k])
    }
  }
  walk(value, [topKey])
  return out
}

/** `value` through `spec`: what the copy may hold of it, or undefined (nothing). */
export function allowThrough(value: unknown, spec: AllowSpec): unknown {
  if (value === undefined || typeof value === 'function') return undefined
  if (spec === true) return JSON.parse(JSON.stringify(value)) as unknown
  const elem = Object.prototype.hasOwnProperty.call(spec, '[]') ? spec['[]'] : undefined
  if (elem !== undefined) {
    if (!Array.isArray(value)) return undefined
    // A scalar cannot grow a field: kept as it is. A record goes through the element's spec.
    return value.map((x) => (x && typeof x === 'object' ? allowThrough(x, elem) ?? null : allowThrough(x, true) ?? null))
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const src = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const each = spec['*']
  for (const [k, v] of Object.entries(src)) {
    const sub = each ?? (Object.prototype.hasOwnProperty.call(spec, k) ? spec[k] : undefined)
    if (sub === undefined) continue
    const kept = allowThrough(v, sub)
    if (kept !== undefined) out[k] = kept
  }
  return out
}

/**
 * Top-level keys of features Walnut no longer has. An older config.yaml may
 * still carry them; they are dropped quietly, never named as unknown.
 * Removed 2026-10-27: heartbeat (the check-in feature), developer (chat
 * notification switches nothing read any more) and tools (settings of the
 * removed in-process agent's tools; older files may still hold search and
 * chat keys there, which is one more reason never to copy it).
 */
export const RETIRED_CONFIG_KEYS: ReadonlySet<string> = new Set(['heartbeat', 'developer', 'tools'])

export interface ConfigCopyRow { key: string; value: unknown }

export interface ConfigCopyRows {
  rows: ConfigCopyRow[]
  /** Allowlisted keys left out: something in them is secret-shaped (paths only). */
  refused: Array<{ key: string; findings: SecretFinding[] }>
  /** Keys of this config in neither list: dropped, as a key the allowlist does not name always is. */
  unknown: string[]
}

/** The config copy's rows: allowlisted top-level keys, each through its spec, each with no secret in it. */
export function configCopyRows(config: Readonly<Record<string, unknown>>): ConfigCopyRows {
  const rows: ConfigCopyRow[] = []
  const refused: ConfigCopyRows['refused'] = []
  const unknown: string[] = []
  for (const key of Object.keys(config).sort()) {
    const spec = Object.prototype.hasOwnProperty.call(CONFIG_COPY_ALLOWLIST, key) ? CONFIG_COPY_ALLOWLIST[key] : undefined
    if (spec === undefined) {
      if (!Object.prototype.hasOwnProperty.call(CONFIG_COPY_DROPPED, key) && !RETIRED_CONFIG_KEYS.has(key)) unknown.push(key)
      continue
    }
    const value = allowThrough(config[key], spec)
    if (value === undefined) continue
    const findings = findSecrets(value, key)
    if (findings.length > 0) { refused.push({ key, findings }); continue }
    rows.push({ key, value })
  }
  return { rows, refused, unknown }
}

/** A row the host may write: an allowlisted key, its value already through the spec, nothing secret in it. */
export function configRowAdmissible(row: ConfigCopyRow): boolean {
  const spec = Object.prototype.hasOwnProperty.call(CONFIG_COPY_ALLOWLIST, row.key) ? CONFIG_COPY_ALLOWLIST[row.key] : undefined
  if (spec === undefined) return false
  const through = allowThrough(row.value, spec)
  return JSON.stringify(through) === JSON.stringify(row.value) && findSecrets(row.value, row.key).length === 0
}
