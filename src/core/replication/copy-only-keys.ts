/**
 * Config keys only the leader's config copy says (replication/config-allowlist.ts makes them from
 * other sections): a host replica reads them in its copy, the leader never honours one in its own
 * config.yaml. The leader's config read leaves them out and its config write ignores them, so a
 * stray key there (a hand edit, a PUT /api/config) changes nothing.
 *
 *   hosts_run_sessions   the hosts whose own `hosts.<name>.runs_sessions` is true (switch.ts)
 */
export const COPY_ONLY_CONFIG_KEYS: readonly string[] = ['hosts_run_sessions']

const COPY_ONLY = new Set(COPY_ONLY_CONFIG_KEYS)

export function isCopyOnlyConfigKey(key: string): boolean {
  return COPY_ONLY.has(key)
}

/** `config` without the copy-only keys (in place; the same object back). */
export function dropCopyOnlyConfigKeys<T extends object>(config: T): T {
  for (const key of COPY_ONLY_CONFIG_KEYS) delete (config as Record<string, unknown>)[key]
  return config
}
