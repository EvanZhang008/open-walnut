#!/usr/bin/env node
// Summarize a CPU profile kept by the stall flight recorder (src/core/stall-recorder.ts).
//
//   node scripts/stall-profile-summary.mjs <file.cpuprofile | dir> [--top N] [--all]
//
// With a directory, the newest profile in it is used (default dir:
// $WALNUT_DAEMON_DIR/stall-profiles, else /tmp/open-walnut/stall-profiles).
// The sibling .json (written with the profile) names each stall's hold window;
// the summary covers only the samples inside the holds unless --all is given.
// Time is weighted by each sample's real duration, so a starved sampler that
// took few samples still adds up to the hold's wall time. Samples are taken on
// a wall clock: a loop thread that was not running (descheduled under machine
// load, or blocked) is still sampled where it stopped, so for an off-cpu or
// starved hold the stacks show where the thread was parked, not CPU it spent.
// The flight record's thread CPU says which case it is; the summary flags it.
// Prints: the flight record per stall, the busy share by category, the top
// self-time functions with file:line, the top inclusive frames, and the
// heaviest stacks.
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const top = Number(opt('--top', 20))
let target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--top')
  ?? path.join(process.env.WALNUT_DAEMON_DIR || '/tmp/open-walnut', 'stall-profiles')

