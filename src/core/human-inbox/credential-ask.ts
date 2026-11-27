import type { LetterRecord, NewLetter } from './types.js'
import { loginCommandWords, signInLineOf } from '../sign-in-ask.js'

/** The machine holding the credential, not the remote machine it signs in to. */
export interface CredentialAsk {
  host: string
  kind: CredentialKind
  expiresAt?: number
  /** Other parts of this machine's sign-in later asks folded into this letter as turns (credentialFoldAddsTurn). */
  folded?: Array<{ kind: CredentialKind; expiresAt?: number }>
}

export const CREDENTIAL_KINDS = ['ssh-certificate', 'login-cookie', 'login'] as const
export type CredentialKind = typeof CREDENTIAL_KINDS[number]
const isKind = (k: unknown): k is CredentialKind => (CREDENTIAL_KINDS as readonly unknown[]).includes(k)

export function normalizeCredentialAsk(raw: unknown): CredentialAsk | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.host !== 'string' || !r.host.trim() || r.host.length > 200) return undefined
  if (!isKind(r.kind)) return undefined
  if (r.expiresAt !== undefined && (typeof r.expiresAt !== 'number' || !Number.isFinite(r.expiresAt) || r.expiresAt <= 0)) return undefined
  const folded: Array<{ kind: CredentialKind; expiresAt?: number }> = []
  for (const f of Array.isArray(r.folded) ? r.folded.slice(0, 12) : []) {
    const k = (f as { kind?: unknown } | null)?.kind
    const at = (f as { expiresAt?: unknown } | null)?.expiresAt
    if (!isKind(k) || k === r.kind || folded.some((x) => x.kind === k)) continue
    folded.push({ kind: k, ...(typeof at === 'number' && Number.isFinite(at) && at > 0 ? { expiresAt: at } : {}) })
  }
  return { host: r.host.trim(), kind: r.kind, ...(r.expiresAt ? { expiresAt: r.expiresAt as number } : {}), ...(folded.length ? { folded } : {}) }
}

export interface CredentialAskContext {
  hint?: string
  names: Array<{ host: string; names: string[] }>
  canonical: (host: string) => Promise<string>
}

