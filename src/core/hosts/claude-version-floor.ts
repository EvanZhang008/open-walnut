/**
 * The oldest Claude Code CLI each model runs on. A CLI older than its model's
 * floor fails every turn with the API's `400 ... version X or newer is
 * required`, which a user only ever saw as raw stderr in a failed session. The
 * host preflight now compares the installed CLI against the floor of the model
 * Walnut is set to use and reports `claude_outdated` with both versions.
 *
 * "The model Walnut is set to use" = `agent.main_model`, else DEFAULT_MODEL:
 * the one model id Walnut's config names. A session's own model is a runtime
 * picker choice (types.ts: there is deliberately no default session model), so
 * this is the best single answer the server has before any session starts.
 *
 * Evidence per row: the first CLI binary carrying the model id. For Opus 5.5,
 * the 2.1.240 and 2.1.258 binaries contain no `claude-opus-5-5` string and
 * 2.1.280 contains it 41 times; older CLIs get the 400 above.
 */

import { DEFAULT_MODEL } from '../../model/providers/defaults.js'

export interface ClaudeCliFloor {
  /** major.minor.patch, the oldest CLI that runs the model. */
  minVersion: string
  /** The model's display name for the problem line ("Opus 5.5"). */
  model: string
}

/** Newest first. `match` sees Bedrock, Anthropic and OpenRouter ids alike. */
const FLOORS: ReadonlyArray<ClaudeCliFloor & { match: RegExp }> = [
  { match: /claude-opus-5[-.]5(?!\d)/i, minVersion: '2.1.280', model: 'Opus 5.5' },
]

export function claudeCliFloorFor(model: string | undefined | null): ClaudeCliFloor | null {
  if (!model) return null
  const row = FLOORS.find((f) => f.match.test(model))
  return row ? { minVersion: row.minVersion, model: row.model } : null
}

/** The floor of the configured model; null when it has none or config is unreadable. */
export async function configuredClaudeCliFloor(): Promise<ClaudeCliFloor | null> {
  try {
    const { getConfig } = await import('../config-manager.js')
    return claudeCliFloorFor((await getConfig()).agent?.main_model ?? DEFAULT_MODEL)
  } catch {
    return null
  }
}

/** have >= need by major.minor.patch (pre-release tags ignored); null when either is not a version. */
export function claudeVersionAtLeast(have: string | undefined, need: string | undefined): boolean | null {
  const a = /^v?(\d+)\.(\d+)\.(\d+)/.exec(have?.trim() ?? '')
  const b = /^v?(\d+)\.(\d+)\.(\d+)/.exec(need?.trim() ?? '')
  if (!a || !b) return null
  for (let i = 1; i <= 3; i++) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i])
  }
  return true
}
