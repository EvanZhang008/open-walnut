#!/usr/bin/env bun
/**
 * A small host over real SSH through an upgrade and back: a released Walnut's leader sets up a
 * Linux host too small for a copy (daemon only), the leader is updated to the build under test,
 * the experiment `service_without_copy` turns the host into the one Walnut service without a copy,
 * it is turned off again, and the released leader takes the same data and the same host back.
 *
 *   bun scripts/release-rehearsal/field-packs.mjs build --out <packs> --target linux-x64 --reuse-web
 *   bun scripts/release-rehearsal/small-host-copyless.mjs --field-json <packs>/field.json --claude <file>
 *       [--old 0.6.37] [--work <dir>] [--claude-env KEY=VALUE ...] [--keep]
 *
 * The build under test is the field rehearsal's release (field-packs.mjs: this checkout, committed,
 * at a version above the registry's), its linux-x64 package's file; --new-file names a compiled
 * file instead. Its version must differ from --old: a leader whose version is a published one
 * sends the host that release's own file, so the host would never run the build under test.
 *
 * Two containers on the machine's Docker (no host network, no ~/.ssh of the person running it):
 *   the host    Debian with sshd and cron (a VPS's boot start), 1500 MB of memory, a 2 GB tmpfs
 *               home; Claude Code from --claude, run with the --claude-env lines (its model
 *               access). Nothing of Walnut: every Walnut file on it comes from the leader.
 *   the leader  the same image; the old release's compiled file (the registry's
 *               @open-walnut/linux-x64, as its launcher installs it, field.mjs releasedPlatformFile)
 *               or --new-file, run on one data home kept in --work; it reaches the host by SSH
 *               with a key made for the run.
 *
 * Stages (each judged; summary.json in --work):
 *   old         the released leader adds the host: its daemon runs there with no follower (0.6.37 runs
 *               none by default; a later release judges the host below the floors), a session answers.
 *   upgrade     the build under test on the same data: the host's daemon is updated, still no
 *               follower (the experiment is off), the session answers again.
 *   on          the experiment on: the host runs the one service without a copy (one process, the
 *               follower inside the daemon's service), the session answers; its memory is noted.
 *   off         the experiment off: the follower goes, the gate is back, the session answers.
 *   back        the experiment on again, then the released leader on the same data: it connects,
 *               the host's sessions answer (the old one and a new one), and what it does with the
 *               record the new build left (host-servers.json `working`) is written down.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { releasedPlatformFile } from './field.mjs'
import { readFieldJson } from './field-packs.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nonce = crypto.randomBytes(3).toString('hex')
const IMAGE = 'walnut-rehearsal-small-host:1'
const HOST = `walnut-rh-small-${nonce}`
const LEADER = `walnut-rh-leader-${nonce}`
const PORT = 3977
/** A host's daemon is replaced at most once per 20 minutes (daemon-update-gap.ts): a minute here, so a stage need not wait out the gap. */
const UPDATE_GAP_MS = 60_000
const DOCKERFILE = `FROM debian:bookworm-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends openssh-server openssh-client cron ca-certificates procps curl git >/dev/null \\
 && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd && useradd -m -u 1000 -s /bin/bash walnut \\
 && sed -i 's/^#\\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
CMD ["/bin/sh", "-c", "cron && exec /usr/sbin/sshd -D -e"]
`

function parseArgs(argv) {
  const out = { old: '0.6.37', newFile: null, fieldJson: null, claude: null, claudeEnv: [], work: null, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--old') out.old = argv[++i]
    else if (a === '--new-file') out.newFile = path.resolve(argv[++i])
    else if (a === '--field-json') out.fieldJson = path.resolve(argv[++i])
    else if (a === '--claude') out.claude = path.resolve(argv[++i])
    else if (a === '--claude-env') out.claudeEnv.push(argv[++i])
    else if (a === '--work') out.work = path.resolve(argv[++i])
    else if (a === '--keep') out.keep = true
    else throw new Error(`unknown argument ${a}`)
  }
  if (!out.fieldJson === !out.newFile) throw new Error('name the build under test: --field-json <packs>/field.json (field-packs.mjs build) or --new-file <walnut-linux-x64>')
  if (out.newFile && !fs.existsSync(out.newFile)) throw new Error(`${out.newFile} is not there`)
  if (!out.claude || !fs.existsSync(out.claude)) throw new Error('--claude names a Claude Code file for the host')
  for (const e of out.claudeEnv) if (!/^[A-Z_][A-Z0-9_]*=/.test(e)) throw new Error(`--claude-env takes KEY=VALUE, not ${e}`)
  return out
}

