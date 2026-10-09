/**
 * Exposure: a tunnel or reverse proxy this server runs so a browser anywhere can
 * open it (docs/plan/walnut-servers-everywhere.md, "Exposure").
 *
 * A provider is DATA: the command to run, the pattern of the URL it prints, the
 * lines that mean "sign in again", and the sentences to show. Walnut runs it and
 * keeps it alive; a plugin only contributes the definition. Keep this file free
 * of imports: the plugin API mirrors these shapes.
 */

/** One value the person sets for a provider (a tunnel name, say). Filled into args as `{key}`. */
export interface ExposeProviderOption {
  key: string
  label: string
  default?: string
  help?: string
  /** A regular expression (source text) the value must match in full. */
  pattern?: string
}

export interface ExposeProviderDefinition {
  /** Unique: lowercase letters, digits, `.`, `_`, `-`. */
  id: string
  title: string
  description?: string
  /** Absolute, `~/`-relative, or a name on PATH. */
  command: string
  /** `{port}` is the tunnel port; `{<option key>}` an option's value. */
  args?: string[]
  /** Added to the allowlisted environment the command starts with. */
  env?: Record<string, string>
  options?: ExposeProviderOption[]
  /** A regular expression (source text); its first match in the output is the public URL. */
  urlPattern: string
  /**
   * A line that says the tunnel is ready (a regular expression, case-insensitive). When set, the
   * provider is connected once it printed both the URL and this; when not, the URL line is enough.
   */
  readyPattern?: string
  /** Lines that mean the sign-in expired (regular expressions, case-insensitive). */
  signInPatterns?: string[]
  /** One sentence for the person when a sign-in line shows up. */
  signInHint?: string
  /** One sentence for the person when the command is not installed. */
  installHint?: string
  /** Check the URL answers every minute while connected, restart a silent tunnel. Default true. */
  probe?: boolean
}

export type ExposeState =
  /** Not asked to run. */
  | 'off'
  /** Running, no URL yet. */
  | 'starting'
  /** Running, the URL is known. */
  | 'connected'
  /** Stopped after an exit or an error; starts again at `nextRetryAt`. */
  | 'retrying'
  /** The provider said its sign-in expired; retried slowly until it is renewed. */
  | 'needs-sign-in'
  /** The command is not installed; retried slowly so installing it is enough. */
  | 'missing'
  /** The settings name a provider no plugin provides, or one that cannot run. */
  | 'unavailable'

export interface ExposeStatus {
  enabled: boolean
  provider: string | null
  providerTitle?: string
  state: ExposeState
  since: number
  /** The public URL while connected (kept while retrying, so the person can see what it was). */
  url?: string
  /** The loopback port tunnels connect to, while it is open. */
  port?: number
  /** One sentence: why it is not connected. */
  lastError?: string
  /** What the person can do about it, when the provider said (sign in, install). */
  hint?: string
  nextRetryAt?: number
}

export interface ExposeProviderInfo {
  id: string
  title: string
  description?: string
  /** `core` for the built-in one, else the plugin id. */
  owner: string
  options: ExposeProviderOption[]
}

export const EXPOSE_PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const EXPOSE_STATUS_EVENT = 'expose:status-changed'
/** The built-in provider: a command the person writes in config.yaml. */
export const COMMAND_PROVIDER_ID = 'command'
