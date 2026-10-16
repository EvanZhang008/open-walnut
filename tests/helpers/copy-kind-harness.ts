/**
 * The WP4 copy kinds' test harness: the real follower route
 * (web/routes/bridge-replica.ts createLinkedReplicaRouter, what a host
 * replica's leader door serves) on a local port, and a host replica target
 * that reaches it over HTTP, mapped as core/host-server/index.ts maps the
 * stream answer. Every step is recorded.
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CloudReplicaReply } from '../../src/core/cloud-ingest.js'
import type { CopyTarget } from '../../src/core/replication/kinds/copy-kind.js'

export interface StepCall { op: string; kind: string; n: number; digest?: boolean; bytes: number }

export interface CopyHarness {
  target: CopyTarget
  calls: StepCall[]
  /** The next answers to this kind's steps fail (a lost connection). */
  failNext(n: number): void
  close(): Promise<void>
}

export async function startCopyHarness(opts: { id?: string; copies?: () => Promise<unknown>; program?: string } = {}): Promise<CopyHarness> {
  const [{ default: express }, { createLinkedReplicaRouter }] = await Promise.all([import('express'), import('../../src/web/routes/bridge-replica.js')])
  const app = express()
  app.use('/bridge/replica', createLinkedReplicaRouter())
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const port = (server.address() as AddressInfo).port
  const calls: StepCall[] = []
  let failing = 0
  const target: CopyTarget = {
    id: opts.id ?? 'host:devbox',
    kind: 'host',
    label: 'devbox',
    available: async () => true,
    ...(opts.copies ? { copies: opts.copies } : {}),
    // The host runs the replica program (D13's opt-in) unless a test says otherwise.
    program: () => opts.program ?? 'replica',
    post: async (payload, o): Promise<CloudReplicaReply> => {
      const text = JSON.stringify(payload)
      const body = JSON.parse(text) as Record<string, unknown>
      const n = Array.isArray(body.rows) ? body.rows.length : Array.isArray(body.entries) ? body.entries.length : 1
      calls.push({ op: String(body.op), kind: String(body.kind), n, ...(typeof body.digest === 'string' ? { digest: true } : {}), bytes: text.length })
      if (failing > 0) { failing--; return { ok: false, outcome: 'failed', error: 'connection lost' } }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/bridge/replica`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: text, signal: AbortSignal.timeout(o?.timeoutMs ?? 60_000),
        })
        const json = await res.json().catch(() => null) as Record<string, unknown> | null
        if (res.ok && json) return { ok: true, reply: json }
        if (res.status === 404 || res.status === 405) return { ok: false, outcome: 'unsupported', status: res.status, ...(typeof json?.error === 'string' ? { error: json.error } : {}) }
        return { ok: false, outcome: 'failed', status: res.status, error: typeof json?.error === 'string' ? json.error : undefined, ...(json ? { body: json } : {}) }
      } catch (err) {
        return { ok: false, outcome: 'failed', error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
  return {
    target,
    calls,
    failNext: (n) => { failing = n },
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

/** The steps since `from`, as `op:kind` (puts with their row count). */
export function stepsSince(calls: readonly StepCall[], from = 0): string[] {
  return calls.slice(from).map((c) => (c.op === 'put' ? `put:${c.kind}:${c.n}${c.digest ? '+digest' : ''}` : `${c.op}:${c.kind}`))
}