/** The release's linux-x64 file from a field.json (field-packs.mjs), unpacked into `dir`. */
function releaseFileOf(fieldJson, dir) {
  const doc = readFieldJson(fieldJson)
  const tgz = doc.release.tarballs.find((t) => path.basename(t).startsWith('open-walnut-linux-x64-'))
  if (!tgz) throw new Error(`${fieldJson} names no linux-x64 package`)
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('tar', ['xzf', tgz, '-C', dir])
  const file = path.join(dir, 'package', 'walnut')
  if (!fs.existsSync(file)) throw new Error(`${tgz} has no walnut file`)
  fs.chmodSync(file, 0o755)
  return file
}

const docker = (args, opts = {}) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts })
const dockerOk = (args) => spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 << 20 })
const inHost = (cmd, user = 'walnut') => docker(['exec', '-u', user, HOST, 'sh', '-c', cmd])
const ipOf = (name) => docker(['inspect', name, '--format', '{{.NetworkSettings.IPAddress}}']).trim()

/** Run in the leader's container: the leader's env (its data home, its port). */
function inLeader(cmd, { allowFail = false } = {}) {
  const r = dockerOk(['exec', LEADER, 'sh', '-c', cmd])
  if (r.status !== 0 && !allowFail) throw new Error(`leader: ${cmd.slice(0, 120)} exited ${r.status}: ${(r.stderr || r.stdout).slice(-600)}`)
  return r.stdout
}
function api(method, p, body) {
  const data = body === undefined ? '' : `-H 'content-type: application/json' --data '${JSON.stringify(body).replace(/'/g, "'\\''")}'`
  const text = inLeader(`curl -s -m 60 -X ${method} ${data} http://127.0.0.1:${PORT}${p}`, { allowFail: true })
  try { return JSON.parse(text) } catch { return { raw: text.slice(0, 400) } }
}
function tool(name, args) {
  const text = inLeader(`OPEN_WALNUT_API_URL=http://127.0.0.1:${PORT} /work/bin/leader tools call ${name} '${JSON.stringify(args).replace(/'/g, "'\\''")}'`, { allowFail: true })
  try { return JSON.parse(text) } catch { return { raw: text.slice(0, 400) } }
}

async function until(what, probe, ms = 300_000, everyMs = 3_000) {
  const deadline = Date.now() + ms
  for (;;) {
    let v = null
    try { v = await probe() } catch { v = null }
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}`)
    await sleep(everyMs)
  }
}

function startHost(work, opts) {
  fs.mkdirSync(path.join(work, 'image'), { recursive: true })
  fs.writeFileSync(path.join(work, 'image', 'Dockerfile'), DOCKERFILE)
  docker(['build', '-q', '-t', IMAGE, path.join(work, 'image')], { stdio: ['ignore', 'pipe', 'inherit'] })
  docker(['run', '-d', '--init', '--name', HOST, '--memory', '1500m', '--memory-swap', '1500m',
    '--tmpfs', '/home/walnut:rw,exec,size=2g,uid=1000,gid=1000,mode=0755', '--add-host', 'host.docker.internal:host-gateway', IMAGE])
  const pub = fs.readFileSync(path.join(work, 'key.pub'), 'utf8').trim()
  inHost(`mkdir -p ~/.ssh ~/work && echo '${pub}' > ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`)
  docker(['cp', '-L', opts.claude, `${HOST}:/usr/local/bin/claude-real`])
  const wrapper = ['#!/bin/sh', ...opts.claudeEnv.map((e) => `export ${e.replace(/=(.*)$/, (_, v) => `='${v.replace(/'/g, '')}'`)}`), 'exec /usr/local/bin/claude-real "$@"'].join('\n')
  docker(['exec', '-u', 'root', HOST, 'sh', '-c', `printf '%s\\n' '${wrapper.replace(/'/g, "'\\''")}' > /usr/local/bin/claude && chmod 755 /usr/local/bin/claude /usr/local/bin/claude-real`])
}

