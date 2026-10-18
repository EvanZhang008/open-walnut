/**
 * A new Ask Walnut from the phone while the Mac sleeps (docs/plan/walnut-replica-servers-impl.md,
 * WP12): the host replica files the ask's task, the host's daemon starts the session from the
 * Mac's spawn template with the persona the Mac copied, its answer is read through the replica,
 * and once the Mac wakes it lists the ask under Ask Walnut on that host, linked to its task,
 * stops it, and resumes it cold. Neither spawn mounts a walnut MCP server: like every session
 * the Mac runs on a host, the ask's walnut tools are the `walnut` CLI through that host
 * daemon's gateway socket.
 *
 * Every piece is a real process (tests/helpers/replica-cluster.ts): a non-ephemeral Mac
 * server child with its own daemon, a host daemon twin, the replica that daemon starts from
 * the Mac's own `server.configure`, and the cluster's mock CLI as `claude` on the host. The
 * Mac sleeps by SIGSTOP (its sockets stay open and go silent), as a lid close does.
 *
 * Twins: both (source, then standalone) when bun is on this machine, the source twin alone
 * otherwise; REPLICA_CLUSTER_TWINS=source|standalone|source,standalone picks.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BUN, startReplicaCluster, waitFor, type ReplicaCluster, type Twin } from '../helpers/replica-cluster.js'

const TWINS = (process.env.REPLICA_CLUSTER_TWINS ?? (BUN ? 'source,standalone' : 'source')).split(',').map((t) => t.trim()).filter((t): t is Twin => t === 'source' || t === 'standalone')

const ASK = 'Why is the marina build red today?'
const FOLLOW_UP = 'And which test failed first?'

/** Files under `dir` (a few levels down) whose name matches. */
function filesNamed(dir: string, re: RegExp, depth = 4): string[] {
  let names: fs.Dirent[] = []
  try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const out: string[] = []
  for (const n of names) {
    const p = path.join(dir, n.name)
    if (n.isDirectory() && depth > 0) out.push(...filesNamed(p, re, depth - 1))
    else if (n.isFile() && re.test(n.name)) out.push(p)
  }
  return out
}

