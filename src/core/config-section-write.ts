/**
 * How a write of one top-level config.yaml section lands (updateConfig, and so
 * PUT /api/config and every in-process writer).
 *
 * - `merge`: a section with fixed field names. The keys sent replace the stored
 *   keys, keys left out are kept, and a key sent as `null` (or, in process,
 *   `undefined`) is removed. Objects below the first level are replaced whole.
 *   2026-11-14: a write of `{ session: { skill_listing_desc_chars: 200 } }` used to
 *   replace the whole `session` section and silently drop every other session
 *   setting the user had.
 * - `replace`: a map of entries the user or a plugin names (hosts, providers,
 *   plugins, ...). The map sent is the new map: an editor removes an entry by
 *   leaving it out (Settings, Remote Hosts; a Settings tab still on an older
 *   build; the install-plugin skill's read, merge, write of `plugins`), so a merge
 *   would bring a deleted host or provider back. Entries sent as `null` are
 *   removed too, so a writer may use either way.
 *
 * A value that is not a plain object (an array, a scalar, a top-level `null`)
 * is stored as sent, whatever the mode. A section this table does not know (a
 * key a newer Walnut wrote) merges.
 *
 * Older web clients: a Settings page from before this rule (a tab still open on
 * an older build, an older companion's page forwarded to the Mac) sends each
 * section whole and removes a key by leaving it out. PUT /api/config therefore
 * keeps writing an unmarked write from a browser page section by section whole
 * (`wholeSections`, exactly as before), and merges every other write: an agent's,
 * the CLI's, and a web client's that says so with CONFIG_MERGE_HEADER.
 */
import type { Config } from './types.js';

/** A web client's write that wants the merge (PUT /api/config); value `merge`. */
export const CONFIG_MERGE_HEADER = 'x-walnut-config-write';

export type ConfigSectionWrite = 'merge' | 'replace';

/** Every top-level key of Config, classified (a new key is a type error until it is). */
export const CONFIG_SECTION_WRITE: { readonly [K in keyof Required<Config>]: ConfigSectionWrite } = {
  // Maps of named entries: removing an entry is leaving it out.
  providers: 'replace',
  engines: 'replace',
  plugins: 'replace',
  plugin_ai: 'replace',
  plugin_jobs: 'replace',
  hosts: 'replace',
  session_limits: 'replace',
  placement_weights: 'replace',
  tag_display: 'replace',
  tag_links: 'replace',
  link_tags: 'replace',
  stt_corrections: 'replace',

  // Not objects: always stored as sent.
  version: 'replace',
  plugin_sources: 'replace',
  local_capabilities: 'replace',
  ssh_login_files: 'replace',
  ssh_login_hint: 'replace',
  ssh_cert_letter: 'replace',
  api_keys: 'replace',
  push_tokens: 'replace',

  // Switches by id: an absent one means its default, so nothing removes one by
  // leaving it out, and a write of one switch keeps the others.
  experimental: 'merge',

  // Sections of fixed fields.
  user: 'merge',
  org: 'merge',
  approvals: 'merge',
  passwords: 'merge',
  defaults: 'merge',
  provider: 'merge',
  usage: 'merge',
  agent: 'merge',
  private_tasks: 'merge',
  calendar: 'merge',
  favorites: 'merge',
  ordering: 'merge',
  session_server: 'merge',
  net: 'merge',
  hosts_warmup: 'merge',
  hosts_found: 'merge',
  first_run: 'merge',
  health_monitor: 'merge',
  external_session_import: 'merge',
  session: 'merge',
  triage: 'merge',
  backup: 'merge',
  keep_awake: 'merge',
  time: 'merge',
  search: 'merge',
  session_hooks: 'merge',
  hooks: 'merge',
  self_repair: 'merge',
  updates: 'merge',
  ui: 'merge',
  pull_requests: 'merge',
  audio: 'merge',
  stt: 'merge',
  jev: 'merge',
  push: 'merge',
  cloud_bridge: 'merge',
  expose: 'merge',
  cloud: 'merge',
  sync: 'merge',
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An own property even for `__proto__` (a JSON body can carry that key). */
function setOwn(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

export function configSectionWrite(key: string): ConfigSectionWrite {
  return Object.hasOwn(CONFIG_SECTION_WRITE, key)
    ? CONFIG_SECTION_WRITE[key as keyof typeof CONFIG_SECTION_WRITE]
    : 'merge';
}

/**
 * The value section `key` holds after a write that sends `sent` over `stored`.
 * The caller skips a top-level `undefined` (the section is not part of the write).
 * `wholeSections`: an older client's write, where the section sent is the new
 * section, exactly as it was stored before this rule.
 */
export function writeConfigSection(key: string, stored: unknown, sent: unknown, opts: { wholeSections?: boolean } = {}): unknown {
  if (opts.wholeSections || !isPlainObject(sent)) return sent;
  const out: Record<string, unknown> = {};
  if (configSectionWrite(key) === 'merge' && isPlainObject(stored)) {
    for (const [k, v] of Object.entries(stored)) setOwn(out, k, v);
  }
  for (const [k, v] of Object.entries(sent)) {
    if (v === null || v === undefined) delete out[k];
    else setOwn(out, k, v);
  }
  return out;
}
