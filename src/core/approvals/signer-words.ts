/**
 * Where the person can say yes to an approval, in words that name only the devices they really
 * have: the keys that sign approvals (keys.ts; an iPhone with Face ID, the Mac app with Touch ID),
 * and for a guarded ask (`guard`, types.ts) a Passwords unlock in the window they approve from.
 * Shared by the server (what an agent and a refused Approve hear) and the web card (approvals-store.ts),
 * so both say the same. Pure: no imports.
 */
export type SignerKind = 'iphone' | 'mac-app'

/** The kinds of the active keys, iPhone first. */
export function signerKinds(keys: ReadonlyArray<{ kind: string; status: string }>): SignerKind[] {
  const have = new Set(keys.filter((k) => k.status === 'active').map((k) => k.kind))
  return (['iphone', 'mac-app'] as const).filter((k) => have.has(k))
}

const ON: Record<SignerKind, string> = { iphone: 'on your iPhone with Face ID', 'mac-app': 'in the Walnut Mac app with Touch ID' }

/**
 * For the person: how to approve. `unlock`: unlocking Passwords in this window also proves it is
 * them (a guarded ask). "Approve it on your iPhone with Face ID, or unlock Passwords in this window."
 */
export function howToApprove(kinds: readonly SignerKind[], opts: { unlock: boolean }): string {
  const ways = kinds.map((k) => ON[k])
  if (opts.unlock) ways.push(ways.length ? 'unlock Passwords in this window' : 'Unlock Passwords in this window')
  if (!ways.length) return 'Approve it in Walnut on a device that signs approvals.'
  const head = ways.length === 1 && opts.unlock ? '' : 'Approve it '
  const joined = ways.length <= 2 ? ways.join(', or ') : `${ways.slice(0, -1).join(', ')}, or ${ways[ways.length - 1]}`
  return `${head}${joined}${opts.unlock && ways.length === 1 ? ' to approve.' : '.'}`
}

/** For the agent: where the person is asked. "They are asked in Walnut and on their iPhone." */
export function whereAsked(kinds: readonly SignerKind[]): string {
  const extra = kinds.includes('iphone') ? ' and on their iPhone' : ''
  return `They are asked in Walnut${extra} (a notification wherever it is open)`
}