describe.each(TWINS)('a new Ask Walnut on the host while the Mac sleeps (%s twin)', (twin) => {
  let c: ReplicaCluster
  let token = ''
  let sid = ''
  let taskId = ''
  const hostDaemon = () => path.join(c.base, 'hd')
  const appCli = () => path.join(c.base, 'app', 'dist', 'cli.js')

  /** The rows of an ask's history as the phone reads them through the replica. */
  async function historyRows(): Promise<string[]> {
    const r = await c.replica('GET', `/api/v1/sessions/${sid}/history?tail=50`, { token })
    if (r.status !== 200) return []
    return (r.json.messages as Array<{ role: string; text: string }>).map((m) => `${m.role}: ${m.text}`)
  }

  beforeAll(async () => {
    c = await startReplicaCluster({ twin })
    token = await c.pairDevice('acme-phone')
    // What a new ask on the host needs from the Mac: its personas copy on the replica and
    // its spawn template on the host daemon (pushed with the host server's configure).
    await waitFor(() => {
      try { return fs.readFileSync(path.join(c.replicaData, 'cache', 'replica', 'personas.json'), 'utf8').includes('"general"') } catch { return false }
    }, 180_000, 'the personas copy to reach the replica')
    await waitFor(() => filesNamed(hostDaemon(), /^spawn-template-[0-9a-f]+\.json$/).length > 0, 180_000, 'the spawn template to reach the host daemon')
    c.sleepMac()
    await c.waitAway(token)
    // Away for writes too: the quiet window has passed, not one failed stream.
    await waitFor(async () => (await c.replica('GET', '/api/v1/tasks', { token })).headers['x-walnut-offline-why'] === 'away', 60_000, 'the replica to say away', 250)
  }, 900_000)

  afterAll(async () => { await c?.stop() }, 120_000)

  it('the phone starts an ask on the host: the session runs from the Mac\'s template and its answer is read through the replica', async () => {
    const r = await c.replica('POST', '/api/v1/sessions', { token, body: { walnutAgent: true, message: ASK } })
    expect(r.status, r.text.slice(0, 400)).toBe(201)
    sid = r.json.sessionId as string
    taskId = r.json.taskId as string
    expect(sid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(r.json.title).toBe('Ask Walnut')
    // The task is the replica's (kept for the Mac), filed where the Mac files an ask.
    const task = await c.replica('GET', `/api/v1/tasks/${taskId}`, { token })
    expect(task.status, task.text.slice(0, 300)).toBe(200)
    expect(task.json.task).toMatchObject({ project: 'Ask Walnut', replica_sync: 'pending' })
    // The session list shows it at once (the replica's own row until the Mac's copy lists it).
    const list = await c.replica('GET', '/api/v1/sessions', { token })
    expect(list.status).toBe(200)
    expect(JSON.stringify(list.json)).toContain(sid)
    // The answer, read on the host through the replica (the phone's and the console's routes).
    await waitFor(async () => (await historyRows()).includes(`assistant: echo: ${ASK}`), 120_000, 'the ask\'s answer', 500)
    expect((await historyRows())).toContain(`user: ${ASK}`)
    const web = await c.replica('GET', `/api/sessions/${sid}/history`, { token })
    expect(web.status, web.text.slice(0, 300)).toBe(200)
    expect(web.text).toContain(`echo: ${ASK}`)
    // A follow-up reaches the same CLI (the host's follower.send) and its answer comes back.
    const send = await c.replica('POST', `/api/v1/sessions/${sid}/messages`, { token, body: { text: FOLLOW_UP } })
    expect(send.status, send.text.slice(0, 300)).toBeLessThan(300)
    await waitFor(async () => (await historyRows()).includes(`assistant: echo: ${FOLLOW_UP}`), 120_000, 'the follow-up\'s answer', 500)
    // What the daemon spawned (its resume record keeps the argv): the template, the copied
    // persona as ONE argv string (the Mac's own flag), no walnut MCP mount, and the person's
    // words on stdin only.
    const rec = JSON.parse(fs.readFileSync(filesNamed(hostDaemon(), new RegExp(`^${sid}\\.json$`)).find((p) => p.includes('resume-records'))!, 'utf8')) as { args: string[] }
    expect(rec.args[0]).toBe('claude')
    expect(rec.args[rec.args.indexOf('--session-id') + 1]).toBe(sid)
    expect(rec.args[rec.args.indexOf('--permission-mode') + 1]).toBe('default')
    const copied = JSON.parse(fs.readFileSync(path.join(c.replicaData, 'cache', 'replica', 'personas.json'), 'utf8')) as { rows: Record<string, { systemPrompt: string }> }
    const persona = rec.args[rec.args.indexOf('--append-system-prompt') + 1]!
    expect(persona.startsWith(copied.rows.general!.systemPrompt)).toBe(true)
    expect(persona).toContain(taskId)
    expect(rec.args).not.toContain('--mcp-config')
    expect(rec.args.join('\n')).not.toContain(appCli())
    expect(rec.args.join('\n')).not.toContain(ASK)
  }, 300_000)

  it('the Mac wakes: the ask is listed under Ask Walnut on that host and linked to its task, the Mac stops it, and resumes it cold with no walnut mount', async () => {
    expect(sid, 'the first test started the ask').not.toBe('')
    c.wakeMac()
    await c.waitBack(token)
    // Adopted on the drain: the task under Ask Walnut, the session on devbox.
    const session = await waitFor(async () => {
      const r = await c.mac('GET', `/api/v1/sessions/${sid}`)
      return r.status === 200 ? r.json : null
    }, 120_000, 'the Mac to adopt the session', 500)
    expect(JSON.stringify(session)).toContain('devbox')
    const task = await c.mac('GET', `/api/v1/tasks/${taskId}`)
    expect(task.status).toBe(200)
    expect(task.json.task).toMatchObject({ project: 'Ask Walnut' })
    expect(JSON.stringify(task.json)).not.toContain('replica_sync')
    const asks = await c.mac('GET', '/api/v1/asks')
    expect(asks.status, JSON.stringify(asks.json).slice(0, 300)).toBe(200)
    expect((asks.json.asks as Array<{ id: string }>).map((a) => a.id)).toContain(taskId)
    // The task names its session, as the Mac's own start links one: the Ask panel opens it.
    const raw = await c.mac('GET', `/api/tasks/${taskId}`)
    expect(raw.status).toBe(200)
    expect(JSON.stringify(raw.json)).toContain(`"session_id":"${sid}"`)
    // The Mac stops it (owner-home-v1: the spawn journal names the Mac's Walnut, so the
    // host's daemon honours it), then a message starts it again from the Mac.
    const stop = await c.mac('POST', `/api/sessions/${sid}/terminate`, {})
    expect(stop.status, JSON.stringify(stop.json).slice(0, 300)).toBe(200)
    const again = 'Is it green now?'
    const send = await c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: again })
    expect(send.status, JSON.stringify(send.json).slice(0, 300)).toBeLessThan(300)
    // The daemon keeps the last spawn's argv per session (its resume record): a --resume one is the cold resume.
    const recordFile = () => filesNamed(hostDaemon(), new RegExp(`^${sid}\\.json$`)).find((p) => p.includes('resume-records'))
    // A wait that fails says what the Mac logged about it (the cluster's own log tail).
    const told = <T,>(p: Promise<T>): Promise<T> => p.catch((e: Error) => { e.message += `\n--- mac ---\n${c.logs().mac.split('\n').filter((l) => l.includes(sid) || /resume|start/i.test(l)).slice(-40).join('\n')}`; throw e })
    await told(waitFor(() => {
      const f = recordFile()
      try { return f ? (JSON.parse(fs.readFileSync(f, 'utf8')) as { args: string[] }).args.includes('--resume') : false } catch { return false }
    }, 120_000, 'the cold resume on the host', 500))
    await told(waitFor(async () => {
      const r = await c.mac('GET', `/api/v1/sessions/${sid}/history?tail=50`)
      return r.status === 200 && JSON.stringify(r.json).includes(`echo: ${again}`)
    }, 120_000, 'the resumed answer', 500))
    // The cold resume's argv: --resume, and no walnut MCP mount (neither the Mac's nor the host's app).
    const rec = JSON.parse(fs.readFileSync(recordFile()!, 'utf8')) as { args: string[] }
    expect(rec.args[rec.args.indexOf('--resume') + 1]).toBe(sid)
    expect(rec.args).not.toContain('--session-id')
    expect(rec.args).not.toContain('--mcp-config')
  }, 400_000)
})