/** Older callers still work: only an explicit execution location in the renewal sentence counts. */
export async function credentialAskOf(input: Pick<NewLetter, 'subject' | 'markdown' | 'html' | 'text' | 'credentialAsk' | 'credential_ask'>,
  context: CredentialAskContext): Promise<CredentialAsk | undefined> {
  const explicit = input.credentialAsk ?? input.credential_ask
  if (explicit !== undefined) {
    const ask = normalizeCredentialAsk(explicit)
    if (!ask) throw new Error('credential_ask must name a host and credential kind, with an optional positive expiry timestamp')
    return { ...ask, host: await context.canonical(ask.host) }
  }
  const body = String(input.markdown ?? input.html ?? input.text ?? '')
  const command = loginCommandWords(context.hint)
  const locations = new Set<string>()
  const owners = new Set<string>()
  for (const sentence of [input.subject, ...body.split(/\n|(?<=[.!?])\s+/u)]) {
    const line = signInLineOf(null, sentence, command)
      ?? (typeof sentence === 'string' ? signInLineOf(null, sentence.replace(/^.*?[,;:]\s*(?=run\s)/i, ''), command) : null)
    if (!line) continue
    const clean = line.replace(/[`*_]/g, '').toLowerCase()
    for (const entry of context.names) {
      for (const name of entry.names) {
        const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        // Targets in "SSH to box" never count. A renewal sentence must name its execution location.
        if (new RegExp(`(?:\\bon\\s+(?:(?:this|the|your)\\s+)?|\\bin\\s+|\\u5728\\s*)${escaped}(?![a-z0-9_-]|\\.[a-z0-9])`, 'iu').test(clean)) {
          locations.add(await context.canonical(entry.host))
        }
        // Weaker, used only when no sentence names where to run it: Chinese "<box>'s certificate,
        // login, session" (2026-11-27: "<box> \u7684 SSH \u8bc1\u4e66\u8fc7\u671f\u4e86\uff0c\u8bf7\u8dd1\u4e00\u6b21 <command>").
        if (new RegExp(`(?<![a-z0-9_.-])${escaped}\\s*(?:\\u4e0a)?\\u7684\\s*(?:[a-z]+\\s*){0,2}(?:\\u8bc1\\u4e66|\\u767b\\u5f55|\\u4f1a\\u8bdd|\\u51ed\\u636e|\\u51ed\\u8bc1|cookie|session|certificate)`, 'iu').test(clean)) {
          owners.add(await context.canonical(entry.host))
        }
      }
    }
  }
  const where = locations.size ? locations : owners
  if (where.size !== 1) return undefined
  const prose = `${input.subject}\n${body}`
  const kind = /\bcookie\b/i.test(prose) ? 'login-cookie' : /\b(?:ssh\s+)?(?:certificate|cert)\b|证书/iu.test(prose) ? 'ssh-certificate' : 'login'
  return { host: [...where][0]!, kind }
}

/**
 * Active asks fold by the machine that holds the credential, independent of sender, words, target
 * host aliases or which part of its sign-in a sender names: the user signs one machine in once
 * (2026-11-27: one task asked for clouddev's login cookie, another for its SSH certificate, after
 * the same expired sign-in; two letters). Of one kind, a known different expiry is a new episode.
 */
export function sameCredentialAsk(a: CredentialAsk, b: CredentialAsk, opts: { crossKind?: boolean } = {}): boolean {
  if (a.host !== b.host) return false
  if (a.kind !== b.kind) return opts.crossKind !== false
  return a.expiresAt === undefined || b.expiresAt === undefined || a.expiresAt === b.expiresAt
}

/**
 * Folding `asked` into the open letter of `first` adds its words as a turn (nothing it asks is
 * lost): another part of the machine's sign-in, or the expiry the first letter did not know.
 */
export function credentialFoldAddsTurn(asked: CredentialAsk, first: CredentialAsk | undefined): boolean {
  if (!first) return false
  const newer = (known: number | undefined) => asked.expiresAt !== undefined && (known === undefined || asked.expiresAt > known)
  if (asked.kind === first.kind) return newer(first.expiresAt)
  // Of another kind: once per episode of that kind (a known newer expiry is told again).
  const told = first.folded?.find((f) => f.kind === asked.kind)
  return !told || newer(told.expiresAt)
}

/** The first letter's scope once `asked` folded into it as a turn. */
export function credentialAfterFold(asked: CredentialAsk, first: CredentialAsk): CredentialAsk {
  if (asked.kind === first.kind) return { ...first, ...(asked.expiresAt !== undefined ? { expiresAt: asked.expiresAt } : {}) }
  const entry = { kind: asked.kind, ...(asked.expiresAt !== undefined ? { expiresAt: asked.expiresAt } : {}) }
  return { ...first, folded: [...(first.folded ?? []).filter((f) => f.kind !== asked.kind), entry] }
}

/** Server context is shared by core, plugin, route and task sends. No credential reads. */
export async function credentialAskContext(): Promise<CredentialAskContext> {
  const { getConfig } = await import('../config-manager.js')
  const config = await getConfig()
  const { credentialHost } = await import('../hosts/credential-host.js')
  return {
    hint: config.ssh_login_hint,
    names: [
      { host: '__local__', names: ['Mac', 'this Mac', 'this computer', 'local', '__local__'] },
      ...Object.entries(config.hosts ?? {}).map(([host, def]) => ({ host, names: [host, def.label].filter((n): n is string => !!n) })),
    ],
    canonical: async host => (await credentialHost(host, config)).host,
  }
}

export async function resolveCredentialAsk(input: Parameters<typeof credentialAskOf>[0]): Promise<CredentialAsk | undefined> {
  if (input.credentialAsk === undefined && input.credential_ask === undefined) {
    const { getConfig } = await import('../config-manager.js')
    const words = loginCommandWords((await getConfig()).ssh_login_hint)
    if (!signInLineOf(input.subject, String(input.markdown ?? input.html ?? input.text ?? ''), words)) return undefined
  }
  return credentialAskOf(input, await credentialAskContext())
}

/** Legacy core records identify the credential owner even though their subject names targets. */
export async function storedCredentialAskOf(letter: LetterRecord, body: string, context: CredentialAskContext): Promise<CredentialAsk | undefined> {
  if (letter.credentialAsk) return { ...letter.credentialAsk, host: await context.canonical(letter.credentialAsk.host) }
  const cert = /^ssh-cert-expiry:(\d+)/.exec(letter.createdByOp ?? '')
  if (cert) return { host: '__local__', kind: 'ssh-certificate', expiresAt: Number(cert[1]) }
  return credentialAskOf({ subject: letter.subject, markdown: body }, context)
}

/**
 * The letter an ask folds into. One still before the user (not archived, not answered) takes every
 * ask about its machine, whatever the expiry: the user has not acted on it, so a later expiry is
 * the same sign-in still to do (2026-11-27: an 11-07 letter, told of the 11-26 expiry in a reply
 * but still holding an older expiry, let a task's ask of the 11-26 expiry make a second letter).
 * One the user archived or answered takes only the same known expiry of its kind (no repeat after
 * a restart); a new expiry after it is a new letter. `crossKind: false` (a core alert's own send,
 * an `ssh-cert-expiry:` op) folds only into its own kind and a compatible expiry: the alert archives
 * and adds turns to the letter it holds, never to a task's ask.
 */
export function findCredentialLetter(ask: CredentialAsk, letters: readonly LetterRecord[], opts: { crossKind?: boolean } = {}): LetterRecord | undefined {
  // The newest first: an ask lands on the thread the user reads now.
  const ordered = [...letters].sort((x, y) => (Number(y.createdAt) || 0) - (Number(x.createdAt) || 0))
  return ordered.find((letter) => {
    const scope = letter.credentialAsk
    if (!scope || scope.host !== ask.host) return false
    if (!letter.archived && !letter.answered) {
      if (opts.crossKind === false) return sameCredentialAsk(ask, scope, opts)
      return true
    }
    return ask.kind === scope.kind && ask.expiresAt !== undefined && scope.expiresAt === ask.expiresAt
  })
}
