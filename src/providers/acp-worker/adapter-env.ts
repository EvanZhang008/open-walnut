/**
 * What an engine's adapter descriptor (engine-registry.ts EngineAcpAdapter) adds to
 * the adapter's process env, and the worker's read of the sign-in plan it carries.
 *
 * The plan rides the adapter env as WALNUT_ACP_AUTH (JSON), so it reaches the worker
 * through the acpStart env the daemon already forwards verbatim: no daemon change, and
 * a worker that predates this ignores the variable (its session/new then fails with
 * auth_required, as before). The engine model probe reads the same variable, so a
 * draft's picker signs in the same way a session does.
 *
 * Pure: no IO, the env and the initialize answer are arguments.
 */
import type { EngineAcpAdapter, EngineAcpAuthPlan } from '../../core/agents/engine-registry.js'

/** The adapter env key carrying the descriptor's auth plan (JSON). */
export const ACP_AUTH_ENV = 'WALNUT_ACP_AUTH'

/**
 * The descriptor's own variables plus its encoded auth plan; undefined when it has
 * neither. Callers merge it UNDER the operator's engines.<id>.env overlay, so the
 * operator can override (or unset with null) any of it.
 */
export function descriptorAdapterEnv(adapter: Pick<EngineAcpAdapter, 'env' | 'auth'> | undefined): Record<string, string> | undefined {
  if (!adapter || (!adapter.env && !adapter.auth)) return undefined
  return {
    ...(adapter.env ?? {}),
    ...(adapter.auth ? { [ACP_AUTH_ENV]: JSON.stringify(adapter.auth) } : {}),
  }
}

/** The method ids an initialize answer advertises (`authMethods[].id`). */
export function advertisedAuthMethods(initializeResponse: unknown): string[] {
  const methods = asRecord(initializeResponse).authMethods
  if (!Array.isArray(methods)) return []
  return methods.flatMap((m) => {
    const id = asRecord(m).id
    return typeof id === 'string' && id ? [id] : []
  })
}

/**
 * The auth method to ask for, or undefined (no plan, an unreadable one, or a pick the
 * adapter does not advertise). `env` is the adapter's merged env: a variable set to ''
 * there was unset by the overlay and does not count.
 */
export function pickAcpAuthMethod(
  rawPlan: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  initializeResponse: unknown,
): string | undefined {
  const plan = parsePlan(rawPlan)
  if (!plan) return undefined
  const byEnv = (plan.byEnv ?? []).find(([name]) => typeof env[name] === 'string' && env[name] !== '')
  const wanted = byEnv?.[1] ?? plan.otherwise
  if (!wanted) return undefined
  return advertisedAuthMethods(initializeResponse).includes(wanted) ? wanted : undefined
}

function parsePlan(raw: string | undefined): EngineAcpAuthPlan | undefined {
  if (!raw) return undefined
  let value: unknown
  try { value = JSON.parse(raw) } catch { return undefined }
  const rec = asRecord(value)
  const byEnv = Array.isArray(rec.byEnv)
    ? rec.byEnv.filter((e): e is [string, string] => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string')
    : undefined
  const otherwise = typeof rec.otherwise === 'string' && rec.otherwise ? rec.otherwise : undefined
  if (!byEnv?.length && !otherwise) return undefined
  return { ...(byEnv?.length ? { byEnv } : {}), ...(otherwise ? { otherwise } : {}) }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