if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
  const files = fs.readdirSync(target).filter((f) => f.endsWith('.cpuprofile'))
    .map((f) => ({ f: path.join(target, f), m: fs.statSync(path.join(target, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  if (files.length === 0) { console.error(`no .cpuprofile in ${target}`); process.exit(1) }
  target = files[0].f
}
const profile = JSON.parse(fs.readFileSync(target, 'utf8'))
const metaPath = target.replace(/\.cpuprofile$/, '.json')
const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : null

const byId = new Map()
for (const n of profile.nodes) byId.set(n.id, n)
const parent = new Map()
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)

// Sample i covers [t_i, t_{i+1}); the last one runs to endTime.
const n = profile.samples.length
const ts = new Float64Array(n)
let t = profile.startTime
for (let i = 0; i < n; i++) { t += profile.timeDeltas[i]; ts[i] = t }
const dur = (i) => (i + 1 < n ? ts[i + 1] : profile.endTime) - ts[i]

const windows = []
if (meta && !flag('--all')) {
  for (const s of meta.stalls) {
    windows.push({ from: s.holdStartMono * 1000 + meta.offsetUs, to: s.holdEndMono * 1000 + meta.offsetUs, stall: s })
  }
}
if (windows.length === 0) windows.push({ from: profile.startTime, to: profile.endTime, stall: null })

const label = (cf) => {
  const name = cf.functionName || '(anonymous)'
  if (!cf.url) return name
  const file = cf.url.replace(/^file:\/\//, '')
  return `${name} ${file}:${cf.lineNumber + 1}:${cf.columnNumber + 1}`
}
const category = (cf) => {
  if (cf.functionName === '(idle)') return 'idle'
  if (cf.functionName === '(garbage collector)') return 'gc'
  if (cf.functionName === '(program)') return 'program (native, outside JS)'
  return 'js'
}
const ms = (us) => (us / 1000).toFixed(1)

console.log(`profile: ${target}`)
console.log(`window: ${ms(profile.endTime - profile.startTime)} ms, ${n} samples${meta ? `, interval ${meta.intervalUs} us, node ${meta.node}` : ''}`)

for (const w of windows) {
  console.log('\n' + '='.repeat(100))
  if (w.stall) {
    const s = w.stall
    console.log(`stall at ${s.at}: lateBy ${s.lateByMs} ms, suspectSection ${s.suspectSection ?? 'none'}`)
    if (s.hold) {
      const h = s.hold
      console.log(`  verdict ${h.verdict}: loop thread cpu ${h.mainCpuMs} ms (sys ${h.mainSysMs}) of a ${h.windowMs} ms window; process cpu ${h.procCpuMs} ms`)
      console.log(`  faults major ${h.majorFaults} minor ${h.minorFaults}; ctx switches invol ${h.invCtxSwitches} vol ${h.volCtxSwitches}; gc ${h.gcMs} ms in ${h.gcCount} (max ${h.gcMaxMs}, major ${h.gcMajor})`)
      console.log(`  memory rss ${h.rssMb} MB heap ${h.heapUsedMb}/${h.heapTotalMb} MB external ${h.externalMb} MB; load1 ${h.load1} on ${h.cores} cores; free ${h.freeMemMb} MB`)
      if (s.profileHold) {
        const top = (s.profileHold.top ?? []).map((t) => `${t.frame} ${Math.round(t.share * 100)}%`).join('; ')
        console.log(`  profile in the hold: code ${Math.round(s.profileHold.codeShare * 100)}%, idle ${Math.round(s.profileHold.idleShare * 100)}%, gc ${Math.round(s.profileHold.gcShare * 100)}% of ${s.profileHold.samples} samples; top ${top || 'none'}`)
      }
      if (h.verdict === 'cpu' && h.loadStretched) {
        console.log(`  NOTE: the loop thread ran ${h.mainCpuMs} ms of ${h.windowMs} ms, so the machine was short of CPU too,`)
        console.log('  but code was on the thread for the hold: the stacks below held the loop, and load made it longer.')
      } else if (typeof h.mainCpuMs === 'number' && typeof h.windowMs === 'number' && h.mainCpuMs < 0.3 * h.windowMs) {
        console.log(`  NOTE: the loop thread ran only ${h.mainCpuMs} ms of ${h.windowMs} ms. Samples are wall-clock, so the`)
        console.log('  stacks below are what it was doing when it lost the CPU, weighted by how long it stayed off,')
        console.log('  not CPU it spent. Read the verdict and the machine (load, memory) before blaming the top function.')
      }
    }
  } else {
    console.log('whole profile')
  }
  const self = new Map()
  const total = new Map()
  const stacks = new Map()
  const cats = new Map()
  let sum = 0
  // Longest run of consecutive non-idle samples: the block itself.
  let runStart = -1, bestFrom = 0, bestTo = 0
  for (let i = 0; i < n; i++) {
    if (ts[i] < w.from || ts[i] >= w.to) continue
    const d = dur(i)
    const node = byId.get(profile.samples[i])
    const cf = node.callFrame
    const cat = category(cf)
    cats.set(cat, (cats.get(cat) ?? 0) + d)
    sum += d
    if (cat === 'idle') { runStart = -1; continue }
    if (runStart < 0) runStart = ts[i]
    if (ts[i] + d - runStart > bestTo - bestFrom) { bestFrom = runStart; bestTo = ts[i] + d }
    const key = label(cf)
    self.set(key, (self.get(key) ?? 0) + d)
    const seen = new Set()
    const chain = []
    for (let id = node.id; id !== undefined; id = parent.get(id)) {
      const c = byId.get(id).callFrame
      if (c.functionName === '(root)') break
      const k = label(c)
      chain.push(k)
      if (seen.has(k)) continue
      seen.add(k)
      total.set(k, (total.get(k) ?? 0) + d)
    }
    const sk = chain.slice(0, 14).join('\n      <- ')
    stacks.set(sk, (stacks.get(sk) ?? 0) + d)
  }
  console.log(`samples in window: ${ms(sum)} ms; longest non-idle run ${ms(bestTo - bestFrom)} ms`)
  console.log('busy share:')
  for (const [k, v] of [...cats].sort((a, b) => b[1] - a[1])) console.log(`  ${ms(v).padStart(10)} ms  ${(100 * v / sum).toFixed(1).padStart(5)}%  ${k}`)
  const busy = sum - (cats.get('idle') ?? 0)
  console.log(`\ntop self time (of ${ms(busy)} ms busy):`)
  for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`  ${ms(v).padStart(10)} ms  ${(100 * v / busy).toFixed(1).padStart(5)}%  ${k}`)
  console.log('\ntop inclusive time:')
  for (const [k, v] of [...total].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`  ${ms(v).padStart(10)} ms  ${(100 * v / busy).toFixed(1).padStart(5)}%  ${k}`)
  console.log('\nheaviest stacks (leaf first):')
  for (const [k, v] of [...stacks].sort((a, b) => b[1] - a[1]).slice(0, Math.min(8, top))) console.log(`  ${ms(v)} ms\n      ${k}\n`)
}
