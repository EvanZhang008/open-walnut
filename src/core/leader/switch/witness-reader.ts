/**
 * How the switch command and `walnut leader status` read the witnesses (read only). Local witnesses
 * are read from this process. Remote witnesses are read only through a running leader server of
 * this Walnut (its runtime's own links, GET /api/leader/witnesses): a command-line process opens no
 * host link, because a pooled link describes the Walnut to the host. With no server to ask, the
 * caller's `own` read (a machine's ways a and b, which need no link: witness-reach.ts) is tried;
 * with neither the reader says so and never guesses.
 */
import { majorityOf, type PermitRecord } from '../permit/types.js'
import { openPermitClient, readStanding } from './permit-ops.js'
import { isRemoteWitness, type LeaderSwitchSettings } from './settings.js'

export interface WitnessReading {
  /** The record a majority holds (null: none ever), or undefined when no record has a majority among the answers. */
  standing: PermitRecord | null | undefined
  answered: number
}

/** The server a command may ask: its port, and a request to it. */
export interface ReadingServer {
  api(method: string, urlPath: string): Promise<{ status: number; json: unknown }>
}

/** Remote witnesses are listed and no leader server of this Walnut is running to read them. */
export class NoLeaderServerToRead extends Error {
  constructor(detail: string) {
    super(`the witnesses ${detail} are on other machines: no running leader server here reads them, and no majority of them is reached without a leader link (start the leader first)`)
    this.name = 'NoLeaderServerToRead'
  }
}

/**
 * A reader over `settings.witnesses`. `servers`: the running servers to ask, in order, when any witness is
 * remote (the first that answers wins). `own`: the read with no server and no link (null: no majority
 * that way); neither usable throws NoLeaderServerToRead.
 */
export function makeWitnessReader(id: string, settings: LeaderSwitchSettings, servers: () => ReadingServer[], own?: () => Promise<WitnessReading | null>): () => Promise<WitnessReading> {
  const remote = settings.witnesses.filter(isRemoteWitness)
  if (!remote.length) {
    const h = openPermitClient(id, settings.witnesses, settings.params)
    return async () => {
      const r = await readStanding(h)
      return { standing: r.standing, answered: r.answered }
    }
  }
  return async () => {
    for (const server of servers()) {
      const r = await server.api('GET', '/api/leader/witnesses').catch(() => null)
      const j = r?.json as { ok?: boolean; standing?: PermitRecord | null; agreed?: boolean; answered?: number } | null | undefined
      if (r?.status === 200 && j?.ok && typeof j.answered === 'number') {
        return { standing: j.agreed === false ? undefined : (j.standing ?? null), answered: j.answered }
      }
    }
    const read = own ? await own().catch(() => null) : null
    if (read) return read
    throw new NoLeaderServerToRead(remote.map((w) => w.id).join(', '))
  }
}

/** Whether a majority of the fixed list answered. */
export function majorityAnswered(settings: LeaderSwitchSettings, answered: number): boolean {
  return answered >= majorityOf(settings.witnesses.map((w) => w.id))
}
