/**
 * What a new-password field says it accepts (maxlength, minlength, pattern, and Apple's
 * `passwordrules`), and a strong password made to fit it. Pure: the content script reads the
 * rules, the background makes the password.
 */
import { generate, MAX_LENGTH, MIN_LENGTH, type PasswordOptions } from '../../../src/core/vault/generator'

export interface FieldRules { minLength?: number; maxLength?: number; pattern?: string; passwordrules?: string }

export function readRules(el: HTMLInputElement): FieldRules {
  const out: FieldRules = {}
  if (el.minLength > 0) out.minLength = el.minLength
  if (el.maxLength > 0) out.maxLength = el.maxLength
  const pattern = el.getAttribute('pattern')
  if (pattern) out.pattern = pattern.slice(0, 500)
  const pr = el.getAttribute('passwordrules')
  if (pr) out.passwordrules = pr.slice(0, 500)
  return out
}

/** The parts of `passwordrules` the generator can follow: lengths, and which classes may or must appear. */
function parsePasswordRules(text: string): { min?: number; max?: number; classes: Set<string>; custom: string; required: Set<string> } {
  const classes = new Set<string>()
  const required = new Set<string>()
  let custom = ''
  let min: number | undefined
  let max: number | undefined
  for (const part of text.split(';')) {
    const [rawKey, ...rest] = part.split(':')
    const key = rawKey?.trim().toLowerCase()
    const value = rest.join(':').trim()
    if (key === 'minlength' && /^\d+$/.test(value)) min = Number(value)
    else if (key === 'maxlength' && /^\d+$/.test(value)) max = Number(value)
    else if (key === 'required' || key === 'allowed') {
      for (const m of value.matchAll(/\[([^\]]*)\]|([a-z-]+)/gi)) {
        const cls = m[2]?.toLowerCase()
        const set = m[1] !== undefined ? 'custom' : cls === 'ascii-printable' || cls === 'unicode' ? 'all' : cls
        if (m[1] !== undefined) custom += m[1].replace(/[a-z0-9]/gi, '')
        if (!set) continue
        classes.add(set)
        if (key === 'required') required.add(set)
      }
    }
  }
  return { min, max, classes, custom, required }
}

function patternTest(pattern: string | undefined): ((s: string) => boolean) | null {
  if (!pattern) return null
  for (const flags of ['v', 'u']) {
    try { const re = new RegExp(`^(?:${pattern})$`, flags); return (s) => re.test(s) } catch { /* next */ }
  }
  return null
}

const randomIndex = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0] % n

/**
 * A password from `base` that fits `rules`: its length held between the field's limits, the
 * classes it allows, and its pattern when the browser can read it (a few tries with fewer
 * classes before giving the closest one).
 */
export function generateFitting(base: PasswordOptions, rules: FieldRules = {}): string {
  const pr = rules.passwordrules ? parsePasswordRules(rules.passwordrules) : null
  const lo = Math.max(rules.minLength ?? 0, pr?.min ?? 0)
  const hi = Math.min(rules.maxLength ?? MAX_LENGTH, pr?.max ?? MAX_LENGTH)
  let length = Math.max(base.length, lo)
  if (hi > 0) length = Math.min(length, hi)
  const opts: PasswordOptions = { ...base, length: Math.max(MIN_LENGTH, length) }
  let customSpecial = ''
  if (pr && pr.classes.size && !pr.classes.has('all')) {
    opts.upper = pr.classes.has('upper')
    opts.lower = pr.classes.has('lower')
    opts.digits = pr.classes.has('digit')
    // The generator's own symbols only when any special is allowed; a site's own set is put in afterwards.
    opts.symbols = base.symbols && pr.classes.has('special')
    if (base.symbols && !pr.classes.has('special') && pr.custom) customSpecial = pr.custom
    if (!opts.upper && !opts.lower && !opts.digits && !opts.symbols) opts.lower = true
  }
  const fits = patternTest(rules.pattern)
  const make = (o: PasswordOptions): string => {
    let pw = generate(o)
    if (customSpecial) {
      const i = randomIndex(pw.length)
      pw = pw.slice(0, i) + customSpecial[randomIndex(customSpecial.length)] + pw.slice(i + 1)
    }
    return length < MIN_LENGTH ? pw.slice(0, length) : pw
  }
  // Fewer classes each round: a pattern that forbids symbols (or digits) still gets a password.
  const rounds: PasswordOptions[] = [opts, { ...opts, symbols: false }, { ...opts, symbols: false, upper: false }, { ...opts, symbols: false, digits: false }]
  let last = ''
  for (const o of rounds) {
    for (let i = 0; i < 25; i++) {
      last = make(o)
      if (!fits || fits(last)) return last
    }
  }
  return last
}
