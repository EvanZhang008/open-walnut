/**
 * One locker process for tests/utils/file-lock-multiprocess.test.ts.
 *
 * argv: <async|sync> <store> <workers> <iterations> <startFile>
 * Prints `ready`, waits for <startFile> to exist, then runs <workers> lockers (one for sync),
 * each doing <iterations> locked read-modify-writes of a counter in <store>. Inside the lock it
 * creates `<store>.inside` exclusively: failing to means another holder is inside too. Prints
 * one JSON line: { overlaps, done, errors }.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { withFileLock, withFileLockSync } from '../../../src/utils/file-lock.js';

const [mode, store, workersArg, iterationsArg, startFile] = process.argv.slice(2);
const workers = mode === 'sync' ? 1 : Number(workersArg);
const iterations = Number(iterationsArg);
const inside = `${store}.inside`;
let overlaps = 0;
let done = 0;
const errors: string[] = [];

function enter(): boolean {
  try {
    fs.writeFileSync(inside, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    overlaps++;
    return false;
  }
}

function tmpName(): string {
  return `${store}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
}

process.stdout.write('ready\n');
while (!fs.existsSync(startFile)) await new Promise((resolve) => setTimeout(resolve, 2));

if (mode === 'sync') {
  for (let i = 0; i < iterations; i++) {
    try {
      withFileLockSync(store, () => {
        const mine = enter();
        const n = Number(fs.readFileSync(store, 'utf-8'));
        const tmp = tmpName();
        fs.writeFileSync(tmp, String(n + 1));
        fs.renameSync(tmp, store);
        if (mine) fs.unlinkSync(inside);
      });
      done++;
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
} else {
  await Promise.all(Array.from({ length: workers }, async () => {
    for (let i = 0; i < iterations; i++) {
      try {
        await withFileLock(store, async () => {
          const mine = enter();
          const n = Number(await fsp.readFile(store, 'utf-8'));
          const tmp = tmpName();
          await fsp.writeFile(tmp, String(n + 1));
          await fsp.rename(tmp, store);
          if (mine) fs.unlinkSync(inside);
        });
        done++;
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
  }));
}

process.stdout.write(`${JSON.stringify({ overlaps, done, errors: errors.slice(0, 3) })}\n`);
