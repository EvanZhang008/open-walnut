/**
 * A session start names its long arguments by hash once the host keeps a copy of them
 * (start-arg-refs-v1; the daemon side is resolveRefs/rememberRefs in cli-argv-files-core.ts).
 *
 * Why (2026-11-13): every `start` carried the session's whole `--settings` (about 100 KB of hook
 * scripts), its prompt (about 18 KB) and its MCP config inline. After the Mac woke, 14 sessions on
 * one host resumed at once, each start was sent again after a reconnect, and one link carried
 * 3.3 MB of starts in 16 minutes: the relay on the SSH path ends a link on an upload burst, and
 * the host dropped 8 times in 90 minutes.
 *
 * So the long hook commands leave the settings as `--walnut-hook-file <text>` pairs (hook-files-v1),
 * and each argument of ARG_REF_MIN_CHARS or more that this host was already sent goes as
 * `@walnut-arg-ref:<sha256-32>`. A start marked `argRefs: true` has the daemon put each back from
 * its copy before anything reads the start (so the registry, the CLI and its files are what an
 * inline start makes) and keep copies of the rest. A hash counts as sent when the frame goes out,
 * not when it is answered: a start whose answer a dropped link lost, and the starts sent beside
 * it, already name it. A copy the host lacks (the frame never arrived, a sweep, another host
 * behind the same name) is answered ARG_REFS_MISSING and only those arguments go again in full,
 * unless a later frame already carried one; a second miss sends everything in full.
 */
import { createHash } from 'node:crypto'
import { compactHookArgs } from './hook-files.js'

export const START_ARG_REFS_CAPABILITY = 'start-arg-refs-v1'
/** Mirrored inside createCliArgvFiles (it can reference nothing at module scope); a test pins both. */
export const ARG_REF_TOKEN = '@walnut-arg-ref:'
export const ARG_REF_MIN_CHARS = 1024
/** Hashes kept per host; the oldest go first (each is a few dozen bytes). */
const HELD_MAX = 2000

/** Per host: each long argument's hash, and the number of the last frame that carried it in full. */
type HostRefs = { seq: number; held: Map<string, number> }
const byHost = new Map<string, HostRefs>()

export function argRefHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)
}

function refsFor(host: string): HostRefs {
  let refs = byHost.get(host)
  if (!refs) { refs = { seq: 0, held: new Map() }; byHost.set(host, refs) }
  return refs
}

const isLong = (a: unknown): a is string => typeof a === 'string' && a.length >= ARG_REF_MIN_CHARS

/** args with each long argument in `held` named by its hash; refs: how many. */
export function packStartArgs(args: readonly unknown[], held: { has(hash: string): boolean }): { args: unknown[]; refs: number } {
  let refs = 0
  const out = args.map((a) => {
    if (!isLong(a)) return a
    const h = argRefHash(a)
    if (!held.has(h)) return a
    refs++
    return ARG_REF_TOKEN + h
  })
  return { args: out, refs }
}

/** A frame goes out: its number, and each long argument it carries in full is held from it on. */
function noteSent(refs: HostRefs, args: readonly unknown[]): number {
  const seq = ++refs.seq
  for (const a of args) {
    if (!isLong(a) || a.startsWith(ARG_REF_TOKEN)) continue
    const h = argRefHash(a)
    refs.held.delete(h)
    refs.held.set(h, seq)
  }
  while (refs.held.size > HELD_MAX) refs.held.delete(refs.held.keys().next().value as string)
  return seq
}

type StartAnswer = { ok?: boolean; code?: unknown; missingRefs?: unknown }

/**
 * Send a start through `send` with its long arguments by hash where the host was sent them. The
 * answer is the daemon's, as an inline start gets it; copies it lacks are sent again in full once.
 * `send` also gets the params as they left the caller, for a try that lands on a daemon that
 * takes no refs (a swap to an older one).
 */
export async function sendStartWithRefs<R extends StartAnswer>(
  host: string,
  params: Record<string, unknown>,
  send: (params: Record<string, unknown>, withoutRefs: Record<string, unknown>) => Promise<R>,
): Promise<R> {
  if (!Array.isArray(params.args)) return send(params, params)
  // An argument that already reads as a ref would be taken for one: such a start goes as it is.
  if (params.args.some((a) => typeof a === 'string' && a.startsWith(ARG_REF_TOKEN))) return send(params, params)
  const full = compactHookArgs(params.args as unknown[])
  const refs = refsFor(host)
  let packed = packStartArgs(full, refs.held)
  let seq = noteSent(refs, packed.args)
  let answer = await send({ ...params, args: packed.args, argRefs: true }, params)
  if (packed.refs > 0 && missingOf(answer)) {
    // A frame sent after this one that carried a copy in full reached the host first (one link,
    // in order): that hash stays held. Only the rest goes again in full, so starts that all named
    // a copy a dropped link lost do not all send it again at once.
    for (const h of missingOf(answer)!) if ((refs.held.get(h) ?? 0) <= seq) refs.held.delete(h)
    packed = packStartArgs(full, refs.held)
    seq = noteSent(refs, packed.args)
    answer = await send({ ...params, args: packed.args, argRefs: true }, params)
    // Still missing (another daemon swept the shared dir, or the name reaches two hosts): all in full.
    if (packed.refs > 0 && missingOf(answer)) {
      noteSent(refs, full)
      answer = await send({ ...params, args: full, argRefs: true }, params)
    }
  }
  return answer
}

function missingOf(answer: StartAnswer | undefined): string[] | null {
  if (answer?.ok !== false || answer.code !== 'ARG_REFS_MISSING') return null
  return (Array.isArray(answer.missingRefs) ? answer.missingRefs : []).map(String)
}

export function _resetStartArgRefsForTesting(): void { byHost.clear() }
