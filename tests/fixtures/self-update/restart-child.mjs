// A stand-in for a restarted `walnut web` (tests/core/self-update/restart-supervisor.test.ts).
// It logs what it was started with, then: a supervised child asks for one restart
// (exit 75) on its first run; an unsupervised one never hands that code to its parent.
import fs from 'node:fs'

const log = process.env.RESTART_CHILD_LOG
const runs = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0
fs.appendFileSync(log, `${JSON.stringify({
  supervised: process.env.WALNUT_RESTART_SUPERVISED ?? null,
  applied: process.env.WALNUT_UPDATE_APPLIED ?? null,
})}\n`)
// It "listens": the ready file its parent named (reexecSelf) says so.
if (process.env.WALNUT_STARTUP_READY_FILE) fs.writeFileSync(process.env.WALNUT_STARTUP_READY_FILE, `${process.pid}\n`)
process.exit(runs === 0 && process.env.WALNUT_RESTART_SUPERVISED === '1' ? 75 : 0)
