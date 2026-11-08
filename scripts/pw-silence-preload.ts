/**
 * Writes tests/e2e/browser/pw-silence-preload.cjs from src/providers/pw-silence-core.ts, the
 * copy the Mac queue's WebKit runners read from the Mac's main. Usage: bun scripts/pw-silence-preload.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { pwSilencePreloadSource } from '../src/providers/pw-silence-core.js'

const out = path.join(import.meta.dirname, '..', 'tests', 'e2e', 'browser', 'pw-silence-preload.cjs')
fs.writeFileSync(out, pwSilencePreloadSource())
console.log(`wrote ${path.relative(process.cwd(), out)}`)
