import fs from 'node:fs/promises'
import http from 'node:http'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TINY_SILENT_MP4_BASE64 } from '../../../tests/e2e/browser/fixtures/tiny-video.js'

const out = process.argv[2]
if (!out || !path.resolve(out).startsWith('/tmp/phone-media/')) throw new Error('Use a dedicated phone media evidence directory')
await fs.mkdir(out, { recursive: true })
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-media-home-'))
Object.assign(process.env, {
  HOME: home, USERPROFILE: home, OPEN_WALNUT_HOME: home, WALNUT_DAEMON_DIR: path.join(home, 'daemon'),
  WALNUT_STREAMS_DIR: path.join(home, 'streams'), WALNUT_SPAWN_JOURNAL: path.join(home, 'spawn.jsonl'),
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'), WALNUT_LEGACY_STREAMS_DIR: path.join(home, 'legacy-streams'),
  WALNUT_DISABLE_SEARCH: '1', WALNUT_DISABLE_BACKGROUND_AI: '1', WALNUT_LOCAL_CLAUDE_PROBE: '0', WALNUT_ORG_AUTOSTART: '0',
  MOCK_CLAUDE_TRANSCRIPT_DIR: path.join(home, '.claude/projects'), MOCK_CLAUDE_TURN_TRANSCRIPT_DIR: path.join(home, '.claude/projects'),
})
for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name]
process.argv.push('--_ephemeral-child')
const { startServer, stopServer } = await import('../../../src/web/server.js')
const { sessionRunner } = await import('../../../src/providers/claude-code-session.js')
const { createMockDaemon } = await import('../../../tests/helpers/mock-daemon.js')
const { createDevice } = await import('../../../src/core/device-auth.js')
const { updateTask, updateSummary } = await import('../../../src/core/task-manager.js')
const { updateConfig } = await import('../../../src/core/config-manager.js')
await updateConfig({ hooks: { overrides: { 'turn-complete-triage': { enabled: false } } } })
const root = path.join(home, 'media')
await fs.mkdir(root)
const clip = path.join(root, 'walkthrough.mp4')
const large = path.join(root, 'large walkthrough.MP4')
if (process.env.WALNUT_MEDIA_FIXTURE) await fs.copyFile(process.env.WALNUT_MEDIA_FIXTURE, clip)
else await fs.writeFile(clip, Buffer.from(TINY_SILENT_MP4_BASE64, 'base64'))
if (process.env.WALNUT_LARGE_MEDIA_FIXTURE) await fs.copyFile(process.env.WALNUT_LARGE_MEDIA_FIXTURE, large)
else {
  await fs.copyFile(clip, large)
  const free = Buffer.alloc(3 * 1024 * 1024)
  free.writeUInt32BE(free.length, 0)
  free.write('free', 4, 'ascii')
  await fs.appendFile(large, free)
}
const readme = path.join(root, 'readme.txt')
await fs.writeFile(readme, 'File preview regression: line one.\nFile preview regression: line two.\n')
const image = path.join(root, 'fixture-chart.png')
await fs.copyFile(process.env.WALNUT_AGENT_IMAGE_FIXTURE
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../WalnutWidgets/Assets.xcassets/WalnutMark.imageset/WalnutMark.png'), image)
await fs.writeFile(path.join(root, 'report.html'), '<!doctype html><html><body><h1>File preview regression</h1></body></html>')
const missing = path.join(root, 'restored.mp4')
const daemon = await createMockDaemon()
sessionRunner.setCliCommand(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tests/providers/mock-claude.mjs'))
sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
const server = await startServer({ port: 0, dev: true })
const apiPort = (server.address() as { port: number }).port
const token = (await createDevice('media-fixture-phone')).token
// A fenced block, drawn as written: its markdown marks stay characters, its path is a link, and its
// long line scrolls sideways.
const code = { marker: 'Code block marker', wide: 'wide '.repeat(60).trim() }
const fence = (line: number) => '```text\n' + `cat ${readme}:${line} # ${code.marker} \`raw\` *stars* ${code.wide}` + '\n```'
const transcript = `Media fixture ready.\n\n${clip}\n\n${large}\n\n${missing}\n\n${fence(2)}`
const response = await fetch(`http://127.0.0.1:${apiPort}/api/v1/sessions`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ cwd: root, message: 'snapshot-clean-turn:' + transcript, overrideReadiness: true }),
})
const seeded = await response.json() as { sessionId: string; taskId: string }
if (!response.ok || !seeded.sessionId || !seeded.taskId) throw new Error('Could not seed the isolated media session')
await updateTask(seeded.taskId, { title: 'Phone media fixture', pinned: true, focus_tier: 'focus' })
const { sendLetter, agentReply } = await import('../../../src/core/human-inbox/store.js')
const sender = {
  sessionId: seeded.sessionId, host: 'local', taskId: seeded.taskId,
  taskTitle: 'Phone media fixture', sessionTitle: 'Phone media fixture',
}
const subjects = {
  target: 'Agent text target letter',
  source: 'Agent text markdown source',
  html: 'Agent text HTML source',
  oldTurn: 'Agent text old turn',
}
// Sent first, so it is the oldest row and moves no other letter. Its reply carries no sender, as a
// turn from before the server recorded one: the phone must load no image and read no file for it.
const oldTurn = await sendLetter({ subject: subjects.oldTurn, type: 'info', sender, markdown: 'A letter with an old turn.' }, { quiet: true })
await agentReply(oldTurn.id, { text: `Old turn image:\n\n![Old chart](${image})\n\nOld turn file: ${readme}:1` }, { quiet: true })
const target = await sendLetter({
  subject: subjects.target, type: 'info', sender,
  markdown: `# Target letter body marker\n\nThe letter the other two link to.\n\n${fence(1)}`,
}, { quiet: true })
const taskRef = `<task-ref id="${seeded.taskId}" label="Phone media fixture"/>`
const source = await sendLetter({
  subject: subjects.source, type: 'info', sender,
  text: `${readme}:2 then ${target.id}`,
  markdown: [
    '# Source markdown marker',
    '',
    `![Fixture chart](${image})`,
    '',
    `Read ${readme}:2 for the second line.`,
    '',
    `Open the target letter ${target.id} next.`,
    '',
    `Task: ${taskRef}`,
  ].join('\n'),
}, { quiet: true })
// Each agent turn names its writer, as the server stamps it from the caller's session.
await agentReply(source.id, { text: `Plain turn: ${readme}:1, letter ${target.id}, task ${seeded.taskId}` }, { quiet: true, sender })
const html = await sendLetter({
  subject: subjects.html, type: 'info', sender,
  text: 'HTML document with linked references.',
  html: [
    '<base href="https://outside.example/redirected/">',
    '<h1>Inline document marker</h1>',
    `<p>Existing anchor: <a href="${readme}:2">readme.txt line 2</a></p>`,
    `<p>Chart file: ${image}</p>`,
    `<p>Letter: ${target.id}</p>`,
    `<p>Task: <task-ref id="${seeded.taskId}" label="Phone media fixture"></task-ref></p>`,
  ].join('\n'),
}, { quiet: true })
const deferredHtml = [
  '<base href="https://outside.example/redirected/">',
  '<h2>Deferred turn marker</h2>',
  `<p><a href="${readme}:1">turn readme line 1</a></p>`,
  `<p>Turn letter: ${target.id}</p>`,
  `<!-- ${'deferred padding '.repeat(80_000)} -->`,
].join('\n')
if (Buffer.byteLength(deferredHtml) <= 1024 * 1024) throw new Error('The deferred turn must be over the inline body limit')
await agentReply(html.id, { text: 'Deferred document attached.', html: deferredHtml }, { quiet: true, sender })
const letters = { target: target.id, source: source.id, html: html.id, oldTurn: oldTurn.id, subjects }
const summary = `Summary: ${readme}:2 and letter ${target.id}`
// No writer session recorded, as a summary from before the field: the phone must not guess its machine.
await updateSummary(seeded.taskId, summary)
const { getTask } = await import('../../../src/core/task-manager.js')
async function api(method: string, route: string, body: unknown): Promise<unknown> {
  const reply = await fetch(`http://127.0.0.1:${apiPort}/api/v1${route}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  })
  if (!reply.ok) throw new Error(`${method} ${route}: ${reply.status} ${await reply.text()}`)
  return reply.json()
}
async function statusTask(title: string, ask: string, parent?: string, project?: string): Promise<string> {
  const fields = project ? { title, project } : { title, pinned: true, focus_tier: 'focus' }
  const { task } = await api('POST', '/tasks', fields) as { task: { id: string } }
  if (parent) await api('PATCH', `/tasks/${task.id}`, { parent_task_id: parent })
  await api('PUT', `/tasks/${task.id}/report`, { state: 'needs', ask })
  return task.id
}
const statusTasks = {
  boardFile: await statusTask('Board file status', `${readme}:2 is ready for the board check`),
  boardLetter: await statusTask('Board letter status', `${target.id} is ready for the board check`),
  teamFile: await statusTask('Team file status', `${readme}:2 is ready for the team check`, seeded.taskId),
  teamLetter: await statusTask('Team letter status', `${target.id} is ready for the team check`, seeded.taskId),
}
const orgProject = 'Agent Org Fixture'
const orgTasks = {
  file: await statusTask('Org file status', `${readme}:2 is ready for the org check`, undefined, orgProject),
  letter: await statusTask('Org letter status', `${target.id} is ready for the org check`, undefined, orgProject),
}
const contact = await api('POST', '/org/contact', { to: orgProject }) as { task: { id: string }; kind: string }
if (contact.kind !== 'lead') throw new Error(`The org fixture project has no lead: ${contact.kind}`)
const leadStart = await api('POST', '/sessions', {
  cwd: root, taskId: contact.task.id, message: 'snapshot-clean-turn:Org fixture lead ready.', overrideReadiness: true,
}) as { sessionId?: string }
if (!leadStart.sessionId) throw new Error('Could not start the org fixture lead')
const org = { project: orgProject, leadId: contact.task.id, leadSessionId: leadStart.sessionId, ...orgTasks }
for (const id of [...Object.values(statusTasks), ...Object.values(orgTasks)]) {
  const deadline = Date.now() + 30_000
  while ((await getTask(id)).user_status?.state !== 'needs') {
    if (Date.now() > deadline) throw new Error(`Task ${id} never read Needs you`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}
for (const deadline = Date.now() + 30_000; !(await getTask(org.leadId)).session_ids?.length;) {
  if (Date.now() > deadline) throw new Error('The org fixture lead never recorded its session')
  await new Promise(resolve => setTimeout(resolve, 250))
}
// Two threads on the org lead's page, each with a summary and an opening post that name a file:
// one whose writer the server recorded (the lead's session), one with no writer recorded, as a
// card from before the writers were kept. The phone must open the first on its writer's machine
// and ask which machine for the second.
const { openNodeThread, patchThread } = await import('../../../src/core/org/threads-store.js')
const leadWriter = `task:${org.leadId}` as const
const leadSource = { sid: org.leadSessionId, host: '__local__' }
const knownThread = await openNodeThread(org.leadId, {
  title: 'Writer known thread', text: `Opened with ${readme}:1`, from: 'node', state: 'answered',
}, leadWriter, leadSource)
await patchThread(org.leadId, knownThread.id, { reply: `Summary names ${readme}:2` }, leadWriter, leadSource)
const unknownThread = await openNodeThread(org.leadId, {
  title: 'Writer unknown thread', text: `Opened with ${readme}:1`, from: 'node', state: 'answered',
}, 'agent')
await patchThread(org.leadId, unknownThread.id, { reply: `Summary names ${readme}:2` }, 'agent')
Object.assign(org, { threads: { knownId: knownThread.id, unknownId: unknownThread.id } })
// The seeded session's own plan, recorded the way a finished plan turn records it, so the real
// plan route reads it from disk: a file link and a picture the phone must draw as a link.
const planFile = path.join(home, '.claude', 'plans', 'phone-media-fixture.md')
const planMarker = 'Fixture plan marker'
await fs.mkdir(path.dirname(planFile), { recursive: true })
await fs.writeFile(planFile, [
  `# ${planMarker}`,
  '',
  `Step one: read ${readme}:2 for the second line.`,
  '',
  `![Plan chart](${image})`,
  '',
].join('\n'))
const { updateSessionRecord, getSessionByClaudeId } = await import('../../../src/core/session-tracker.js')
const recordPlan = () => updateSessionRecord(seeded.sessionId, { planCompleted: true, planFile })
await recordPlan()
// The seeded session's own first turn can still be closing, and its result handling rewrites
// planCompleted: hold the plan until two reads a second apart see it with the session settled.
// Settled is idle, or stopped: a notice about the fixture's subtasks can reach the mock CLI and
// end its process after the turn (2026-11-11), and a stopped session's turn is over too.
for (let stable = 0, deadline = Date.now() + 30_000; stable < 2;) {
  await new Promise(resolve => setTimeout(resolve, 1000))
  const record = await getSessionByClaudeId(seeded.sessionId)
  const settled = record?.process_status === 'idle' || record?.process_status === 'stopped'
  if (record && settled && record.planCompleted && record.planFile === planFile) stable++
  else { stable = 0; await recordPlan() }
  if (Date.now() > deadline) throw new Error('The seeded plan did not stay recorded')
}
const plan = { file: planFile, marker: planMarker }
// Per-test time marks on the server's monotonic clock. The recording wrapper posts record-start
// once its video runs, so each mark also reads as seconds into that video.
const clockOrigin = performance.now()
const sinceOrigin = (): number => Math.round(performance.now() - clockOrigin)
let recordStartMs: number | null = null
const segments: Array<{ name: string; startMs: number; endMs: number | null; result: string | null }> = []
const segmentName = (raw: string): string =>
  raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, 120)
