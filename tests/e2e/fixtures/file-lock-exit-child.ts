/**
 * A process that exits while it holds a withFileLock lock.
 *
 * argv: <file> <mode>
 *   held        exit inside fn, the pid file naming this process
 *   empty-pid   exit inside fn after emptying the pid file: the on-disk state of
 *               a process that dies between the lock's mkdir and its pid write
 *   taken-over  exit inside fn after the pid file was rewritten to name another
 *               process, OTHER_PID (the lock is no longer this one's)
 *   released    exit after fn returned normally
 *
 * Prints `held` once inside fn, then exits 0. Never signals anything.
 */
import fs from 'node:fs'
import path from 'node:path'
import { withFileLock } from '../../../src/utils/file-lock.js'

const [file, mode] = process.argv.slice(2)
const pidFile = path.join(`${file}.lock`, 'pid')

async function main(): Promise<void> {
  await withFileLock(file, async () => {
    process.stdout.write('held\n')
    if (mode === 'empty-pid') fs.writeFileSync(pidFile, '')
    if (mode === 'taken-over') fs.writeFileSync(pidFile, String(process.env.OTHER_PID))
    if (mode !== 'released') process.exit(0)
  })
  process.exit(0)
}

void main()