function startLeaderBox(work) {
  const uid = `${process.getuid()}:${process.getgid()}`
  // --init: a stopped leader is reaped, not left a zombie that still answers kill -0.
  docker(['run', '-d', '--init', '--name', LEADER, '--user', uid, '-e', 'HOME=/work/leader-home', '-v', `${work}:/work`, IMAGE, 'sleep', 'infinity'])
  // ssh needs a passwd entry for the user it runs as: this run's own uid, its home in the work dir.
  docker(['exec', '-u', 'root', LEADER, 'sh', '-c', `groupadd -o -g ${process.getgid()} leader && useradd -o -u ${process.getuid()} -g ${process.getgid()} -d /work/leader-home -M leader`])
  inLeader('mkdir -p /work/leader-home/.ssh /work/bin && cp /work/key /work/leader-home/.ssh/id_ed25519 && chmod 600 /work/leader-home/.ssh/id_ed25519')
}

let serverLogs = 0
/** Start `file` as the leader on the run's one data home; returns its log's path. */
async function leaderUp(work, file, label) {
  // Named as build-binary names it, alone in its dir: the file a host gets is this one (host-file.ts siblings).
  const version = execFileSync(file, ['--version'], { encoding: 'utf8' }).trim().split(/\s/)[0]
  const dir = path.join(work, 'bin', version)
  if (!fs.existsSync(path.join(dir, 'walnut-linux-x64'))) {
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(file, path.join(dir, 'walnut-linux-x64'))
    fs.chmodSync(path.join(dir, 'walnut-linux-x64'), 0o755)
  }
  fs.rmSync(path.join(work, 'bin', 'leader'), { force: true })
  fs.symlinkSync(path.join('/work/bin', version, 'walnut-linux-x64'), path.join(work, 'bin', 'leader'))
  const log = `server-${++serverLogs}-${label}.log`
  inLeader(`cd /work && OPEN_WALNUT_HOME=/work/data WALNUT_NO_UPDATE_CHECK=1 WALNUT_DAEMON_UPDATE_MIN_GAP_MS=${UPDATE_GAP_MS} setsid nohup /work/bin/${version}/walnut-linux-x64 web --port ${PORT} > /work/${log} 2>&1 < /dev/null & echo $! > /work/leader.pid`)
  await until(`the ${label} leader to answer`, () => inLeader(`curl -sf -o /dev/null http://127.0.0.1:${PORT}/api/config && echo up`, { allowFail: true }).includes('up'), 180_000, 1_000)
  return path.join(work, log)
}
async function leaderDown() {
  inLeader('kill -TERM $(cat /work/leader.pid) 2>/dev/null; true')
  await until('the leader to stop', () => !inLeader('kill -0 $(cat /work/leader.pid) 2>/dev/null && echo alive', { allowFail: true }).includes('alive'), 90_000, 1_000)
}

/** The host's Walnut processes (pid, rss in KB, args), as ps sees them there. */
function hostProcs() {
  return inHost('ps -eo pid=,ppid=,rss=,args=').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { const [pid, ppid, rss, ...a] = l.split(/\s+/); return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss), args: a.join(' ') } })
    .filter((p) => /daemon|walnut|claude-real/.test(p.args) && !/sshd|ps -eo/.test(p.args))
}
const view = () => api('GET', '/api/host-servers')?.hosts?.find((h) => h.hostKey === 'small')?.view ?? null
const working = (work) => { try { return JSON.parse(fs.readFileSync(path.join(work, 'data', 'host-servers.json'), 'utf8')).small?.working ?? null } catch { return null } }

