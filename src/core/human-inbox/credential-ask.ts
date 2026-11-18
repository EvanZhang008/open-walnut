import type { LetterRecord, NewLetter } from './types.js'
import { loginCommandWords, signInLineOf } from '../sign-in-ask.js'

/** The machine holding the credential, not the remote machine it signs in to. */
export interface CredentialAsk {
  host: string
  kind: 'ssh-certificate' | 'login-cookie' | 'login'
  expiresAt?: number
}

export function normalizeCredentialAsk(raw: unknown): CredentialAsk | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.host !== 'string' || !r.host.trim() || r.host.length > 200) return undefined
  if (!['ssh-certificate', 'login-cookie', 'login'].includes(String(r.kind))) return undefined
  if (r.expiresAt !== undefined && (typeof r.expiresAt !== 'number' || !Number.isFinite(r.expiresAt) || r.expiresAt <= 0)) return undefined
  return { host: r.host.trim(), kind: r.kind as CredentialAsk['kind'], ...(r.expiresAt ? { expiresAt: r.expiresAt as number } : {}) }
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
      }
    }
  }
  if (locations.size !== 1) return undefined
  const prose = `${input.subject}\n${body}`
  const kind = /\bcookie\b/i.test(prose) ? 'login-cookie' : /\b(?:ssh\s+)?(?:certificate|cert)\b|证书/iu.test(prose) ? 'ssh-certificate' : 'login'
  return { host: [...locations][0]!, kind }
}

/** Active asks fold by host + credential, independent of sender, words, or target host aliases. */
export function sameCredentialAsk(a: CredentialAsk, b: CredentialAsk): boolean {
  return a.host === b.host && a.kind === b.kind
    && (a.expiresAt === undefined || b.expiresAt === undefined || a.expiresAt === b.expiresAt)
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

export function findCredentialLetter(ask: CredentialAsk, letters: readonly LetterRecord[]): LetterRecord | undefined {
  return letters.find(letter => !!letter.credentialAsk && sameCredentialAsk(ask, letter.credentialAsk)
    && (!letter.archived && !letter.answered || (ask.expiresAt !== undefined && letter.credentialAsk.expiresAt === ask.expiresAt)))
}