let segmentsWrite: Promise<void> = Promise.resolve()
function writeSegments(): Promise<void> {
  // One write at a time, each from the state when it runs, so marks posted together never tear the file.
  segmentsWrite = segmentsWrite.catch(() => undefined).then(() => {
    const inVideo = (ms: number | null) => (ms === null || recordStartMs === null ? null : (ms - recordStartMs) / 1000)
    return fs.writeFile(path.join(out, 'segments.json'), JSON.stringify({
      clock: 'monotonic-ms', recordStartMs,
      segments: segments.map(s => ({ ...s, videoStartSec: inVideo(s.startMs), videoEndSec: inVideo(s.endMs) })),
    }, null, 2))
  })
  return segmentsWrite
}
const observed: Array<{ seq: number; path: string; query: string; status: number; bytes: number; wireBytes: number; done: boolean; cancelled: boolean; fault: string }> = []
let observedSeq = 0
const DOCUMENT_PATH = /^\/api\/v1\/human-inbox\/[^/]+\/body$/
const OBSERVED_PATH = /^\/api\/v1\/(?:human-inbox\/[^/]+\/body|media|files\/)/
const requests: Array<{ path: string; raw: boolean; status: number; bytes: number; cancelled: boolean }> = []
let fault: 'off' | 'offline' | 'delay' = 'off'
let documentFault: 'off' | 'offline' | 'delay' = 'off'
const proxy = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://fixture.test')
  if (url.pathname === '/__media/state') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ...seeded, root, clip, large, missing, readme, image, letters, summary, statusTasks, org, plan, code, requests, observed, observedSeq, fault, documentFault })); return
  }
  if (url.pathname === '/__media/record-start' && req.method === 'POST') {
    recordStartMs = sinceOrigin()
    await writeSegments()
    res.end(JSON.stringify({ recordStartMs })); return
  }
  if (url.pathname === '/__media/segment' && req.method === 'POST') {
    const phase = url.searchParams.get('phase')
    const name = segmentName(url.searchParams.get('name') ?? '')
    const result = url.searchParams.get('result')
    if ((phase !== 'start' && phase !== 'end') || !name) { res.statusCode = 400; res.end(); return }
    const at = sinceOrigin()
    if (phase === 'start') segments.push({ name, startMs: at, endMs: null, result: null })
    else {
      const open = [...segments].reverse().find(s => s.name === name && s.endMs === null)
      if (!open) { res.statusCode = 409; res.end(); return }
      open.endMs = at
      open.result = result === 'passed' || result === 'failed' ? result : null
    }
    await writeSegments()
    res.end(JSON.stringify({ name, at })); return
  }
  if (url.pathname === '/__media/shot' && req.method === 'POST') {
    const name = url.searchParams.get('name') ?? ''
    if (!/^[a-z0-9-]+$/.test(name)) { res.statusCode = 400; res.end(); return }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    await fs.writeFile(path.join(out, name + '.png'), Buffer.concat(chunks))
    res.end('{}'); return
  }
  if (url.pathname === '/__media/fault' && req.method === 'POST') {
    const next = url.searchParams.get('mode')
    if (next !== 'off' && next !== 'offline' && next !== 'delay') { res.statusCode = 400; res.end(); return }
    fault = next; res.end('{}'); return
  }
  if (url.pathname === '/__media/document-fault' && req.method === 'POST') {
    const next = url.searchParams.get('mode')
    if (next !== 'off' && next !== 'offline' && next !== 'delay') { res.statusCode = 400; res.end(); return }
    documentFault = next; res.end('{}'); return
  }
  if (url.pathname === '/__media/restore' && req.method === 'POST') {
    await fs.copyFile(clip, missing); res.end('{}'); return
  }
  if (url.pathname === '/__media/remove' && req.method === 'POST') {
    await fs.rm(missing, { force: true }); res.end('{}'); return
  }
  const isFile = url.pathname === '/api/v1/file-content'
  const entry = { path: url.searchParams.get('path') ?? '', raw: url.searchParams.get('raw') === '1', status: 0, bytes: 0, cancelled: false }
  if (isFile) {
    requests.push(entry)
    res.on('close', () => { entry.cancelled = !res.writableFinished })
    if (fault === 'offline') {
      entry.status = 503; res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'bridge_offline', message: 'Fixture host is offline' } })); return
    }
    if (fault === 'delay') {
      await new Promise(resolve => setTimeout(resolve, 15_000))
      if (res.destroyed) return
    }
  }
  const seen = OBSERVED_PATH.test(url.pathname)
    ? { seq: ++observedSeq, path: url.pathname, query: url.search, status: 0, bytes: 0, wireBytes: 0, done: false, cancelled: false, fault: 'off' }
    : null
  if (seen) {
    observed.push(seen)
    if (observed.length > 400) observed.shift()
    res.on('close', () => { seen.cancelled = !res.writableFinished })
  }
  if (seen && DOCUMENT_PATH.test(url.pathname) && documentFault !== 'off') {
    seen.fault = documentFault
    if (documentFault === 'offline') {
      seen.status = 503; res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'bridge_offline', message: 'Fixture host is offline' } }))
      seen.done = true; return
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 15_000)
      res.once('close', () => { clearTimeout(timer); resolve() })
    })
    if (res.destroyed || res.writableEnded) return
  }
  const upstream = http.request({ hostname: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers: req.headers }, reply => {
    entry.status = reply.statusCode ?? 0
    if (seen) seen.status = reply.statusCode ?? 0
    res.writeHead(reply.statusCode ?? 502, reply.headers)
    const encoding = reply.headers['content-encoding']
    const decoded = seen && DOCUMENT_PATH.test(url.pathname)
      ? encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : encoding === 'deflate' ? createInflate() : null
      : null
    reply.on('data', chunk => {
      entry.bytes += chunk.length
      if (seen) {
        seen.wireBytes += chunk.length
        if (!decoded) seen.bytes += chunk.length
      }
    })
    if (decoded) {
      decoded.on('data', chunk => { seen!.bytes += chunk.length })
      decoded.on('end', () => { seen!.done = true })
      decoded.on('error', () => { seen!.cancelled = true })
      reply.pipe(decoded)
      res.once('close', () => { if (!res.writableFinished) decoded.destroy() })
    } else reply.on('end', () => { if (seen) seen.done = true })
    reply.pipe(res)
  })
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
})
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
const port = (proxy.address() as { port: number }).port
await fs.writeFile(path.join(out, 'ready.json'), JSON.stringify({ server: `http://127.0.0.1:${port}`, token, home, ...seeded, clip, large, missing, readme, image, letters, statusTasks, org, plan, code }))
await writeSegments()
let closing = false
async function close() {
  if (closing) return
  closing = true
  await fs.writeFile(path.join(out, 'requests.json'), JSON.stringify(requests, null, 2))
  await writeSegments()
  proxy.closeAllConnections(); proxy.close()
  await stopServer(); await daemon.stop(); process.exit(0)
}
process.on('SIGTERM', () => { void close() })
process.on('SIGINT', () => { void close() })
setTimeout(() => { void close() }, 90 * 60_000).unref()