/** Ask the session to say `words`; resolves once its answer says them. */
async function answers(task, words) {
  const r = tool('task_send', { to: task, text: `Reply with exactly: ${words}`, expect_reply: false })
  if (r.ok === false || r.raw) throw new Error(`task_send to ${task}: ${JSON.stringify(r).slice(0, 400)}`)
  return until(`the session of ${task} to answer ${words}`, () => {
    const h = tool('task_history', { id: task, compact: true, limit: 4 })
    return (h.messages ?? []).some((m) => m.role === 'assistant' && String(m.text ?? '').includes(words)) ? true : null
  }, 240_000, 5_000)
}
async function newSession(title, words) {
  const r = tool('task_create', { title, message: `Reply with exactly: ${words}`, host: 'small', cwd: '/home/walnut/work', mode: 'bypass' })
  const id = r.id ?? r.taskId
  if (!id) throw new Error(`task_create on the host: ${JSON.stringify(r).slice(0, 400)}`)
  await until(`"${title}" to answer`, () => (tool('task_history', { id, compact: true, limit: 4 }).messages ?? []).some((m) => m.role === 'assistant' && String(m.text ?? '').includes(words)), 300_000, 5_000)
  return id
}
/** The boot start (a cron line here) that puts the daemon under the service launcher; an older leader may set it up alone. */
function bootStart() { return api('POST', '/api/v1/hosts/small/boot-start')?.host?.daemon?.bootStart ?? null }
const experiment = (on) => api('PUT', '/api/config', { experimental: { service_without_copy: on } })

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const work = opts.work ?? fs.mkdtempSync(path.join(os.tmpdir(), 'small-host-copyless-'))
  fs.mkdirSync(path.join(work, 'bin'), { recursive: true })
  if (opts.fieldJson) opts.newFile = releaseFileOf(opts.fieldJson, path.join(work, 'new'))
  const newVersion = execFileSync(opts.newFile, ['--version'], { encoding: 'utf8' }).trim()
  if (newVersion.split(/\s/)[0] === opts.old) throw new Error(`the build under test is ${opts.old} too (${newVersion}): build it at a version above (field-packs.mjs build)`)
  if (/\+dirty/.test(newVersion)) throw new Error(`the build under test has uncommitted changes (${newVersion}): a host takes only a build of a commit`)
  const summary = { old: opts.old, newFile: opts.newFile, newVersion, stages: {} }
  const save = () => fs.writeFileSync(path.join(work, 'summary.json'), JSON.stringify(summary, null, 2))
  const stage = async (name, fn) => {
    const t0 = Date.now()
    process.stdout.write(`small-host-copyless: ${name}...\n`)
    try {
      summary.stages[name] = { ok: true, ...(await fn()), seconds: Math.round((Date.now() - t0) / 1000) }
    } catch (err) {
      summary.stages[name] = { ok: false, error: err instanceof Error ? err.message : String(err), procs: (() => { try { return hostProcs() } catch { return null } })(), view: (() => { try { return view() } catch { return null } })() }
      save()
      throw err
    }
    process.stdout.write(`small-host-copyless: ${name}: ${JSON.stringify(summary.stages[name]).slice(0, 600)}\n`)
    save()
  }
  try {
    const oldFile = await releasedPlatformFile(opts.old, 'linux-x64', path.join(work, 'old'))
    summary.oldVersion = execFileSync(oldFile, ['--version'], { encoding: 'utf8' }).trim()
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(work, 'key'), '-C', 'small-host-rehearsal'])
    startHost(work, opts)
    startLeaderBox(work)
    const hostIp = ipOf(HOST)
    fs.mkdirSync(path.join(work, 'data'), { recursive: true })
    fs.writeFileSync(path.join(work, 'data', 'config.yaml'), `version: 1\nuser: {}\nhosts:\n  small:\n    hostname: ${hostIp}\n    user: walnut\n    label: Small box\n`)
    let session = ''

    await stage('old', async () => {
      const log = await leaderUp(work, oldFile, 'old')
      await until('the old leader to reach the host', () => hostProcs().some((p) => /daemon/.test(p.args)), 300_000)
      const boot = bootStart()
      // A release from before followers were on by default runs none there ('off'); a later one judges it below the floors.
      const gate = await until('the host to run no follower', () => { const v = view(); return v?.phase === 'not-eligible' || v?.phase === 'off' ? v : null }, 300_000)
      if (hostProcs().some((p) => /walnut web --replica/.test(p.args))) throw new Error('the old leader runs a follower on the small host')
      session = await newSession('Small host, old leader', 'OLD LEADER OK')
      return { log, boot, phase: gate.phase, gate: gate.gate ?? gate.message ?? null, procs: hostProcs() }
    })

    await stage('upgrade', async () => {
      const before = hostProcs().filter((p) => /daemon/.test(p.args)).map((p) => p.args)
      await leaderDown()
      const log = await leaderUp(work, opts.newFile, 'new')
      const boot = await until('the boot start under the launcher', () => { const b = bootStart(); return b?.mode && b.mode !== 'none' ? b : null }, 300_000, 10_000)
      const gate = await until('the host judged below the floors by the new leader', () => { const v = view(); return v?.phase === 'not-eligible' ? v : null }, 300_000)
      await answers(session, 'UPGRADED OK')
      return { log, boot, before, after: hostProcs().map((p) => p.args), gate: gate.gate ?? gate.message, copyless: gate.copyless ?? false }
    })

    await stage('on', async () => {
      experiment(true)
      await until('the host to run the service without a copy', () => { const x = view(); return x?.phase === 'running' && x.copyless === true && x.daemon?.pid ? x : null }, 600_000, 5_000)
      // The switch to the one service restarts it (a daemon update): judged once that is over.
      const v = await until('the one service to settle (no update running, the follower is the service)', () => {
        const procs = hostProcs()
        if (procs.some((p) => /update\.sh|daemon update/.test(p.args))) return null
        const x = view()
        return x?.phase === 'running' && x.copyless === true && procs.some((p) => p.pid === x.daemon?.pid && /--service/.test(p.args)) ? x : null
      }, 300_000, 5_000)
      const env = working(work)?.env ?? {}
      if (env.WALNUT_COPIES !== 'none') throw new Error(`the spec kept for the host has no WALNUT_COPIES=none: ${JSON.stringify(env)}`)
      const procs = hostProcs()
      const service = procs.find((p) => p.pid === v.daemon.pid)
      if (!service || !/--service/.test(service.args)) throw new Error(`the follower ${v.daemon.pid} is not the host's service: ${JSON.stringify(procs)}`)
      if (procs.some((p) => /walnut web --replica/.test(p.args))) throw new Error(`a second program runs beside the service: ${JSON.stringify(procs)}`)
      const bootRss = service.rss
      await answers(session, 'COPYLESS OK')
      const fresh = await newSession('Small host, copyless', 'COPYLESS NEW OK')
      const after = hostProcs().find((p) => p.pid === v.daemon.pid)
      return { servicePid: v.daemon.pid, serviceRssKb: { settled: bootRss, afterSessions: after?.rss ?? null }, fresh, procs: hostProcs() }
    })

    await stage('off', async () => {
      experiment(false)
      const v = await until('the gate back', () => { const x = view(); return x?.phase === 'not-eligible' && !x.copyless ? x : null }, 600_000, 5_000)
      const env = working(work)?.env ?? {}
      await answers(session, 'COPY GATE BACK OK')
      return { gate: v.gate ?? v.message, workingEnv: env, procs: hostProcs() }
    })

    await stage('back', async () => {
      experiment(true)
      await until('the service without a copy again', () => { const x = view(); return x?.phase === 'running' && x.copyless === true ? x : null }, 600_000, 5_000)
      const left = working(work)
      await leaderDown()
      const log = await leaderUp(work, oldFile, 'old-again')
      await answers(session, 'BACK OLD OK')
      const fresh = await newSession('Small host, old leader again', 'BACK NEW OK')
      await sleep(30_000)
      const v = view()
      const kinds = [...new Set(fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('host replica: round') && l.includes('"small"')).map((l) => /"kind":"([a-z_-]+)"/.exec(l)?.[1]).filter(Boolean))]
      return { log, leftWorking: left, nowWorking: working(work), view: v, copyRoundsSent: kinds, fresh, procs: hostProcs() }
    })
    summary.ok = true
  } finally {
    save()
    process.stdout.write(`small-host-copyless: ${summary.ok ? 'passed' : 'FAILED'}; ${path.join(work, 'summary.json')}\n`)
    if (!opts.keep) {
      dockerOk(['exec', LEADER, 'sh', '-c', 'kill -TERM $(cat /work/leader.pid) 2>/dev/null'])
      dockerOk(['rm', '-f', LEADER, HOST])
    }
  }
}

await main().catch((err) => { process.stderr.write(`small-host-copyless: ${err instanceof Error ? err.stack : err}\n`); process.exit(1) })
