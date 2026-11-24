/**
 * `walnut leader`: the switchable leader from the CLI (docs/reference/leader-switch.md).
 *
 *   leader switch --to <machine>   hand the lead to another machine of leader_switch.machines; run on
 *                                  that machine (--to itself, or --standby-dir), it checks there and asks
 *                                  the leader over its host link to begin
 *   leader switch --back           the same, back to the machine this Walnut came from
 *   leader switch --resume         finish (or roll back) a switch a kill left half done
 *   leader switch --cancel         cancel a switch that has not committed
 *   leader switch --status         this machine's switch jobs, the witnesses, each machine's newest note
 *   leader switch --job source|target   one machine's job (the command starts it, detached)
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
  const t0 = Date.now()
  const out = (line: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`)
  const home = typeof options.home === 'string' ? options.home : WALNUT_HOME
  try {
    // The jobs themselves (the command below starts them, detached): exit 0 done, 3 rolled back, 1 refused.
    if (options.job === 'source') {
      const { runSourceJob } = await import('../core/leader/switch/source-job.js')
      const st = await runSourceJob({ home, ...(typeof options.to === 'string' ? { to: options.to } : {}), ...(typeof options.switch === 'string' ? { switchId: options.switch } : {}), back: !!options.back, resume: !!options.resume, out })
      process.exitCode = st.step === 'done' ? 0 : 3
      return
    }
    if (options.job === 'target') {
      const { runTargetJob } = await import('../core/leader/switch/target-job.js')
      if (typeof options.switch !== 'string' || typeof options.standbyDir !== 'string') return fail('--job target needs --switch <id> and --standby-dir <dir>')
      const r = await runTargetJob({ standbyDir: options.standbyDir, switchId: options.switch, check: !!options.check, out })
      process.exitCode = 'step' in r ? (r.step === 'done' ? 0 : 3) : (r.ok ? 0 : 1)
      return
    }
    if (options.job !== undefined) return fail(`--job is source or target, not ${String(options.job)}`)
    if (options.status) {
      const { switchStatus } = await import('../core/leader/switch/switch-command.js')
      console.log(JSON.stringify(await switchStatus({ home }), null, 2))
      return
    }
    const { runLeaderSwitch } = await import('../core/leader/switch/switch-command.js')
    const r = await runLeaderSwitch({
      home,
      ...(typeof options.to === 'string' ? { to: options.to } : {}),
      back: !!options.back, resume: !!options.resume, cancel: !!options.cancel,
      ...(typeof options.standbyDir === 'string' ? { standbyDir: options.standbyDir } : {}),
      out: (line) => console.log(line),
    })
    const st = r.source
    if (r.code === 0 && st) {
      const dt = r.target?.downtimeMs
      console.log(`Switched: ${st.to} leads (permit record ${st.commit}). Downtime ${dt !== undefined ? `${(dt / 1000).toFixed(1)} s` : 'unknown on this machine'}.`)
      console.log(`The old home ${st.sourceHome} is kept as it was and marked handed over; it never leads again.`)
      console.log('Not undone by a switch back: anything already sent outward (mail, pushes, posts).')
      if (r.target?.outcomeUnknown?.length) console.log(`Outcome unknown, check by hand (never sent again): ${r.target.outcomeUnknown.join(', ')}`)
      const { readUnresolvedOps } = await import('../core/leader/switch/records.js')
      const ops = readUnresolvedOps(st.targetHome)
      if (ops.length) console.log(`Outward ops ${st.from} registered and never reported (never sent again, check by hand): ${ops.map((o) => o.id).join(', ')}`)
    } else if (r.code === 0) {
      // Begun on this machine (candidate-command.ts): no source state here; its message ends with the hand-off line.
      console.log(r.message)
    } else if (r.code === 3) {
      console.log(`Rolled back: ${r.message.replace(/^rolled back: /, '')}. ${st?.from ?? 'The old leader'} leads as before.`)
    } else {
      console.error(`leader: ${r.message}`)
    }
    process.exitCode = r.code
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
    let cfg = m.readHomeSwitchConfig(home)
    if (!cfg.flag) return fail('the experiment switchable_leader is off')
    if (!cfg.settings) return fail(cfg.problem ?? 'no leader_switch section')
    const me = m.permitHolderId()
    const elsewhere = cfg.settings.witnesses.filter(m.isRemoteWitness)
    const self = m.machineById(cfg.settings, me ?? '') ?? m.machineByHome(cfg.settings, home)
    const api = (method: string, urlPath: string) => (self
      ? fetch(`http://127.0.0.1:${self.port}${urlPath}`, { method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}), signal: AbortSignal.timeout(180_000) })
        .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) as Record<string, unknown> | null })).catch(() => null)
      : Promise.resolve(null))
    if (elsewhere.length) {
      // Keys are minted only on the leader: its server runs the permission here (waiting for its first lead, or leading).
      // A home that is a copy (a standby, a handed-over home) never mints: a key minted there would differ from the
      // leader's, and a witness never takes another key.
      const st = await api('GET', '/api/leader/status')
      const permit = st?.json?.permit as { state?: string } | null | undefined
      if (!permit || st?.json?.trial || (permit.state !== 'leading' && permit.state !== 'waiting')) {
        return fail(`run this on the leader, with its server running the permission (here: ${!st ? 'no server answers' : !permit ? 'the server runs no permission' : st.json?.trial ? 'a trial start' : `the permission is ${permit.state}`})`)
      }
    }
    // Each witness kept by a machine gets its own key, once: in the leader data (config.yaml, sensitive)
    // and, by its setup below, beside its record on its machine. Never printed.
    const { mintWitnessKeys } = await import('../core/leader/switch/witness-keys.js')
    const minted = await mintWitnessKeys(home)
    if (minted.length) {
      console.log(`Minted a key for ${minted.join(', ')} (kept in config.yaml leader_switch, which only travels with the standby copy)`)
      cfg = m.readHomeSwitchConfig(home)
      if (!cfg.settings) return fail(cfg.problem ?? 'no leader_switch section')
    }
    const list = cfg.settings.witnesses.map((w) => w.id)
    const r = m.setUpLocalWitnesses(cfg.settings.witnesses.filter(m.isLocalWitness), list)
    console.log(`Witnesses set up: ${r.made.join(', ') || 'none'}; already set up: ${r.kept.join(', ') || 'none'}`)
    // A witness kept by a machine is set up by this machine's leader server: one this machine keeps in its own
    // state dir, one on a host over the server's link (or registered reach before it leads), one with only a door on
    // the companion's lane; once the server leads, a missing one joins through a list change. The server reads them
    // all first: the setup's evidence.
    if (elsewhere.length) {
      const res = await api('POST', '/api/leader/witnesses/init')
      const body = res?.json as { results?: Array<{ witness: string; at: string; ok: boolean; made?: boolean; joined?: boolean; error?: string }>; why?: string } | null | undefined
      if (!body?.results) {
        console.log(`Witnesses ${elsewhere.map((w) => w.id).join(', ')} not set up: ${body?.why ?? 'this machine\'s leader server did not answer'}. Start the leader server and run this again.`)
        process.exitCode = 1
      } else {
        for (const x of body.results) console.log(`Witness ${x.witness} on ${x.at}: ${x.ok ? (x.joined ? 'joined (set up as joining, added by a list change)' : x.made ? 'set up' : 'already set up') : `not set up (${x.error})`}`)
        if (body.results.some((x) => !x.ok)) process.exitCode = 1
      }
    }
  } catch (err) {
    fail(err)
  }
}
