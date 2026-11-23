/**
 * `walnut leader`: the switchable leader from the CLI (docs/reference/leader-switch.md).
 *
 *   leader switch --to <machine>   hand the lead to another machine of leader_switch.machines
 *   leader switch --back           the same, back to the machine this Walnut came from
 *   leader switch --resume         finish (or roll back) a switch a kill left half done
 *   leader switch --cancel         cancel a switch that has not committed
 *   leader status                  the switch under way, the marker, the witnesses' record, and
 *                                  the outward ops an earlier holder left with no known outcome
 *   leader witnesses init          set up the witness directories of leader_switch.witnesses
 *
 * Run it with the leader's home (OPEN_WALNUT_HOME, default this Walnut's). Experiment
 * switchable_leader; off, every subcommand refuses and changes nothing.
 */
import { WALNUT_HOME } from '../constants.js'

const fail = (err: unknown) => {
  console.error(`leader: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}

export async function runLeaderSwitchCommand(options: Record<string, unknown>): Promise<void> {
  const { runLeaderSwitch } = await import('../core/leader/switch/flow.js')
  const t0 = Date.now()
  try {
    const st = await runLeaderSwitch({
      home: typeof options.home === 'string' ? options.home : WALNUT_HOME,
      ...(typeof options.to === 'string' ? { to: options.to } : {}),
      back: !!options.back,
      resume: !!options.resume,
      cancel: !!options.cancel,
      out: (line) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`),
    })
    if (st.step === 'done') {
      console.log(`Switched: ${st.to} leads (permit record ${st.commit}). Downtime ${st.downtimeMs !== undefined ? `${(st.downtimeMs / 1000).toFixed(1)} s` : 'unknown'}.`)
      console.log(`The old home ${st.sourceHome} is kept as it was and marked handed over; it never leads again.`)
      console.log('Not undone by a switch back: anything already sent outward (mail, pushes, posts).')
      if (st.outcomeUnknown?.length) console.log(`Outcome unknown, check by hand (never sent again): ${st.outcomeUnknown.join(', ')}`)
      const { readUnresolvedOps } = await import('../core/leader/switch/records.js')
      const ops = readUnresolvedOps(st.targetHome)
      if (ops.length) console.log(`Outward ops ${st.from} registered and never reported (never sent again, check by hand): ${ops.map((o) => o.id).join(', ')}`)
    } else {
      console.log(`Rolled back: ${st.rollbackWhy ?? 'unknown reason'}. ${st.from} leads as before.`)
      process.exitCode = 3
    }
  } catch (err) {
    fail(err)
  }
}

export async function runLeaderStatus(options: Record<string, unknown>): Promise<void> {
  try {
    const home = typeof options.home === 'string' ? options.home : WALNUT_HOME
    const m = await import('../core/leader/switch/index.js')
    const cfg = m.readHomeSwitchConfig(home)
    if (!cfg.flag) return fail('the experiment switchable_leader is off')
    const { readUnresolvedOps } = await import('../core/leader/switch/records.js')
    const out: Record<string, unknown> = { home, marker: m.readMarker(home), switch: m.readSwitchState(home), history: m.readHistory(home), unresolvedOps: readUnresolvedOps(home) }
    if (cfg.settings) {
      const { makeWitnessReader, NoLeaderServerToRead } = await import('../core/leader/switch/witness-reader.js')
      const { summarize } = await import('../core/leader/switch/records.js')
      // Remote witnesses are read by this machine's running leader server, never by this command.
      const me = m.machineById(cfg.settings, m.permitHolderId() ?? '')
      const server = { api: async (method: string, urlPath: string) => {
        if (!me) throw new Error('this machine is not one of leader_switch.machines')
        const res = await fetch(`http://127.0.0.1:${me.port}${urlPath}`, { method, signal: AbortSignal.timeout(20_000) })
        return { status: res.status, json: await res.json().catch(() => null) as unknown }
      } }
      try {
        const r = await makeWitnessReader(m.permitHolderId() ?? 'status-reader', cfg.settings, () => [server])()
        out.witnesses = { answered: r.answered, of: cfg.settings.witnesses.length, standing: r.standing === undefined ? 'no majority' : summarize(r.standing) }
      } catch (err) {
        if (!(err instanceof NoLeaderServerToRead)) throw err
        out.witnesses = { unavailable: err.message }
      }
    } else out.problem = cfg.problem
    console.log(JSON.stringify(out, null, 2))
  } catch (err) {
    fail(err)
  }
}

export async function runLeaderWitnessesInit(options: Record<string, unknown>): Promise<void> {
  try {
    const home = typeof options.home === 'string' ? options.home : WALNUT_HOME
    const m = await import('../core/leader/switch/index.js')
    const cfg = m.readHomeSwitchConfig(home)
    if (!cfg.flag) return fail('the experiment switchable_leader is off')
    if (!cfg.settings) return fail(cfg.problem ?? 'no leader_switch section')
    const list = cfg.settings.witnesses.map((w) => w.id)
    const r = m.setUpLocalWitnesses(cfg.settings.witnesses.filter(m.isLocalWitness), list)
    console.log(`Witnesses set up: ${r.made.join(', ') || 'none'}; already set up: ${r.kept.join(', ') || 'none'}`)
    // A remote witness is set up by its own machine's service, asked by the running leader server over its host links.
    const remote = cfg.settings.witnesses.filter(m.isRemoteWitness)
    if (remote.length) {
      const me = m.machineById(cfg.settings, m.permitHolderId() ?? '')
      const res = me ? await fetch(`http://127.0.0.1:${me.port}/api/leader/witnesses/init`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(120_000) }).catch(() => null) : null
      const body = res ? await res.json().catch(() => null) as { results?: Array<{ witness: string; host: string; ok: boolean; made?: boolean; error?: string }>; why?: string } | null : null
      if (!body?.results) {
        console.log(`Remote witnesses ${remote.map((w) => w.id).join(', ')} not set up: ${body?.why ?? 'this machine\'s leader server did not answer'}. Start the leader (it holds the permission) and run this again.`)
        process.exitCode = 1
      } else {
        for (const x of body.results) console.log(`Witness ${x.witness} on ${x.host}: ${x.ok ? (x.made ? 'set up' : 'already set up') : `not set up (${x.error})`}`)
        if (body.results.some((x) => !x.ok)) process.exitCode = 1
      }
    }
  } catch (err) {
    fail(err)
  }
}
