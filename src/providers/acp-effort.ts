/**
 * A reasoning effort someone named (a start's `model[effort]` pick, kept on the record as
 * acpConfig.reasoning_effort, or a picker's qualified id) applied to an ACP session: through
 * the adapter's effort control, the select whose category is `thought_level` (codex-acp's
 * `reasoning_effort`, the Gemini family's `thought_level`), else one with id
 * `reasoning_effort`. The value is one the control offers: the named effort when it is
 * there, else the nearest one below it on the effort scale, else the lowest offered.
 *
 * Pure: the session's controls are an argument.
 */
import type { AcpConfigOption } from './acp-worker/protocol.js'

/** The acpConfig key a start's effort is kept under, whatever the adapter's control is called. */
export const EFFORT_PICK_KEY = 'reasoning_effort'

/** Efforts from least to most, as the engines name them. */
const EFFORT_SCALE = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export function effortControlOf(controls: readonly AcpConfigOption[]): AcpConfigOption | undefined {
  return controls.find((c) => c.category === 'thought_level') ?? controls.find((c) => c.id === EFFORT_PICK_KEY)
}

/**
 * The control value for a named effort, or undefined when the control offers none that
 * fits (a name off the scale it does not offer). "max" on low..xhigh is "xhigh"; "xhigh"
 * on low..high is "high"; "minimal" on low..high is "low".
 */
export function effortValueFor(wanted: string, control: Pick<AcpConfigOption, 'options'>): string | undefined {
  const offered = control.options.map((o) => o.value)
  if (offered.includes(wanted)) return wanted
  const rank = (v: string) => (EFFORT_SCALE as readonly string[]).indexOf(v.toLowerCase())
  const want = rank(wanted)
  if (want < 0) return offered.find((v) => v.toLowerCase() === wanted.toLowerCase())
  const ranked = offered.filter((v) => rank(v) >= 0).sort((a, b) => rank(a) - rank(b))
  if (ranked.length === 0) return undefined
  return [...ranked].reverse().find((v) => rank(v) <= want) ?? ranked[0]
}
